import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataDir, dataPath } from "./datadir.js";
import { logFilePath, pidAlive, readPidFile, removePidFile, writePidFile } from "./pidfile.js";
import { treeKill } from "./process-tree.js";
import { DEFAULT_PORT, asListenPort, envListenPort } from "./port.js";

/**
 * Start, stop and inspect the gateway as a background process.
 *
 * The gateway is a long-lived local server, so the CLI's job is to detach one and then be able to
 * find it again from any directory later. Nothing here imports the gateway itself — a `status` call
 * must not load ioredis/mysql2/mongodb just to print a line — so it talks to a running instance the
 * same way any other client does: over loopback HTTP.
 */

/** Measured worth ~15MB of RSS on this workload. `lmg start` applies them so a user who never heard
 *  of NODE_OPTIONS still gets the tuned process. Passed as argv rather than through NODE_OPTIONS so
 *  they cannot collide with a value the user already set. */
const V8_FLAGS = ["--max-semi-space-size=2", "--max-old-space-size=256"];
const POLL_MS = 150;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_TAIL_BYTES = 4000;

export interface StartOptions {
  port?: number;
  /** Server entry to run. Defaults to the gateway next to this module; injected by tests. */
  entry?: string;
  args?: string[];
  node?: string;
  /** How long to wait for the daemon to answer /health before calling the start failed. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface StopOptions {
  port?: number;
  /** How long to let a graceful shutdown finish before force-killing the tree. */
  gracePeriodMs?: number;
  timeoutMs?: number;
  /** Kill a live pid even when we cannot confirm it is still our gateway. */
  force?: boolean;
  fetchFn?: typeof fetch;
}

export type StartResult =
  | { status: "started"; pid: number; port: number; url: string }
  | { status: "already-running"; pid: number; port: number; url: string }
  | { status: "failed"; port: number; logTail: string };

export type StopResult =
  | { status: "stopped"; pid: number; port: number }
  | { status: "forced"; pid: number; port: number }
  | { status: "not-running"; port: number }
  | { status: "refused"; pid: number; port: number; reason: string };

export interface StatusResult {
  running: boolean;
  port: number;
  pid?: number;
  entry?: string;
  startedAt?: string;
  uptimeMs?: number;
  url?: string;
  logFile: string;
  health?: { ok?: boolean; paths?: string[]; health?: unknown[] };
  memory?: { gatewayMb?: number; childrenMb?: number; processCount?: number };
}

