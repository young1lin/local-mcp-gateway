import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import type { Adapter } from "./types.js";
import { treeKill } from "../process-tree.js";
import { noteProcPid, dropProcPid } from "../proc-pids.js";
import { makeProxyServer, type ProxyOpts } from "./proxy.js";
import { loginPath } from "../pathenv.js";

/** Cap on retained child stderr. Enough to diagnose a failed launch, small enough to ignore. */
const STDERR_MAX = 64 * 1024;

/** Deadline for the stdio initialize handshake. Generous — an npx/uvx cold start (a first download)
 *  can take tens of seconds — but finite, so a child that spawns yet never speaks MCP fails the start
 *  instead of wedging the MCP in "starting" forever. Override with PROC_HANDSHAKE_TIMEOUT_MS. */
const HANDSHAKE_TIMEOUT_MS = Number(process.env.PROC_HANDSHAKE_TIMEOUT_MS) || 60_000;

/** Deadline for one proxied tool call. The SDK's own default is 60s, which is under what a child
 *  doing real work needs: vision/inference calls routinely run 20-50s and a large screenshot runs
 *  past the minute, so that invisible default failed them after the model had already been billed
 *  for the work. Finite, so a wedged child still fails the call instead of pinning the request
 *  forever. Override globally with PROC_CALL_TIMEOUT_MS, or per-MCP with `"timeoutMs"` in config. */
export const PROC_CALL_TIMEOUT_MS = Number(process.env.PROC_CALL_TIMEOUT_MS) || 180_000;

export interface ProcOpts {
  /** Registry name of this MCP — the key its call log is filed under. */
  name?: string;
  /** Arbitrary launch command, e.g. `npx -y @pkg ...`, `uvx mcp-...`, `node script.js`. */
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  /** What this MCP is for, from the config. Surfaced to clients as MCP `instructions`. Unlike the
   *  direct adapters we do not rewrite the child's own tool descriptions — they belong to the child. */
  description?: string;
  /** Expose the child's resources (default true). Set false to hide noisy resources (e.g. a DB's
   *  thousands of table-schema resources) so MCP clients don't flood context with them. */
  exposeResources?: boolean;
  /** Expose the child's prompts (default true). */
  exposePrompts?: boolean;
  /** Deadline for one tool call, in ms. Defaults to PROC_CALL_TIMEOUT_MS. Raise it for a child that
   *  does slow work (image analysis, long scrapes); lower it for one that should always be quick. */
  timeoutMs?: number;
}

/**
 * Split a command string into argv, honoring single/double quotes. On Windows a
 * backslash is a path separator, NOT an escape — so backslashes are kept literal
 * and the only recognized escape inside double quotes is `\"` (embedded quote).
 */
export function tokenizeCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // Inside double quotes, only \" and \\ are escapes; everything else (incl. \a) is literal.
      if (c === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        cur += s[i + 1];
        i++;
        continue;
      }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c as '"' | "'"; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Decode a child-process stderr/stdout chunk. Valid UTF-8 is kept (npx, Python, most MCP
 * servers). Bytes that are not UTF-8 — typical of cmd.exe on a Chinese Windows, CP936/GBK —
 * are decoded as GBK so the panel shows 「不是内部或外部命令」 instead of mojibake. ASCII-only
 * English cmd errors are valid UTF-8 and take the first branch.
 */
