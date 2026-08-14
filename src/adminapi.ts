import { readFileSync } from "node:fs";
import type { Registry, RegistryEntry } from "./registry.js";
import type { ManagedStore } from "./managed.js";
import { DEFAULT_PORT, type ServerDef } from "./config.js";
import { maskDef, unmaskBody } from "./mask.js";
import type { ListKind } from "./paging.js";
import { makeAdapter } from "./adapters/factory.js";
import { assertProxyUrl, proxiedFetch } from "./adapters/proxy-fetch.js";
import { openSession } from "./introspect.js";
import { listPage, newPageCache, PAGE_SIZE } from "./paging.js";
import { verifyBasic, bearerSecret } from "./auth.js";
import type { TokenManager } from "./token.js";
import { log } from "./log.js";
import { getMemoryInfo } from "./mem.js";
import { clearCalls, contentText, readCall, readCalls, withCallSource } from "./calls.js";
import { readTraffic, readTrafficEntry, trafficClients, clearTraffic } from "./traffic.js";
import { dataPath } from "./datadir.js";
import { planMcpImport } from "./mcp-import.js";
import { header, sendJson, type Handler, type Req, type Res, type Router } from "./http.js";

function configuredPort(): number {
  try {
    const n = Number(JSON.parse(readFileSync(dataPath("gateway.config.json"), "utf8")).port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  } catch {
    /* no config, or no port field */
  }
  return DEFAULT_PORT;
}

/** Panel login credentials (default admin/admin). */
export interface AdminCreds {
  user: string;
  pass: string;
}

/**
 * How a shutdown request reaches the process.
 *
 * `process.emit` and not `process.kill(process.pid, "SIGTERM")`: on Windows a signal sent through
 * kill() is an unconditional terminate, so it would skip index.ts's SIGTERM handler — the sequence
 * that closes adapters, tree-kills proc-MCP children and flushes the call log. Emitting the event
 * runs that same handler in-process, which is what makes Ctrl-C and `lmg stop` behave identically.
 */
const raiseShutdown = (): void => {
  process.emit("SIGTERM");
};
let shutdownSignal: () => void = raiseShutdown;

/** Test seam: observe the request without ending the test runner. No argument restores the default. */
export function setShutdownSignal(fn?: () => void): void {
  shutdownSignal = fn ?? raiseShutdown;
}

/**
 * What the MCP admin API is allowed to do with tunnels: read the links, and keep them pointing at the
 * right MCP name. Deliberately this narrow — an MCP operation must never start or stop a tunnel.
 */
export interface TunnelLinks {
  tunnelsForMcp(name: string): unknown[];
  renameMcp(from: string, to: string): void;
  forgetMcp(name: string): void;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
// Names that would shadow built-in routes or be ambiguous as a path segment.
const RESERVED = new Set(["api", "health", "admin", ""]);

function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !RESERVED.has(name.toLowerCase());
}

function stateOf(e: RegistryEntry): string {
  return e.lifecycle === "started" ? e.status : e.lifecycle;
}

/** How this MCP is launched, for the sidebar chip. The adapter type, except `proc`, which is split
 *  by its command's first word — npx / uvx / docker is the difference a user reads at a glance.
 *  Windows wrappers (`npx.cmd`, `uvx.exe`) resolve to the same tag. */
function tagOf(type: string, def: ServerDef): string {
  if (type !== "proc") return type;
  const first = String(def.command ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const base = first.replace(/\.(cmd|exe)$/i, "").replaceAll("\\", "/").split("/").pop() ?? "";
  if (base === "npx" || base === "uvx" || base === "docker") return base;
  if (base === "uv") return "uvx";
  return "proc";
}

// --- definition building --------------------------------------------------------------------

/** Connection fields each direct adapter reads. Anything else in the request body is dropped, so the
 *  panel can edit a definition without polluting it. */
const DIRECT_FIELDS: Record<string, string[]> = {
  mysql: ["description", "host", "port", "user", "password", "database", "timezone", "readonly", "maxRows"],
  redis: ["description", "host", "port", "password", "db", "readonly", "allowDestructive", "allowEval"],
  pg: ["description", "url", "readonly", "maxRows"],
  mongo: ["description", "url", "database", "readonly", "maxRows"],
};
const BOOL_FIELDS = new Set(["readonly", "allowDestructive", "allowEval", "exposeResources", "exposePrompts"]);
/** Fields without which the adapter has nothing to connect to. An empty pg/mongo connection string is
 *  the dangerous one: libpq falls back to PGHOST/PGDATABASE and the mongo driver to localhost:27017,
 *  so the MCP would quietly point at whatever the environment happens to name rather than failing.
 *  mysql/redis default to localhost on their standard port, which is a stated default, not a surprise. */
const REQUIRED_FIELD: Record<string, string> = { pg: "url", mongo: "url" };

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Build a ServerDef from an admin add/edit request body. */
function buildDef(body: any): ServerDef {
  const def = buildTypedDef(body);
  // `lazy` rides on every type — it is what the panel's "Start automatically" checkbox writes
  // (inverted). A proc is lazy by default; anything else opts in explicitly (see isLazy).
  if (body?.lazy !== undefined) def.lazy = asBool(body.lazy);
  return def;
}

function buildTypedDef(body: any): ServerDef {
  const type = String(body?.type ?? "proc").trim() || "proc";
  if (type === "proc") {
    const command = String(body?.command ?? "").trim();
    if (!command) throw new Error("command is required");
    const def: ServerDef = { type: "proc", command };
    if (typeof body?.description === "string" && body.description.trim()) def.description = body.description.trim();
    if (body?.env && typeof body.env === "object" && Object.keys(body.env).length) def.env = body.env;
    if (typeof body?.cwd === "string" && body.cwd.trim()) def.cwd = body.cwd.trim();
    // Default true in the adapter; only persist an explicit opt-out, so a child with thousands of
    // resources can be hidden from client context. Previously unreachable from the panel, which also
    // meant editing a proc MCP silently dropped whatever was configured.
    if (body?.exposeResources !== undefined && !asBool(body.exposeResources)) def.exposeResources = false;
    if (body?.exposePrompts !== undefined && !asBool(body.exposePrompts)) def.exposePrompts = false;
    return def;
  }
  // A remote MCP is configured, not launched: where it is, and the headers its API key travels in.
  // Shaped like the proc branch rather than DIRECT_FIELDS because `headers` is a map, and because an
  // http MCP with no url has nothing to connect to at all.
  if (type === "http") {
    const url = String(body?.url ?? "").trim();
    if (!url) throw new Error("url is required for an http MCP");
    const def: ServerDef = { type: "http", url };
    if (typeof body?.description === "string" && body.description.trim()) def.description = body.description.trim();
    if (body?.headers && typeof body.headers === "object" && Object.keys(body.headers).length) {
      def.headers = body.headers;
    }
    if (body?.exposeResources !== undefined && !asBool(body.exposeResources)) def.exposeResources = false;
    if (body?.exposePrompts !== undefined && !asBool(body.exposePrompts)) def.exposePrompts = false;
    // An http(s):// URL, or a ${ENV} ref to one; the adapter validates the resolved value at build.
    if (typeof body?.proxy === "string" && body.proxy.trim()) def.proxy = body.proxy.trim();
    return def;
  }
  // A declared REST API: `tools` is an array of declarations and is kept whole — it is authored, not
  // filled in from form fields, and nothing here should reshape it.
  if (type === "rest") {
    const baseUrl = String(body?.baseUrl ?? "").trim();
    if (!baseUrl) throw new Error("baseUrl is required for a rest MCP");
    if (!Array.isArray(body?.tools) || !body.tools.length) throw new Error("tools must be a non-empty array for a rest MCP");
    const def: ServerDef = { type: "rest", baseUrl, tools: body.tools };
    if (typeof body?.description === "string" && body.description.trim()) def.description = body.description.trim();
    if (body?.headers && typeof body.headers === "object" && Object.keys(body.headers).length) {
      def.headers = body.headers;
    }
    if (body?.timeoutMs !== undefined && body.timeoutMs !== "" && Number(body.timeoutMs) > 0) {
      def.timeoutMs = Number(body.timeoutMs);
    }
    // Same field as the http branch: a proxy URL or a ${ENV} ref, validated by the adapter.
    if (typeof body?.proxy === "string" && body.proxy.trim()) def.proxy = body.proxy.trim();
    return def;
  }
  if (type === "echo") return { type: "echo" };
  const allowed = DIRECT_FIELDS[type];
  if (!allowed) {
    throw new Error(`unknown type: ${type} (supported: mysql | redis | pg | mongo | proc | http | rest | echo)`);
  }
  const def: ServerDef = { type };
  for (const k of allowed) {
    const v = body?.[k];
    if (v === undefined || v === null || v === "") continue;
    (def as Record<string, unknown>)[k] = BOOL_FIELDS.has(k) ? asBool(v) : v;
  }
  const need = REQUIRED_FIELD[type];
  if (need && !def[need]) throw new Error(`${need} is required for a ${type} MCP`);
  return def;
}

/**
 * The gate every management route sits behind: panel credentials (Basic) or the bearer token.
 * Exported so the tunnel API is protected by exactly the same check rather than its own copy.
 */
export function makeAuthed(creds: AdminCreds, tokens: TokenManager): (h: Handler) => Handler {
  return (h: Handler): Handler => async (req: Req, res: Res) => {
    const a = header(req, "authorization");
    if (verifyBasic(a, creds.user, creds.pass) || !!tokens.verify(bearerSecret(a))) return h(req, res);
    sendJson(res, 401, { error: "Unauthorized" });
  };
}

/** Mount the management API under /api. Auth is username/password (Basic) or the bearer token. */
export function mountAdminApi(
  r: Router,
  registry: Registry,
  store: ManagedStore,
  creds: AdminCreds,
  tokens: TokenManager,
  tokenEnv = "MCP_GATEWAY_TOKEN",
  /** Read-only tunnel view: the MCP detail page shows which tunnels serve it, and renames/deletes
   *  keep the links in tunnels.json pointing at the right names. Never used to change a tunnel. */
  tunnels?: TunnelLinks,
): void {
  const authed = makeAuthed(creds, tokens);

  async function addManaged(name: string, def: ServerDef, enabled: boolean, startNow = enabled): Promise<string | undefined> {
    const adapter = makeAdapter(def, name);
    store.add({ name, def, enabled });
    try {
      registry.register(name, "managed", def, adapter);
    } catch (err) {
      store.remove(name);
      throw err;
    }
    if (startNow) {
      try {
        await registry.start(name);
      } catch (err) {
        log("warn", "managed mcp start failed on add", { name, err: (err as Error).message });
      }
    }
    return registry.get(name)?.lifecycle;
  }

  // Login check for the browser gate. Validates username/password (timing-safe via verifyBasic).
  r.post("/api/login", (req, res) => {
    const basic = "Basic " + Buffer.from(`${req.body?.username ?? ""}:${req.body?.password ?? ""}`).toString("base64");
    if (verifyBasic(basic, creds.user, creds.pass)) return sendJson(res, 200, { ok: true, username: creds.user });
    sendJson(res, 401, { error: "invalid credentials" });
  });

  // The env var the seed token came from — metadata for the panel, never a secret.
  r.get("/api/info", authed((_req, res) => {
    sendJson(res, 200, { tokenEnv });
  }));

  // --- tokens: named per-client bearers, so the logs can attribute every request to a client ----
  r.get("/api/tokens", authed((_req, res) => {
    sendJson(res, 200, { tokens: tokens.list(), tokenEnv });
  }));

  /**
   * Hand a stored secret back, so the panel can build a connect command from a token that already
   * exists.
   *
   * This is a deliberate relaxation of "shown once on create". That rule was never backed by
   * anything: `verify()` compares `t.secret` directly, so the secret sits in plaintext in
   * managed.json and `cat` recovers it. Withholding it from an authenticated caller on this
   * particular API bought no secrecy — the admin routes sit behind the router's loopback guard and a
   * bearer/Basic check — while costing a rotate (which breaks every client already using that token)
   * every time someone wanted to copy a connect command.
   *
   * Its own route rather than a field on the list, so reading a secret stays an explicit act.
   */
  r.get("/api/tokens/:id/secret", authed((req, res) => {
    const rec = tokens.get(req.params.id);
    if (!rec) return sendJson(res, 404, { error: "no such token" });
    sendJson(res, 200, { id: rec.id, label: rec.label, secret: rec.secret });
  }));

  // Create a token. Its secret comes back here, and stays retrievable through the route above.
  r.post("/api/tokens", authed(async (req, res) => {
    const rec = tokens.create(String(req.body?.label ?? ""));
    log("info", "token created", { id: rec.id, label: rec.label });
    sendJson(res, 201, { id: rec.id, label: rec.label, secret: rec.secret, createdAt: rec.createdAt });
  }));

  r.delete("/api/tokens/:id", authed(async (req, res) => {
    if (!tokens.remove(req.params.id)) return sendJson(res, 404, { error: "no such token" });
    log("info", "token revoked", { id: req.params.id });
    sendJson(res, 200, { ok: true });
  }));

  // Rotate one token: a fresh secret under the same id/label; the old secret stops working at once.
  r.post("/api/tokens/:id/rotate", authed(async (req, res) => {
    const rec = tokens.rotate(req.params.id);
    if (!rec) return sendJson(res, 404, { error: "no such token" });
    log("info", "token rotated", { id: rec.id });
    sendJson(res, 200, { id: rec.id, label: rec.label, secret: rec.secret, createdAt: rec.createdAt });
  }));

  // --- interaction traffic: who (token + self-reported client) asked what, across every MCP ------
  // Paged and body-less, for the same reason the tool-call log is: an entry's request and reply are
  // capped at 8 KB each, and the panel polls this every 6 seconds. Sending 200 of them to render a
  // dozen visible lines — whose JSON is hidden until a row is expanded — moved megabytes per minute.
  // `clients` is folded over the whole ring, never over the page: it answers "who is talking to my
  // gateway", which must not change as you page or switch the actions filter.
  r.get("/api/traffic", authed((req, res) => {
    const page = readTraffic({
      mcp: req.query.get("mcp") || undefined,
      client: req.query.get("client") || undefined,
      method: req.query.get("method") || undefined,
      actionsOnly: req.query.get("actions") === "1",
      page: req.query.get("page") ? Number(req.query.get("page")) : undefined,
      pageSize: req.query.get("pageSize") ? Number(req.query.get("pageSize")) : undefined,
    });
    sendJson(res, 200, { ...page, clients: trafficClients() });
  }));

  /** One interaction's raw request and reply, fetched when its row is expanded. */
  r.get("/api/traffic/:seq", authed((req, res) => {
    const entry = readTrafficEntry(Number(req.params.seq));
    if (!entry) { sendJson(res, 404, { error: "No such interaction (the ring may have rolled over)" }); return; }
    sendJson(res, 200, entry);
  }));

  r.delete("/api/traffic", authed((req, res) => {
    // ?client=<prefixed key> clears only that client's rows (the panel clears the filtered client);
    // without it, all traffic is cleared.
    const client = req.query.get("client") || undefined;
    clearTraffic(client);
    sendJson(res, 200, { ok: true, client: client ?? null });
  }));

  // The panel's sidebar order. Names the panel sends back verbatim; registered MCPs missing from
  // the list are appended by GET /api/mcps in name order, so a fresh MCP never vanishes and lands
  // somewhere predictable. Until this is called at all, the sidebar is simply sorted by name.
  r.put("/api/order", authed((req, res) => {
    const order = req.body?.order;
    if (!Array.isArray(order) || !order.every((n: unknown) => typeof n === "string")) {
      return sendJson(res, 400, { error: "order must be an array of MCP names" });
    }
    store.setOrder(order);
    sendJson(res, 200, { order: store.getOrder() });
  }));

  // The panel's custom sidebar groups, sent as one whole ordered list: creating, reordering and
  // deleting are all "here is the new list". A group dropped by omission is deleted, and the store
  // returns its MCPs to the default group rather than leaving them pointing at a dead name.
  r.put("/api/groups", authed((req, res) => {
    const groups = req.body?.groups;
    if (!Array.isArray(groups) || !groups.every((n: unknown) => typeof n === "string")) {
      return sendJson(res, 400, { error: "groups must be an array of group names" });
    }
    try {
      store.setGroups(groups);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    sendJson(res, 200, { groups: store.getGroups() });
  }));

  // Rename in place: the group keeps its slot in the order and takes its members with it, which a
  // delete-then-create could not do.
  r.post("/api/groups/:name/rename", authed((req, res) => {
    const from = req.params.name;
    const to = String(req.body?.name ?? "").trim();
    if (!store.getGroups().some((g) => g.toLowerCase() === from.toLowerCase())) {
      return sendJson(res, 404, { error: `unknown group: ${from}` });
    }
    try {
      store.renameGroup(from, to);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    sendJson(res, 200, { groups: store.getGroups() });
  }));

  // Put one MCP in a group. `null` (or "default") returns it to the default group. Works for
  // config-sourced MCPs because membership is keyed by name in managed.json, not held on the def.
  r.put("/api/mcps/:name/group", authed((req, res) => {
    const name = req.params.name;
    if (!registry.has(name)) return sendJson(res, 404, { error: `unknown MCP: ${name}` });
    const raw = req.body?.group;
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      return sendJson(res, 400, { error: "group must be a group name or null" });
    }
    try {
      store.setMcpGroup(name, raw == null ? null : raw);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    sendJson(res, 200, { name, group: store.groupOf(name) });
  }));

  // List every MCP — status only (light, safe to poll). Tools/resources load on demand.
  r.get("/api/mcps", authed((_req, res) => {
    const rank = new Map(store.getOrder().map((n, i) => [n, i]));
    const rows = registry.all()
      .map((e) => ({
        name: e.name,
        source: e.source,
        type: e.adapter.type,
        // How this MCP is launched (http / rest / npx / uvx / ...), so the sidebar can label every row
        // without a per-row details fetch.
        tag: tagOf(e.adapter.type, e.def),
        // Included in the light list so the sidebar can label every MCP without a per-row details fetch.
        description: typeof e.def.description === "string" ? e.def.description : "",
        lifecycle: e.lifecycle,
        state: stateOf(e),
        latencyMs: e.latencyMs,
        lastCheck: e.lastCheck,
        reason: e.lifecycle === "error" ? e.error : e.lastError,
        startedAt: e.startedAt,
        // The sidebar group. Always a real name — an unassigned MCP answers "default".
        group: store.groupOf(e.name),
      }))
      // The panel-defined order first; everything the user has never positioned — a freshly added
      // MCP, or the whole list until the first drag — falls back to plain name order rather than to
      // whatever order the registry happened to start them in, which is arbitrary to the eye.
      // Order stays flat across the whole list; the panel slices it by group when it renders, so one
      // array keeps doing the job and a group change never has to rewrite the ordering.
      .sort((a, b) => {
        const ra = rank.get(a.name) ?? Infinity;
        const rb = rank.get(b.name) ?? Infinity;
        // Both unranked would be Infinity - Infinity = NaN, which is not a legal comparator result;
        // compare ranks only when they actually differ, and let names decide otherwise.
        if (ra !== rb) return ra - rb;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    sendJson(res, 200, { mcps: rows, groups: store.getGroups() });
  }));

  // Memory footprint. The gateway's own numbers are read in-process (free); pass ?tree=1 to also walk
  // proc-MCP child subtrees, which costs a powershell spawn and is therefore opt-in.
  r.get("/api/memory", authed(async (req, res) => {
    const wantsTree = req.query.get("tree") === "1";
    sendJson(res, 200, await getMemoryInfo(registry.childPids(), wantsTree));
  }));

  // Stop the gateway. This endpoint exists because Windows has no deliverable SIGTERM, so `lmg stop`
  // has no other way to reach the graceful sequence; without it, stopping would mean a tree-kill and
  // every proc-MCP subtree would be orphaned. Token-only, and the local-only guard ahead of every
  // route means it is unreachable from another machine.
  r.post("/api/shutdown", authed((_req, res) => {
    log("info", "shutdown requested over the admin API");
    // Answer before tearing anything down: `lmg stop` distinguishes a clean stop from a crash by
    // receiving this response, so the signal waits until the socket has been written.
    res.on("finish", () => shutdownSignal());
    sendJson(res, 200, { ok: true, stopping: true });
  }));

  // Add a new MCP. Paste a command (proc) or provide type-specific fields.
  r.post("/api/mcps", authed(async (req, res) => {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    if (!isValidName(name)) {
      return sendJson(res, 400, { error: `invalid name '${name}' (use letters, digits, - or _)` });
    }
    if (registry.has(name) || store.has(name)) {
      return sendJson(res, 409, { error: `name already exists: ${name}` });
    }
    let def: ServerDef;
    try {
      def = buildDef(body);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    const enabled = body.enabled !== false;
    try {
      const lifecycle = await addManaged(name, def, enabled);
      sendJson(res, 201, { name, type: def.type, lifecycle });
    } catch (err) {
      const msg = (err as Error).message;
      sendJson(res, /already registered/i.test(msg) ? 409 : 400, { error: msg });
    }
  }));

  // Import a client `.mcp.json` (Claude Code / Cursor / OpenCode). Stdio entries become proc MCPs,
  // remote URLs become http MCPs. Names already in use get -1, -2 rather than being overwritten.
  r.post("/api/mcps/import", authed(async (req, res) => {
    const taken = new Set([...registry.names(), ...store.all().map((m) => m.name)]);
    const plan = planMcpImport(req.body ?? {}, { taken, gatewayPort: configuredPort() });
    const imported: Array<{ name: string; from: string; type: string; lifecycle?: string }> = [];
    const skipped = plan.skip.slice();
    for (const item of plan.add) {
      try {
        const lifecycle = await addManaged(item.name, item.def, true, false);
        imported.push({ name: item.name, from: item.wanted, type: item.def.type, lifecycle });
      } catch (err) {
        skipped.push({ name: item.wanted, reason: (err as Error).message });
      }
    }
    sendJson(res, 200, { imported, skipped });
  }));

  // A REAL connection test against the values in the form: buildDef validates them, makeAdapter
  // expands the ${ENV} refs and constructs the same driver the MCP would run. Nothing is registered
  // and nothing is persisted — the credential exists only inside the throwaway adapter, closed
  // immediately after. What "a real test" means per family:
  // - DB (mysql/redis/pg/mongo): adapter.ping() — exactly what the health probe runs.
  // - http: adapter.build() — the initialize handshake, so a wrong URL or a rejected key fails here.
  // - rest: one plain GET to the baseUrl (through the def's proxy if it names one). ANY HTTP answer
  //   counts as reachable — the base path itself need not serve anything — a network error does not.
  const TESTABLE_TYPES = ["mysql", "redis", "pg", "mongo", "http", "rest"] as const;
  const TEST_TIMEOUT_MS = 5000;
  r.post("/api/mcps/test", authed(async (req, res) => {
    const body = req.body ?? {};
    const type = String(body.type ?? "");
    if (!(TESTABLE_TYPES as readonly string[]).includes(type)) {
      return sendJson(res, 400, { error: `no connection test for type '${type}' (testable: ${TESTABLE_TYPES.join(" | ")})` });
    }
    const t0 = Date.now();

    // rest is tested with one plain request rather than an adapter: its tools are authored calls
    // into a metered API and must not be fired on a button press.
    if (type === "rest") {
      let def;
      try {
        def = buildDef(body);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      const headers = { accept: "application/json", ...((def.headers as Record<string, string>) ?? {}) };
      const doFetch =
        typeof def.proxy === "string" && def.proxy ? proxiedFetch(assertProxyUrl(def.proxy)) : fetch;
      try {
        const out = await doFetch(String(def.baseUrl), {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        sendJson(res, 200, { ok: true, ms: Date.now() - t0, status: out.status });
      } catch (err) {
        sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: (err as Error).message });
      }
      return;
    }

    let adapter;
    try {
      adapter = makeAdapter(buildDef(body), "test");
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    try {
      if (type === "http") {
        await adapter.build(); // the initialize handshake IS the test
        sendJson(res, 200, { ok: true, ms: Date.now() - t0 });
      } else {
        if (!adapter.ping) throw new Error("this adapter has no connection probe");
        // The cap matters most for Mongo: driver server-selection can otherwise sit there for 30s.
        await Promise.race([
          adapter.ping(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS} ms`)), TEST_TIMEOUT_MS);
            t.unref();
          }),
        ]);
        sendJson(res, 200, { ok: true, ms: Date.now() - t0 });
      }
    } catch (err) {
      // The driver's own message is the useful part ("Access denied for user 'x'@'h'") — driver
      // errors never embed the password, so it is safe to hand back verbatim.
      sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: (err as Error).message });
    } finally {
      void adapter.close?.().catch(() => { /* best effort */ });
    }
  }));

  const lifecycleRoute = (verb: "start" | "stop" | "restart") =>
    authed(async (req, res) => {
      const name = req.params.name;
      try {
        if (verb === "start") await registry.start(name);
        else if (verb === "stop") await registry.stop(name);
        else await registry.restart(name);
        store.setEnabled(name, verb !== "stop");
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      sendJson(res, 200, { name, lifecycle: registry.get(name)?.lifecycle });
    });

  r.post("/api/mcps/:name/start", lifecycleRoute("start"));
  r.post("/api/mcps/:name/stop", lifecycleRoute("stop"));
  r.post("/api/mcps/:name/restart", lifecycleRoute("restart"));

  r.post("/api/mcps/:name/rename", authed(async (req, res) => {
    const oldName = req.params.name;
    const newName = String(req.body?.name ?? "").trim();
    if (!isValidName(newName)) {
      return sendJson(res, 400, { error: `invalid name '${newName}'` });
    }
    if (registry.has(newName)) {
      return sendJson(res, 409, { error: `name already exists: ${newName}` });
    }
    try {
      await registry.rename(oldName, newName);
      store.rename(oldName, newName);
      // A tunnel that declares it serves this MCP must follow the rename, or the link silently dies
      // and the panel starts claiming the tunnel serves nothing.
      tunnels?.renameMcp(oldName, newName);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    sendJson(res, 200, { name: newName });
  }));

  r.delete("/api/mcps/:name", authed(async (req, res) => {
    const name = req.params.name;
    try {
      await registry.delete(name);
      store.remove(name);
      tunnels?.forgetMcp(name); // no MCP by that name any more, so no rule may claim to serve it
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    sendJson(res, 200, { name, deleted: true });
  }));

  // Live details: state, reason, config (secrets masked) and, for proc, captured stderr.
  // Registered before the /:kind catch-all so it isn't shadowed.
  r.get("/api/mcps/:name/details", authed((req, res) => {
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    sendJson(res, 200, {
      name: e.name,
      source: e.source,
      type: e.adapter.type,
      lifecycle: e.lifecycle,
      state: stateOf(e),
      reason: e.lifecycle === "error" ? e.error : e.lastError,
      logs: e.adapter.logs?.() ?? "",
      config: maskDef(e.def),
      // Tunnels this MCP's traffic depends on. When a health check fails, the answer to "is it the
      // tunnel or the database?" belongs on the same screen as the failure.
      tunnels: tunnels?.tunnelsForMcp(e.name) ?? [],
    });
  }));

  // One page of this MCP's call log, newest first: the arguments each call received and the reply it
  // sent, read from the on-disk log so it survives a restart. Its own endpoint rather than part of
  // /details because the panel polls it while the Logs tab is open, and /details also feeds the config
  // view. Replies come back shortened; /calls/:seq returns one in full.
  r.get("/api/mcps/:name/calls", authed(async (req, res) => {
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    const page = Number(req.query.get("page") ?? 0);
    const result = await readCalls(e.name, Number.isFinite(page) ? page : 0);
    sendJson(res, 200, { name: e.name, ...result, stderr: e.adapter.logs?.() ?? "" });
  }));

  // One logged call with its reply in full — the panel's "Show full result".
  r.get("/api/mcps/:name/calls/:seq", authed(async (req, res) => {
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    const seq = Number(req.params.seq);
    if (!Number.isFinite(seq)) return sendJson(res, 400, { error: "seq must be a number" });
    const call = await readCall(e.name, seq);
    if (!call) return sendJson(res, 404, { error: `no call #${seq} in the log for ${e.name}` });
    sendJson(res, 200, { name: e.name, call });
  }));

  // Drop an MCP's call history (the panel's "Clear" button).
  r.delete("/api/mcps/:name/calls", authed(async (req, res) => {
    if (!registry.has(req.params.name)) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    await clearCalls(req.params.name);
    sendJson(res, 200, { name: req.params.name, cleared: true });
  }));

  // Edit an MCP's config and restart it. Managed MCPs persist to managed.json; config-file MCPs
  // persist as an override (also managed.json), so the committed gateway.config.json keeps its
  // ${ENV} refs — and because those refs are only expanded when the adapter is built, an override
  // stores the reference rather than the resolved secret.
  r.put("/api/mcps/:name", authed(async (req, res) => {
    const name = req.params.name;
    const e = registry.get(name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${name}` });
    let def: ServerDef;
    try {
      def = buildDef(unmaskBody(req.body ?? {}, e.def));
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    let adapter;
    try {
      adapter = makeAdapter(def, name);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    if (e.source === "config") store.upsertOverride(name, def);
    else store.updateDef(name, def);
    try {
      await registry.updateDef(name, def, adapter);
    } catch (err) {
      return sendJson(res, 500, { error: `restart failed: ${(err as Error).message}` });
    }
    sendJson(res, 200, { name, type: def.type, lifecycle: registry.get(name)?.lifecycle });
  }));

  // Invoke a tool from the panel, so a config can be verified in place ("does SELECT 1 come back?").
  // It goes through this API rather than the browser POSTing the MCP endpoint directly, because that
  // endpoint is bearer-gated and the panel signs in with a username and password — the gateway token
  // should never be handed to the browser.
  r.post("/api/mcps/:name/call", authed(async (req, res) => {
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    if (!e.server) return sendJson(res, 503, { error: `MCP '${req.params.name}' is not started` });
    registry.noteActivity(e.name); // a panel run is traffic — it keeps a lazy proc's child alive
    const tool = String(req.body?.tool ?? "").trim();
    if (!tool) return sendJson(res, 400, { error: "tool is required" });
    const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server;
    const t0 = Date.now();
    try {
      // The call is logged by the tool handler itself; this only tags where it came from, so the
      // Logs tab can tell a panel experiment apart from a real client's request.
      await withCallSource("panel", async () => {
        const client = await openSession(server);
        try {
          const out = (await client.callTool({ name: tool, arguments: args } as never)) as { isError?: boolean };
          sendJson(res, 200, { ok: !out.isError, isError: !!out.isError, ms: Date.now() - t0, text: contentText(out) });
        } finally {
          try { await client.close(); } catch { /* ignore */ }
        }
      });
    } catch (err) {
      // A refused command or a SQL error is the interesting output when testing, so report it as a
      // result rather than as a transport failure.
      sendJson(res, 200, { ok: false, isError: true, ms: Date.now() - t0, text: (err as Error).message });
    }
  }));

  // Read one resource from the panel — the counterpart of the tool runner, for the other primitive.
  // Same reasoning as /call: the browser never holds the gateway token.
  r.post("/api/mcps/:name/resource", authed(async (req, res) => {
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    if (!e.server) return sendJson(res, 503, { error: `MCP '${req.params.name}' is not started` });
    registry.noteActivity(e.name); // reading a resource is traffic too
    const uri = String(req.body?.uri ?? "").trim();
    if (!uri) return sendJson(res, 400, { error: "uri is required" });
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server;
    const t0 = Date.now();
    try {
      await withCallSource("panel", async () => {
        const client = await openSession(server);
        try {
          const out = (await client.readResource({ uri })) as {
            contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
          };
          const text = (out.contents ?? [])
            .map((c) => c.text ?? (c.blob ? `[${Buffer.from(c.blob, "base64").length} bytes of binary]` : ""))
            .join("\n\n");
          sendJson(res, 200, { ok: true, ms: Date.now() - t0, mimeType: out.contents?.[0]?.mimeType, text });
        } finally {
          try { await client.close(); } catch { /* ignore */ }
        }
      });
    } catch (err) {
      // A URI that names nothing is the interesting answer here, not a transport failure.
      sendJson(res, 200, { ok: false, ms: Date.now() - t0, text: (err as Error).message });
    }
  }));

  // Toggle this MCP's resources on or off (all of them — the master switch). Live: the provider
  // answers an empty list while off, the resources capability stays announced so the notify is valid,
  // and notifications/resources/list_changed is pushed to held-open clients so they re-list.
  r.post("/api/mcps/:name/resources-toggle", authed(async (req, res) => {
    const name = req.params.name;
    const e = registry.get(name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${name}` });
    const toggle = e.adapter.resourceToggle;
    if (!toggle) return sendJson(res, 501, { error: `resource toggle is not supported for MCP type '${e.adapter.type}'` });
    const on = req.body?.enabled !== false;
    if (on === toggle.on) {
      sendJson(res, 200, { enabled: on, unchanged: true });
      return;
    }
    toggle.on = on;
    store.setResourceEnabled(name, on);
    e.resPage = undefined; // the cached list no longer matches
    void registry.notifyResourcesChanged(name);
    sendJson(res, 200, { enabled: on });
  }));

  // Toggle one tool on or off. Live: mutates the shared toggle the next makeServer() reads, so the
  // change is visible to the next tools/list with no restart; persisted so it survives one; and
  // pushed as notifications/tools/list_changed to any client holding the GET stream.
  r.post("/api/mcps/:name/tools/:tool", authed(async (req, res) => {
    const name = req.params.name;
    const tool = req.params.tool;
    const e = registry.get(name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${name}` });
    const set = e.adapter.toolToggle?.disabled;
    if (!set) return sendJson(res, 501, { error: `tool toggles are not supported for MCP type '${e.adapter.type}'` });
    const enabled = req.body?.enabled !== false; // absent or true → on; only explicit false → off
    const was = !set.has(tool);
    if (enabled === was) {
      sendJson(res, 200, { tool, enabled, disabledTools: [...set], unchanged: true });
      return;
    }
    // Mutate the shared Set the adapter reads in makeServer — same reference, so the next tools/list
    // already reflects it. Persist the override too (lives in managed.json, so config MCPs keep it).
    if (enabled) set.delete(tool);
    else set.add(tool);
    const disabled = [...set];
    store.setDisabledTools(name, disabled);
    e.toolPage = undefined; // the cached (filtered) list no longer matches
    void registry.notifyToolsChanged(name); // fire-and-forget: the client re-lists when it arrives
    sendJson(res, 200, { tool, enabled, disabledTools: disabled });
  }));

  // Paged tools/resources/prompts via the MCP cursor protocol (see src/paging.ts).
  r.get("/api/mcps/:name/:kind", authed(async (req, res) => {
    const kind = req.params.kind as ListKind;
    if (kind !== "tools" && kind !== "resources" && kind !== "prompts") {
      return sendJson(res, 404, { error: `unknown endpoint: ${req.params.kind}` });
    }
    const e = registry.get(req.params.name);
    if (!e) return sendJson(res, 404, { error: `unknown MCP: ${req.params.name}` });
    if (!e.server) return sendJson(res, 503, { error: `MCP '${req.params.name}' is not started` });
    const cacheField = kind === "tools" ? "toolPage" : kind === "resources" ? "resPage" : "promptPage";
    if (!e[cacheField]) e[cacheField] = newPageCache();
    // A FRESH server per introspection, like the MCP route does. Connecting the shared built server
    // to another transport replaces the one it already holds, so two concurrent readers (two browser
    // tabs on the same MCP) clobbered each other's responses.
    const server = e.adapter.makeServer ? e.adapter.makeServer() : e.server;
    try {
      const client = await openSession(server);
      try {
        const page = await listPage(client, kind, e[cacheField]!, req.query.get("cursor") ?? undefined);
        // The tool list is filtered (disabled tools are absent); surface their names so the panel can
        // show them as rows to re-enable. A disabled tool's description is gone from the live list, but
        // its name is all a toggle row needs. For resources, surface the master on/off so the panel can
        // show the toggle that empties the list.
        const extra = kind === "tools"
          ? { disabledTools: store.disabledTools(req.params.name) }
          : kind === "resources"
            ? { resourceEnabled: e.adapter.resourceToggle ? e.adapter.resourceToggle.on : true }
            : {};
        sendJson(res, 200, { [kind]: page.items, nextCursor: page.nextCursor, total: page.total, pageSize: PAGE_SIZE, ...extra });
      } finally {
        try { await client.close(); } catch { /* ignore */ }
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }));
}
