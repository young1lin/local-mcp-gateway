import { readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { maskDef, unmaskBody } from "../mask.js";
import type { Registry } from "../registry.js";
import { sendJson, type Handler, type Req, type Res, type Router } from "../http.js";
import { forceFree, portOwner, probePort } from "./port.js";
import { suggestMcps } from "./mcpmatch.js";
import { DependentsError, type TunnelManager } from "./manager.js";
import type { ConnInput, RuleInput, TunnelStore } from "./store.js";
import type { GroupKind, SshConnDef } from "./types.js";

/**
 * Secrets go out masked and come back restored, reusing the MCP panel's sentinel round-trip: the
 * browser never receives a password or a passphrase, and editing an unrelated field cannot destroy
 * one. maskDef/unmaskBody work on ServerDef-shaped records, which a connection def is.
 */
function maskConn(def: SshConnDef): Record<string, unknown> {
  return maskDef(def as never) as unknown as Record<string, unknown>;
}
function unmaskConn(body: Record<string, unknown>, current?: SshConnDef): Record<string, unknown> {
  return unmaskBody(body, current as never);
}

/** `?force=1` or a `{ force: true }` body — both spellings, so no caller has to guess. */
/** "rules" | "connections" from a path segment, or null when the segment names neither. */
function groupKind(seg: string): GroupKind | null {
  return seg === "rules" || seg === "connections" ? seg : null;
}

function wantsForce(req: Req): boolean {
  return req.query.get("force") === "1" || req.body?.force === true;
}

function ruleInput(body: any): RuleInput {
  const mcps = Array.isArray(body?.mcps) ? body.mcps.filter((m: unknown) => typeof m === "string" && m) : undefined;
  return {
    name: String(body?.name ?? ""),
    connectionId: String(body?.connectionId ?? ""),
    localPort: Number(body?.localPort),
    targetHost: String(body?.targetHost ?? "127.0.0.1"),
    targetPort: Number(body?.targetPort),
    remark: typeof body?.remark === "string" ? body.remark : "",
    autoReconnect: body?.autoReconnect === true || body?.autoReconnect === "true",
    reconnectInterval: Number(body?.reconnectInterval ?? 10),
    // Present only when the caller sent a list: an omitted key means "keep the stored links"
    // (RuleInput.mcps is optional for exactly this), an explicit [] clears them.
    ...(mcps ? { mcps } : {}),
    group: typeof body?.group === "string" ? body.group : undefined,
  };
}

function connInput(body: Record<string, unknown>): ConnInput {
  return {
    name: String(body.name ?? ""),
    host: String(body.host ?? ""),
    port: Number(body.port ?? 22),
    username: String(body.username ?? ""),
    authType: body.authType === "password" ? "password" : "key",
    keyPath: typeof body.keyPath === "string" ? body.keyPath : undefined,
    passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
    password: typeof body.password === "string" ? body.password : undefined,
    hostKey: typeof body.hostKey === "string" ? body.hostKey : undefined,
    group: typeof body.group === "string" ? body.group : undefined,
  };
}

/** Private keys sitting in ~/.ssh — what the panel's Browse button offers. */
function listKeys(): Array<{ path: string; name: string }> {
  const dir = join(homedir(), ".ssh");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; name: string }> = [];
  for (const name of names) {
    if (name.endsWith(".pub") || name === "known_hosts" || name === "config" || name === "authorized_keys") continue;
    if (!/^id_/.test(name) && !name.endsWith(".pem") && !name.endsWith(".key")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ path, name });
  }
  return out;
}

export interface DirEntry {
  name: string;
  path: string;
  /** true for a directory (navigable), false for a file (pickable). */
  dir: boolean;
}
export interface DirListing {
  /** The resolved directory this listing describes. */
  dir: string;
  /** The parent directory, for the Up button — absent at the filesystem root. */
  parent?: string;
  entries: DirEntry[];
  /** Set when the directory could not be read (missing, not a dir, no permission). */
  error?: string;
}

/**
 * List one directory for the key-file browser: subdirectories (navigable) and files (pickable), with a
 * parent to go up. Directories come first, then files, each alphabetical.
 *
 * A browser file picker cannot return a real server-side path (only a bare filename), so Browse is
 * served from here. Unlike `/keys` — which only knows `~/.ssh` — this reaches any path the gateway
 * process can read, so a key kept outside `~/.ssh` is still pickable.
 */