export function urlFor(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/**
 * The port to act on when none was given. Env (`MCP_GATEWAY_PORT`) wins, then the config file,
 * then 19999. Read straight out of the file rather than through loadConfig(), because every command
 * here must work even when the config is invalid — `lmg stop` on a gateway whose config you just
 * broke is exactly when you need it most.
 */
export function resolvePort(): number {
  return envListenPort() ?? asListenPort(readConfigRaw()?.port) ?? DEFAULT_PORT;
}

/**
 * Write `port` into gateway.config.json so the next `lmg start` (and the child about to spawn)
 * listens there. No-op when there is no config yet — first-run seed reads `MCP_GATEWAY_PORT`.
 */
export function persistListenPort(port: number): void {
  const path = dataPath("gateway.config.json");
  if (!existsSync(path)) return;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    raw = parsed as Record<string, unknown>;
  } catch {
    return; // a broken file is not ours to rewrite
  }
  if (raw.port === port) return;
  raw.port = port;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

function readConfigRaw(): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(dataPath("gateway.config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gateway entry to spawn: `index.js` beside this module once built. Falls back to `index.ts` so
 * the CLI also works when run from source under tsx, where no `.js` sibling exists.
 */
export function serverEntry(): string {
  const js = fileURLToPath(new URL("./index.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = fileURLToPath(new URL("./index.ts", import.meta.url));
  return existsSync(ts) ? ts : js;
}

/** True for a path inside npm's npx cache, which is version-keyed and cleared on update — a daemon
 *  started from there stops being restartable the moment the cache turns over. */
export function isNpxCachePath(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path);
}

/** The token a client needs for the authenticated endpoints. Precedence mirrors index.ts: a
 *  rotation persisted in managed.json wins over the .env seed. Read as data, not through the
 *  managed store, to keep the CLI free of the server's module graph. */
function readEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const re = new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`);
    for (const line of readFileSync(dataPath(".env"), "utf8").split(/\r?\n/)) {
      const m = re.exec(line);
      if (m) return m[1].trim();
    }
  } catch {
    /* no .env */
  }
  return undefined;
}

export function readGatewayToken(): string | undefined {
  try {
    const m = JSON.parse(readFileSync(dataPath("managed.json"), "utf8"));
    if (typeof m?.token === "string" && m.token) return m.token;
  } catch {
    /* no managed.json yet */
  }
  const name = typeof readConfigRaw()?.tokenEnv === "string" ? String(readConfigRaw()!.tokenEnv) : "MCP_GATEWAY_TOKEN";
  return readEnvKey(name);
}

/** Panel login + bearer token, for `lmg creds`. Never dumps the rest of .env (DB passwords live there). */
export function readCreds(): { url: string; user: string; pass: string; token?: string } {
  const token = readGatewayToken();
  return {
    url: urlFor(resolvePort()),
    user: readEnvKey("GATEWAY_USER") || "admin",
    pass: readEnvKey("GATEWAY_PASS") || "admin",
    ...(token ? { token } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function healthOk(port: number, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`);
    return !!res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll /health until it answers. `stop` lets the caller abandon early — a daemon that has already
 * exited is never going to answer, and waiting out the full timeout for it wastes the operator's
 * time when what they need is the log.
 */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
  stop?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await healthOk(port, fetchFn)) return true;
    if (stop?.()) return false;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Poll until /health stops answering — i.e. the listener is really gone, not just asked to go. */
async function waitForPortClosed(port: number, timeoutMs: number, fetchFn: typeof fetch): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await healthOk(port, fetchFn))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Keep one previous log rather than growing without bound; rotation at start is enough for a file
 *  only this process appends to. */
function rotateIfBig(path: string): void {
  try {
    if (statSync(path).size < LOG_MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    /* no log yet, or a rename we can live without */
  }
}

function tailLog(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text;
  } catch {
    return "";
  }
}

/**
 * Detach a gateway and wait until it actually serves.
 *
 * The four spawn options are each load-bearing on Windows: `detached` gives the child its own
 * console so closing the terminal's console does not signal it, `windowsHide` keeps that console
 * invisible, routing stdio to a file means no inherited terminal handles (and gives `lmg logs`
 * something to read), and `unref` lets this process exit while the daemon keeps running.
 */
export async function startDaemon(opts: StartOptions = {}): Promise<StartResult> {
  if (opts.port !== undefined) persistListenPort(opts.port);
  const port = opts.port ?? resolvePort();
  const entry = opts.entry ?? serverEntry();
  const node = opts.node ?? process.execPath;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;

  const existing = readPidFile(port);
  if (existing && pidAlive(existing.pid) && (await healthOk(port, fetchFn))) {
    return { status: "already-running", pid: existing.pid, port, url: urlFor(port) };
  }
  // A pid file whose process is gone (or whose port answers nothing) is a leftover from an unclean
  // kill. Believing it would refuse every future start.
  if (existing) removePidFile(port);

  mkdirSync(dataDir(), { recursive: true });
  const log = logFilePath(port);
  rotateIfBig(log);
  const out = openSync(log, "a");
  let child;
  try {
    child = spawn(node, [...V8_FLAGS, entry, ...(opts.args ?? [])], {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      // So the child listens where we asked, including a first run that has no config to persist into.
      env: opts.port !== undefined ? { ...process.env, MCP_GATEWAY_PORT: String(opts.port) } : undefined,
    });
  } finally {
    closeSync(out); // the child holds its own duplicate of the handle
  }
  child.unref();

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });

  if (!child.pid) return { status: "failed", port, logTail: tailLog(log) };
  writePidFile({ pid: child.pid, port, entry, node, startedAt: new Date().toISOString() });

  if (await waitForHealth(port, timeoutMs, fetchFn, () => exited)) {
    return { status: "started", pid: child.pid, port, url: urlFor(port) };
  }
  // Never leave a pid file for something that never came up: the next start would report
  // already-running and the operator would have nothing to act on.
  removePidFile(port);
  return { status: "failed", port, logTail: tailLog(log) };
}