export function decodeChildOutput(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

/**
 * Hosts an arbitrary stdio MCP server (spawned via npx/uvx/python/...) by spawning it once
 * and proxying every MCP request to it over stdio. One shared child per MCP.
 */
export class ProcAdapter implements Adapter {
  readonly type = "proc";
  private client?: Client;
  private server?: Server;
  /** Ring buffer of child stderr, bounded by BYTES. Bounding by chunk count (the previous 1000-entry
   *  cap) let a chatty child hold megabytes resident and dump all of it into every /details response. */
  private stderrBuf = "";
  /** PID of the spawned child (the npx/cmd wrapper), captured so close() can tree-kill it. */
  private childPid?: number;
  /** The spawned child itself, reached through the transport the same way its stderr is. Used only
   *  to tell "already exited" from "still running": `taskkill /T /F` on the PID of a process that
   *  has since exited would tear down whatever Windows has reused the number for. Optional on
   *  purpose — if a future SDK renames the field, close() falls back to killing by PID as before. */
  private child?: { exitCode: number | null; signalCode: string | null };

  constructor(private opts: ProcOpts) {}

  async build(): Promise<Server> {
    const [cmd, ...args] = tokenizeCommand(this.opts.command);
    if (!cmd) throw new Error("empty command");
    // Inherit the full environment so npx/uvx/python behave as if launched from
    // the user's shell (the SDK's sanitized default omits PATHEXT/APPDATA/...).
    // Then put ~/.local/bin (uv/uvx) and %APPDATA%\npm back on PATH — a detached
    // `lmg start` often inherits a PATH that is missing those user-level bins.
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: loginPath(), ...this.opts.env };
    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      cwd: this.opts.cwd,
      stderr: "pipe",
    } as ConstructorParameters<typeof StdioClientTransport>[0]);
    // Capture child stderr for the logs view.
    const stderr = (transport as unknown as { stderr?: { on?(e: string, cb: (d: Buffer) => void): void } }).stderr;
    stderr?.on?.("data", (d: Buffer | string) => {
      this.stderrBuf += typeof d === "string" ? d : decodeChildOutput(d);
      if (this.stderrBuf.length > STDERR_MAX) this.stderrBuf = this.stderrBuf.slice(-STDERR_MAX);
    });
    this.client = new Client({ name: "mcp-gateway", version: "1.0" }, { capabilities: {} });
    try {
      await this.handshake(transport); // spawns the child + runs the initialize handshake (with a deadline)
    } catch (err) {
      // The child spawned during connect() but the handshake failed or timed out. The SDK only
      // abort()s its direct child; on Windows that does NOT cascade to the grandchild server, so
      // tree-kill the whole subtree before rethrowing — otherwise every failed launch orphans a
      // process (the exact orphan close()'s tree-kill exists to prevent, just on the failure path).
      const pid = transport.pid;
      if (pid) { try { await treeKill(pid); } catch { /* already exited */ } }
      try { await this.client.close(); } catch { /* never fully connected */ }
      this.client = undefined;
      throw err;
    }
    this.childPid = transport.pid ?? undefined; // remember for tree-kill on close()
    this.child = (transport as unknown as { _process?: { exitCode: number | null; signalCode: string | null } })._process;
    if (this.childPid) noteProcPid(this.childPid); // ledger it, so a future boot can reap this child if we die hard
    this.server = makeProxyServer(this.client, this.proxyOpts());
    return this.server;
  }

  /** connect() under a deadline: a spawned-but-silent child must fail the start (and be cleaned up by
   *  build()'s catch) rather than hang the MCP in "starting" forever. The AbortSignal lets the SDK
   *  reject the in-flight connect on timeout instead of leaving it pending. */
  private async handshake(transport: StdioClientTransport): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      await this.client!.connect(transport, { signal: ac.signal });
    } catch (err) {
      if (ac.signal.aborted) throw new Error(`proc handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /** Fresh proxy Server for one HTTP request (see Adapter.makeServer). Wraps the shared child
   *  client, which multiplexes concurrent requests by JSON-RPC id. */
  makeServer(): Server {
    if (!this.client) throw new Error("not started");
    return makeProxyServer(this.client, this.proxyOpts());
  }

  /** The proxy settings for this child, in one place: build() and makeServer() must agree, and a
   *  field added to one copy but not the other silently changes behavior after the first request. */
  private proxyOpts(): ProxyOpts {
    return {
      name: this.opts.name,
      exposeResources: this.opts.exposeResources,
      exposePrompts: this.opts.exposePrompts,
      description: this.opts.description,
      callTimeoutMs: this.opts.timeoutMs ?? PROC_CALL_TIMEOUT_MS,
    };
  }

  logs(): string {
    return this.stderrBuf;
  }

  rename(name: string): void {
    this.opts.name = name;
  }

  /** PID of the spawned child, so the memory view can measure this subtree (see src/mem.ts). */
  pids(): number[] {
    return this.childPid ? [this.childPid] : [];
  }

  /** Whether the child has already exited on its own — undefined when that cannot be determined
   *  (no child, or an SDK that no longer exposes one). close() reads this before tree-killing. */
  childExited(): boolean | undefined {
    if (!this.child) return undefined;
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async ping(): Promise<void> {
    if (!this.client) throw new Error("not started");
    await this.client.ping(); // throws if the child died
  }

  async close(): Promise<void> {
    // Tree-kill the child BEFORE releasing the SDK handle. The SDK's StdioClientTransport.close()
    // only abort()s its direct child (the npx/cmd wrapper); on Windows killing a parent does NOT
    // cascade to children, so the grandchild server would survive as an orphan. taskkill /T tears
    // down the whole subtree (cmd.exe -> npx -> real server) regardless of spawn depth.
    const pid = this.childPid;
    if (pid) dropProcPid(pid); // closed cleanly -> no longer a candidate for orphan reaping on next boot
    // Skip the kill when the child is known to have exited already: its PID is free for Windows to
    // hand to something else, and /T /F would take that process and its whole subtree down with it.
    const exited = this.childExited() === true;
    this.childPid = undefined;
    this.child = undefined;
    if (pid && !exited) { try { await treeKill(pid); } catch { /* already exited */ } }
    try { await this.client?.close(); } catch { /* ignore */ }
    this.client = undefined;
    this.server = undefined;
  }
}