export function listDir(dir: string): DirListing {
  const abs = resolve(dir);
  let dirents: Dirent[];
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return { dir: abs, entries: [], error: (err as Error).message };
  }
  const entries: DirEntry[] = dirents.map((d) => ({
    name: d.name,
    path: join(abs, d.name),
    dir: d.isDirectory(),
  }));
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const parent = dirname(abs);
  return parent && parent !== abs ? { dir: abs, parent, entries } : { dir: abs, entries };
}

function fail(res: Res, err: unknown): void {
  if (err instanceof DependentsError) {
    return sendJson(res, 409, { error: (err as Error).message, dependents: err.dependents, confirmRequired: true });
  }
  const message = (err as Error).message ?? String(err);
  sendJson(res, /^unknown /i.test(message) ? 404 : 400, { error: message });
}

/**
 * Mount the tunnel API under /api/tunnels, behind the same auth wrapper the MCP admin API uses.
 *
 * `registry` is optional and read-only here: it feeds the "Serves MCPs" suggestion. Nothing in this
 * file starts, stops or restarts an MCP.
 */
export function mountTunnelApi(
  r: Router,
  store: TunnelStore,
  manager: TunnelManager,
  authed: (h: Handler) => Handler,
  registry?: Registry,
): void {
  // Everything both lists need, in one in-memory read — safe for the panel's poll.
  r.get("/api/tunnels", authed((_req, res) => {
    const rows = manager.rows();
    sendJson(res, 200, {
      connections: rows.connections,
      rules: rows.rules,
      ruleGroups: store.groupsOf("rules"),
      connGroups: store.groupsOf("connections"),
      mcps: registry ? registry.names() : [],
    });
  }));

  // --- groups and order ---------------------------------------------------------------------------

  // The whole order of one or both lists at once: the panel drags a row, then sends the ids it now
  // sees. Order is array order in tunnels.json — no separate rank field to keep in step.
  r.put("/api/tunnels/order", authed((req, res) => {
    try {
      const body = req.body ?? {};
      if (body.connections != null) store.reorder("connections", body.connections);
      if (body.rules != null) store.reorder("rules", body.rules);
      sendJson(res, 200, {
        connections: store.connections().map((c) => c.id),
        rules: store.rules().map((x) => x.id),
      });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.put("/api/tunnels/groups/:kind", authed((req, res) => {
    const kind = groupKind(req.params.kind);
    if (!kind) return sendJson(res, 404, { error: "unknown list: " + req.params.kind });
    try {
      sendJson(res, 200, { groups: store.setGroups(kind, req.body?.groups) });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.post("/api/tunnels/groups/:kind/rename", authed((req, res) => {
    const kind = groupKind(req.params.kind);
    if (!kind) return sendJson(res, 404, { error: "unknown list: " + req.params.kind });
    try {
      sendJson(res, 200, store.renameGroup(kind, String(req.body?.from ?? ""), String(req.body?.to ?? "")));
    } catch (err) {
      fail(res, err);
    }
  }));

  r.put("/api/tunnels/groups/:kind/:id", authed((req, res) => {
    const kind = groupKind(req.params.kind);
    if (!kind) return sendJson(res, 404, { error: "unknown list: " + req.params.kind });
    try {
      sendJson(res, 200, { group: store.setGroup(kind, req.params.id, req.body?.group) });
    } catch (err) {
      fail(res, err);
    }
  }));

  // Private keys under ~/.ssh. A browser cannot hand a real path to the page, so Browse is served
  // from here instead of a file picker that would only ever return a bare filename.
  r.get("/api/tunnels/keys", authed((_req, res) => {
    sendJson(res, 200, { keys: listKeys(), defaultPath: join(homedir(), ".ssh", "id_rsa") });
  }));

  // Browse any directory the gateway process can read, for the key picker — not just ~/.ssh.
  // `?dir=` defaults to ~/.ssh; an unreadable / non-directory path returns an error, not a throw.
  r.get("/api/tunnels/browse", authed((req, res) => {
    const dir = req.query.get("dir") || join(homedir(), ".ssh");
    sendJson(res, 200, listDir(dir));
  }));

  // Which MCPs point at this local port — the rule editor's pre-checked suggestion.
  r.get("/api/tunnels/suggest/:port", authed((req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: `invalid port: ${req.params.port}` });
    }
    sendJson(res, 200, { port, mcps: registry ? suggestMcps(registry, port) : [] });
  }));

  // --- connections -------------------------------------------------------------------------------

  r.post("/api/tunnels/connections", authed((req, res) => {
    try {
      const def = store.addConnection(connInput(unmaskConn(req.body ?? {})));
      sendJson(res, 201, { connection: maskConn(def) });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.put("/api/tunnels/connections/:id", authed(async (req, res) => {
    const current = store.connection(req.params.id);
    if (!current) return sendJson(res, 404, { error: `unknown SSH connection: ${req.params.id}` });
    try {
      const def = await manager.applyConnectionUpdate(req.params.id, connInput(unmaskConn(req.body ?? {}, current)));
      sendJson(res, 200, { connection: maskConn(def) });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.delete("/api/tunnels/connections/:id", authed(async (req, res) => {
    try {
      await manager.deleteConnection(req.params.id);
      sendJson(res, 200, { id: req.params.id, deleted: true });
    } catch (err) {
      // Same funnel as rule deletion: DependentsError → 409 + dependents + confirmRequired,
      // "unknown …" → 404, anything else → 400. The old blanket 409 made a disk error and a
      // "still used by" refusal indistinguishable to the panel.
      fail(res, err);
    }
  }));

  r.post("/api/tunnels/connections/:id/test", authed(async (req, res) => {
    try {
      sendJson(res, 200, await manager.testConnection(req.params.id));
    } catch (err) {
      fail(res, err);
    }
  }));

  r.post("/api/tunnels/connections/:id/trust", authed((req, res) => {
    try {
      sendJson(res, 200, { id: req.params.id, hostKey: manager.trustHostKey(req.params.id) ?? null });
    } catch (err) {
      fail(res, err);
    }
  }));

  // --- rules -------------------------------------------------------------------------------------

  r.post("/api/tunnels/rules", authed(async (req, res) => {
    let id: string;
    try {
      id = store.addRule(ruleInput(req.body)).id;
    } catch (err) {
      return fail(res, err);
    }
    // Start it now when asked, but a start failure must not undo a rule that saved fine — it lands
    // in `error` with its reason, which is what the panel shows.
    if (req.body?.start === true) {
      try {
        await manager.startRule(id);
      } catch { /* reported through the row's state */ }
    }
    sendJson(res, 201, { rule: manager.rows().rules.find((x) => x.id === id) });
  }));

  r.put("/api/tunnels/rules/:id", authed(async (req, res) => {
    if (!store.rule(req.params.id)) return sendJson(res, 404, { error: `unknown rule: ${req.params.id}` });
    try {
      await manager.applyRuleUpdate(req.params.id, ruleInput(req.body));
      sendJson(res, 200, { rule: manager.rows().rules.find((x) => x.id === req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.delete("/api/tunnels/rules/:id", authed(async (req, res) => {
    try {
      await manager.deleteRule(req.params.id, wantsForce(req));
      sendJson(res, 200, { id: req.params.id, deleted: true });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.post("/api/tunnels/rules/:id/start", authed(async (req, res) => {
    try {
      await manager.startRule(req.params.id);
      sendJson(res, 200, { rule: manager.rows().rules.find((x) => x.id === req.params.id) });
    } catch (err) {
      const row = manager.rows().rules.find((x) => x.id === req.params.id);
      if (!row) return fail(res, err);
      // A start failure is a result, not a transport error: the row carries the state, the reason and
      // the port holder, which is exactly what the panel needs to offer Force free.
      sendJson(res, 200, { rule: row, ok: false, error: (err as Error).message });
    }
  }));

  r.post("/api/tunnels/rules/:id/stop", authed(async (req, res) => {
    try {
      await manager.stopRule(req.params.id, { force: wantsForce(req) });
      sendJson(res, 200, { rule: manager.rows().rules.find((x) => x.id === req.params.id) });
    } catch (err) {
      fail(res, err);
    }
  }));

  r.post("/api/tunnels/start-all", authed(async (_req, res) => {
    sendJson(res, 200, { results: await manager.startAll() });
  }));

  r.post("/api/tunnels/stop-all", authed(async (req, res) => {
    try {
      sendJson(res, 200, { results: await manager.stopAll(wantsForce(req)) });
    } catch (err) {
      fail(res, err);
    }
  }));

  // --- ports -------------------------------------------------------------------------------------

  r.get("/api/tunnels/port/:port", authed(async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: `invalid port: ${req.params.port}` });
    }
    const free = await probePort(port);
    sendJson(res, 200, { port, free, owner: free ? null : await portOwner(port) });
  }));

  r.post("/api/tunnels/port/:port/free", authed(async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: `invalid port: ${req.params.port}` });
    }
    const owner = await portOwner(port);
    if (!owner) return sendJson(res, 404, { error: `nothing is listening on port ${port}` });
    try {
      await forceFree(owner.pid);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message, owner });
    }
    sendJson(res, 200, { port, killed: owner });
  }));
}
