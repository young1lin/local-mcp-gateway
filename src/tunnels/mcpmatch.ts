import { resolveDef, type ServerDef } from "../config.js";
import type { Registry } from "../registry.js";
import type { McpView } from "./manager.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

function isLoopback(host: unknown): boolean {
  return typeof host === "string" && LOOPBACK.has(host.trim().toLowerCase());
}

/** host/port out of a Postgres connection string, without pulling in a URL parser's strictness. */
function pgHostPort(url: string): { host: string; port: number } | undefined {
  // postgresql://user:pass@host:port/db?opts — the authority is between the last '@' and the next '/'.
  const scheme = url.indexOf("://");
  if (scheme < 0) return undefined;
  const rest = url.slice(scheme + 3);
  // The authority ends at the first '/' OR '?' — postgresql://u:p@h:5433?sslmode=require has no
  // path, and cutting only at '/' once glued "5433?sslmode=require" into the host.
  const slash = rest.indexOf("/");
  const q = rest.indexOf("?");
  const cut = slash < 0 ? q : q < 0 ? slash : Math.min(slash, q);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const hostPart = at < 0 ? authority : authority.slice(at + 1);
  if (!hostPart) return undefined;
  const colon = hostPart.lastIndexOf(":");
  // A bare IPv6 literal has colons but no port; only treat the tail as a port when it is numeric.
  if (colon >= 0) {
    const tail = hostPart.slice(colon + 1);
    if (/^\d+$/.test(tail)) return { host: hostPart.slice(0, colon), port: Number(tail) };
  }
  return { host: hostPart, port: 5432 };
}

/**
 * The local port an MCP connects to, when it connects to loopback — otherwise undefined.
 *
 * This is the whole of the "Serves MCPs" suggestion rule: an MCP pointing at 127.0.0.1:5433 is very
 * probably served by the rule that binds 5433. `proc` and `echo` are never matched, because guessing
 * a port out of a command line would be a guess.
 *
 * `resolveDef` runs first so a `${PG_WEK_URL}` reference is compared by value; the resolution stays
 * server-side and only the match result is ever sent to the browser.
 */
export function mcpLoopbackPort(def: ServerDef): number | undefined {
  const d = resolveDef(def);
  if (d.type === "mysql" || d.type === "redis") {
    const host = d.host ?? "localhost";
    if (!isLoopback(host)) return undefined;
    const fallback = d.type === "mysql" ? 3306 : 6379;
    const port = Number(d.port ?? fallback);
    return Number.isInteger(port) && port > 0 ? port : fallback;
  }
  if (d.type === "pg") {
    if (typeof d.url !== "string" || !d.url) return undefined;
    const hp = pgHostPort(d.url);
    if (!hp || !isLoopback(hp.host)) return undefined;
    return hp.port;
  }
  return undefined;
}

/** MCP names whose loopback target is `localPort` — pre-checked in the rule editor. */
export function suggestMcps(registry: Registry, localPort: number): string[] {
  return registry
    .all()
    .filter((e) => mcpLoopbackPort(e.def) === localPort)
    .map((e) => e.name);
}

/** The read-only view of the registry the tunnel subsystem gets. Nothing here can start or stop an MCP. */
export function registryView(registry: Registry): McpView {
  return {
    has: (name) => registry.has(name),
    stateOf: (name) => {
      const e = registry.get(name);
      if (!e) return undefined;
      return e.lifecycle === "started" ? e.status : e.lifecycle;
    },
    isStarted: (name) => registry.get(name)?.lifecycle === "started",
    startedAt: (name) => registry.get(name)?.startedAt,
  };
}