/** Ask the gateway to shut itself down. Failure is fine — the caller falls back to a tree-kill. */
async function postShutdown(port: number, fetchFn: typeof fetch): Promise<void> {
  const token = readGatewayToken();
  try {
    await fetchFn(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch {
    /* it may well have closed the socket as it exited — that is a success, not an error */
  }
}

/**
 * Stop the daemon, preferring the graceful path.
 *
 * Windows has no deliverable SIGTERM (`process.kill` there terminates unconditionally), so asking
 * the gateway over HTTP is the only way it gets to run its own shutdown — closing adapters and
 * tree-killing proc-MCP children. A tree-kill is the floor, not the plan: skipping the graceful step
 * is how orphaned MCP subtrees happen.
 */
export async function stopDaemon(opts: StopOptions = {}): Promise<StopResult> {
  const port = opts.port ?? resolvePort();
  const fetchFn = opts.fetchFn ?? fetch;
  const rec = readPidFile(port);
  if (!rec) return { status: "not-running", port };

  if (!(await healthOk(port, fetchFn))) {
    if (!pidAlive(rec.pid)) {
      removePidFile(port); // stale record from a killed daemon
      return { status: "not-running", port };
    }
    // The pid is alive but nothing serves on its port, so we cannot prove it is still our gateway
    // rather than a number the OS recycled. Killing on a guess is how a tool takes down unrelated
    // work; make the operator say so.
    if (!opts.force) {
      return {
        status: "refused",
        pid: rec.pid,
        port,
        reason:
          `pid ${rec.pid} is alive but nothing is answering on port ${port}, so it cannot be confirmed ` +
          `as this gateway. Re-run with --force to kill it anyway.`,
      };
    }
    await treeKill(rec.pid);
    await waitUntilDead(rec.pid, 3000);
    removePidFile(port);
    return { status: "forced", pid: rec.pid, port };
  }

  await postShutdown(port, fetchFn);
  if (await waitForPortClosed(port, opts.gracePeriodMs ?? 10000, fetchFn)) {
    removePidFile(port);
    return { status: "stopped", pid: rec.pid, port };
  }
  await treeKill(rec.pid);
  await waitUntilDead(rec.pid, 3000);
  removePidFile(port);
  return { status: "forced", pid: rec.pid, port };
}

async function getJson<T>(port: number, path: string, fetchFn: typeof fetch, token?: string): Promise<T | undefined> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * What `lmg status` prints. "Running" means it answered — not that a pid file exists, which is a
 * claim about the past.
 */
export async function daemonStatus(opts: { port?: number; fetchFn?: typeof fetch } = {}): Promise<StatusResult> {
  const port = opts.port ?? resolvePort();
  const fetchFn = opts.fetchFn ?? fetch;
  const rec = readPidFile(port);
  const base: StatusResult = { running: false, port, logFile: logFilePath(port) };
  if (rec) {
    base.pid = rec.pid;
    base.entry = rec.entry;
    base.startedAt = rec.startedAt;
    const started = Date.parse(rec.startedAt);
    if (Number.isFinite(started)) base.uptimeMs = Math.max(0, Date.now() - started);
  }

  const live = await getJson<{ ok?: boolean }>(port, "/health", fetchFn);
  if (!live?.ok) return base;

  const listed = await getJson<{ mcps?: Array<{ name?: string; state?: string; latencyMs?: number }> }>(
    port, "/api/mcps", fetchFn, readGatewayToken(),
  );
  return {
    ...base,
    running: true,
    url: urlFor(port),
    health: { ok: true, health: listed?.mcps ?? [] },
    memory: await getJson<StatusResult["memory"]>(port, "/api/memory?tree=1", fetchFn, readGatewayToken()),
  };
}
