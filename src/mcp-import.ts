import type { ServerDef } from "./config.js";
import { isLoopbackBindHost } from "./local-only.js";

/**
 * Turn a client `.mcp.json` (Claude Code, Cursor, OpenCode, …) into gateway ServerDefs.
 *
 * The file is how those clients spawn or reach MCPs today. Importing it is how they move onto this
 * gateway: a stdio `command` becomes a `proc` MCP, a remote `url` becomes an `http` MCP. Names that
 * already exist are not overwritten — they get `-1`, `-2`, … so two clients' copies of `redis` land
 * as `redis` and `redis-1`.
 *
 * URLs that already point at THIS gateway are skipped: those entries are the client's wiring to us,
 * not a server we should host (importing them would proxy the gateway to itself).
 */

const RESERVED = new Set(["api", "health", "admin"]);

export interface ImportAdd {
  /** Name as it appeared in the file, after sanitizing (before collision suffix). */
  wanted: string;
  /** Registry name that will be used (wanted, or wanted-N). */
  name: string;
  def: ServerDef;
}

export interface ImportSkip {
  name: string;
  reason: string;
}

export interface ImportPlan {
  add: ImportAdd[];
  skip: ImportSkip[];
}

/** A free name under the gateway's path rules. `health` / `api` / `admin` are reserved routes. */
export function uniqueName(base: string, taken: Set<string>): string {
  const used = (n: string): boolean => taken.has(n) || RESERVED.has(n.toLowerCase());
  if (!used(base)) return base;
  for (let i = 1; i < 10000; i++) {
    const n = `${base}-${i}`;
    if (!used(n)) return n;
  }
  throw new Error(`could not allocate a unique name for ${base}`);
}

/** Letters, digits, `_`, `-`; must start alphanumeric; max 63. Matches adminapi NAME_RE. */
function sanitizeName(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (s && !/^[a-z0-9]/.test(s)) s = `m${s}`;
  if (!s) s = "mcp";
  if (s.length > 63) s = s.slice(0, 63).replace(/-+$/g, "") || "mcp";
  return s;
}

function quoteArg(s: string): string {
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function joinCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function isGatewayUrl(url: string, gatewayPort: number): boolean {
  try {
    const u = new URL(url);
    if (!isLoopbackBindHost(u.hostname)) return false;
    const p = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
    return p === gatewayPort;
  } catch {
    return false;
  }
}

function serverMap(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of ["mcpServers", "servers"] as const) {
    const block = o[key];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      return block as Record<string, unknown>;
    }
  }
  const vals = Object.values(o);
  if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    return o;
  }
  return undefined;
}

function entryToDef(entry: unknown, gatewayPort: number): { def: ServerDef } | { skip: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { skip: "not an object" };
  }
  const e = entry as Record<string, unknown>;
  const type = String(e.type ?? "").toLowerCase().replace(/_/g, "-");
  const url = typeof e.url === "string" ? e.url.trim() : "";
  const command = typeof e.command === "string" ? e.command.trim() : "";
  const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : [];
  const httpish = type === "http" || type === "sse" || type === "streamable-http" || type === "remote";

  if (url && (httpish || !command)) {
    if (isGatewayUrl(url, gatewayPort)) return { skip: "points at this gateway" };
    const def: ServerDef = { type: "http", url };
    if (e.headers && typeof e.headers === "object" && !Array.isArray(e.headers)) {
      def.headers = e.headers as Record<string, unknown>;
    }
    return { def };
  }
  if (command) {
    const def: ServerDef = { type: "proc", command: joinCommand(command, args) };
    if (e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
      def.env = e.env as Record<string, unknown>;
    }
    if (typeof e.cwd === "string" && e.cwd.trim()) def.cwd = e.cwd.trim();
    return { def };
  }
  return { skip: "needs a command or a url" };
}

/**
 * Plan the import: names allocated, defs built, skips explained. Does not touch the registry —
 * the admin route applies the plan so a half-failed register still reports the rest.
 */
export function planMcpImport(
  raw: unknown,
  opts: { taken: Set<string>; gatewayPort: number },
): ImportPlan {
  const add: ImportAdd[] = [];
  const skip: ImportSkip[] = [];
  const map = serverMap(raw);
  if (!map) {
    skip.push({ name: "", reason: "no mcpServers / servers map in the file" });
    return { add, skip };
  }
  const taken = new Set(opts.taken);
  for (const [rawName, entry] of Object.entries(map)) {
    const wanted = sanitizeName(rawName);
    const mapped = entryToDef(entry, opts.gatewayPort);
    if ("skip" in mapped) {
      skip.push({ name: rawName, reason: mapped.skip });
      continue;
    }
    const name = uniqueName(wanted, taken);
    taken.add(name);
    add.push({ wanted, name, def: mapped.def });
  }
  return { add, skip };
}
