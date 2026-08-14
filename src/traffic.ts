/**
 * A ring buffer of recent MCP interactions — every JSON-RPC request that crossed the gateway,
 * attributed to the token that sent it and to the client's self-reported name (from `initialize`).
 *
 * This is the "who talked to my MCPs and what did they ask" view that the tool-call log (calls.ts)
 * can't give on its own: it captures initialize / tools/list / resources/list / resources/read too,
 * not just tools/call, and it records the clientInfo a client announces during the handshake.
 *
 * In-memory and bounded: it is for live observation, so it resets on restart. The tool-call log on
 * disk keeps the durable, detailed history of actual tool results.
 */
export interface TrafficEntry {
  seq: number;
  at: string;
  mcp: string;
  method: string;
  /** Token label that authenticated the request (absent for panel calls). */
  client?: string;
  /** Self-reported app name, lifted from initialize params.clientInfo (or server/discover _meta). */
  clientName?: string;
  clientVersion?: string;
  /** Redacted, clipped summary of the request params. */
  params?: string;
  /** The full request message (jsonrpc/id/method/params), redacted, for the expandable raw view. */
  body: string;
  /** The JSON-RPC reply (result/error), redacted + clipped, for the expandable raw view. */
  response?: string;
  ok: boolean;
  ms: number;
}

const KEEP = 500;
/** Matches the tool-call log's page (CALLS_PAGE_SIZE). Both views are one-line-per-row logs you
 *  scan, and 20 rows is about a screen — you page rather than scroll, then page. */
const PAGE_SIZE = 20;
let ring: TrafficEntry[] = [];
let seq = 0;

/**
 * clientInfo is announced only during initialize / server/discover; every later frame (tools/list,
 * resources/read, …) omits it. Without remembering it, one client splits into two rows — the few
 * frames that carried a name, and the rest. So we learn the name a token announced and stamp it onto
 * that token's later frames. Keyed by token: the gateway is stateless HTTP (no session id), and the
 * token is the stable identity we authenticate. (Two different apps sharing one token would collide
 * here — the point of per-client tokens is to keep them apart.)
 */
const knownClient = new Map<string, { name?: string; version?: string }>();

const SECRET_RE = /(password|passwd|secret|token|credential|authorization|api[_-]?key)/i;
const PARAMS_MAX = 512;
/** Cap on the full request body stored for the expandable raw view (keeps the ring + poll small). */
const BODY_MAX = 8 * 1024;
/** Cap on the stored reply (same rationale as BODY_MAX). */
const RESPONSE_MAX = 8 * 1024;

/** Redact any value whose key looks like a secret, recursing into objects/arrays. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_RE.test(k) ? "•••" : redact(v);
    }
    return out;
  }
  return value;
}

function clip(s: string, max = PARAMS_MAX): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Lift clientInfo out of the params, leaving the rest to be logged.
 *
 * Two shapes carry it: `initialize` puts it at the top level (params.clientInfo), while
 * `server/discover` — the capability probe Claude Code sends — nests it under
 * params._meta["io.modelcontextprotocol/clientInfo"]. Without the second path every discover row
 * showed "unknown client" even though the client had just announced itself.
 */
function splitClientInfo(params: unknown): {
  clientName?: string;
  clientVersion?: string;
  rest: unknown;
} {
  if (!params || typeof params !== "object") return { rest: params };
  const obj = params as Record<string, unknown>;
  const out: { clientName?: string; clientVersion?: string; rest: unknown } = { rest: params };

  // initialize: top-level clientInfo.
  if (obj.clientInfo && typeof obj.clientInfo === "object") {
    const ci = obj.clientInfo as { name?: unknown; version?: unknown };
    out.clientName = typeof ci.name === "string" ? ci.name : undefined;
    out.clientVersion = typeof ci.version === "string" ? ci.version : undefined;
    const { clientInfo, ...rest } = obj;
    out.rest = rest;
  }

  // server/discover: clientInfo nested under _meta. Fill only what the top-level path did not.
  const meta = obj._meta;
  if (meta && typeof meta === "object") {
    const dci = (meta as Record<string, unknown>)["io.modelcontextprotocol/clientInfo"];
    if (dci && typeof dci === "object") {
      const ci = dci as { name?: unknown; version?: unknown };
      if (!out.clientName && typeof ci.name === "string") out.clientName = ci.name;
      if (!out.clientVersion && typeof ci.version === "string") out.clientVersion = ci.version;
    }
  }
  return out;
}

/**
 * Reduce the raw HTTP response body to the JSON-RPC reply (result/error) a client received.
 *
 * The two eras frame the reply differently: legacy (2025) answers a POST over an SSE stream, so the
 * JSON-RPC message rides a `data:` line (with progress/logging notifications possibly ahead of it);
 * modern (2026) answers with a single JSON body. Pull the terminal result/error out of either shape,
 * redact it, and clip it — the same treatment the request body gets.
 */
function summarizeResponse(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const dataLines = text
    .split("\n")
    .map((l) => l.match(/^\s*data:\s*(.*)$/))
    .map((m) => (m ? m[1] : null))
    .filter((s): s is string => s !== null);
  const candidates = dataLines.length ? dataLines : [text];
  let chosen: unknown;
  for (const c of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(c);
    } catch {
      continue;
    }
    // Keep the terminal result/error; skip request-related notifications (progress, logging).
    if (obj && typeof obj === "object" && ("result" in (obj as object) || "error" in (obj as object))) {
      chosen = obj;
    }
  }
  if (chosen === undefined) {
    // No parseable JSON-RPC message (a reply too large to capture whole, or a non-JSON body): show
    // the raw text so the view never implies a reply that wasn't inspected.
    const trimmed = text.trim();
    return trimmed ? clip(trimmed, RESPONSE_MAX) : undefined;
  }
  return clip(JSON.stringify(redact(chosen)) ?? "", RESPONSE_MAX);
}

/** Record one JSON-RPC request (or each, when a client sends a batch). No-op for non-MCP bodies. */
export function recordTraffic(
  mcp: string,
  body: unknown,
  client: string | undefined,
  ok: boolean,
  ms: number,
  /** Raw bytes written as the HTTP response (a JSON body or SSE data lines), so the log shows the
   *  reply, not only the request. */
  responseText?: string,
): void {
  const resp = summarizeResponse(responseText);
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    const msg = m as { method?: string; params?: unknown } | null;
    if (!msg || typeof msg.method !== "string") continue;
    const { clientName, clientVersion, rest } = splitClientInfo(msg.params);
    // Remember the name this token announced, so its later (clientInfo-less) frames are attributed.
    if (client && clientName) knownClient.set(client, { name: clientName, version: clientVersion });
    const learned = !clientName && client ? knownClient.get(client) : undefined;
    const name = clientName ?? learned?.name;
    const restObj = rest as Record<string, unknown> | undefined;
    const hasParams = restObj && typeof restObj === "object" && Object.keys(restObj).length > 0;
    const entry: TrafficEntry = {
      seq: ++seq,
      at: new Date().toISOString(),
      mcp,
      method: msg.method,
      ...(client ? { client } : {}),
      ...(name ? { clientName: name, clientVersion: clientVersion ?? learned?.version } : {}),
      ...(hasParams ? { params: clip(JSON.stringify(redact(rest)) ?? "") } : {}),
      body: clip(JSON.stringify(redact(msg)) ?? "", BODY_MAX),
      ...(resp ? { response: resp } : {}),
      ok,
      ms,
    };
    ring.push(entry);
    if (ring.length > KEEP) ring = ring.slice(-KEEP);
  }
}

/** Map a server-event-bus event kind to its notification method name (undefined if not a change event). */
function busEventMethod(kind: string): string | undefined {
  switch (kind) {
    case "tools_list_changed": return "notifications/tools/list_changed";
    case "prompts_list_changed": return "notifications/prompts/list_changed";
    case "resources_list_changed": return "notifications/resources/list_changed";
    case "resource_updated": return "notifications/resources/updated";
  }
  return undefined;
}

/**
 * The unified outlet for server→client notifications on the modern (2026-07-28) protocol: subscribe
 * this to createMcpHandler's `bus`. Every change event the gateway publishes — via the SDK `notify`,
 * which the handler's listenRouter fans out to every active subscriptions/listen stream — is recorded
 * here in one place. Watching the bus (not each notify method, not the transport wire) means a
 * notification kind added later is logged automatically, and the registry stays free of logging.
 *
 * `client` is left unset: a notification is a fan-out to all of an MCP's subscribers, not a reply to a
 * single client, so there is no one client to attribute it to.
 */
export function recordBusEvent(mcp: string, event: { kind: string; uri?: string }): void {
  const method = busEventMethod(event.kind);
  if (!method) return;
  const params = event.uri ? { uri: event.uri } : undefined;
  recordTraffic(mcp, { jsonrpc: "2.0", method, params }, undefined, true, 0);
}

export interface TrafficQuery {
  mcp?: string;
  /** Prefixed client key (`n:claude-code` / `t:default`), the same one clearTraffic takes. */
  client?: string;
  method?: string;
  /** Only the methods a user performs, excluding the protocol handshake. See ACTION_METHODS. */
  actionsOnly?: boolean;
  /** 0-based page of `pageSize`, newest first. */
  page?: number;
  pageSize?: number;
}

/**
 * The methods that represent something a user asked for, as opposed to the protocol scaffolding
 * (initialize, tools/list, notifications/…). The panel defaults to these so a handshake storm does
 * not bury the four calls you came to look at. Server-side because the filter now runs before
 * paging: filtering a page of 50 in the browser can leave a page showing nothing at all.
 */
const ACTION_METHODS = new Set([
  "tools/call", "resources/read", "resources/subscribe", "resources/unsubscribe",
  "prompts/get", "completion/complete", "logging/setLevel",
]);

/** One row of the activity log. Deliberately without `body`/`response` — see readTraffic. */
export type TrafficRow = Omit<TrafficEntry, "body" | "response"> & { hasResponse: boolean };

export interface TrafficPage {
  entries: TrafficRow[];
  /** Rows matching the filter, across every page. */
  total: number;
  /** Rows in the ring before the actions/client filter — the "n of m" readout. */
  totalUnfiltered: number;
  page: number;
  pageSize: number;
  more: boolean;
}

function matches(e: TrafficEntry, q: TrafficQuery): boolean {
  if (q.mcp && e.mcp !== q.mcp) return false;
  if (q.client && clientKeyOf(e) !== q.client) return false;
  if (q.method && e.method !== q.method) return false;
  if (q.actionsOnly && !ACTION_METHODS.has(e.method)) return false;
  return true;
}

/**
 * One newest-first page of interactions.
 *
 * The rows carry no `body`/`response`: each is capped at 8 KB, so a 200-row answer could reach 3 MB
 * — polled every 6 seconds, to render a dozen visible lines whose raw JSON is hidden until you
 * expand one. The panel fetches a single entry's payload from readTrafficEntry when a row is opened,
 * exactly the way the tool-call log fetches a call's output. `hasResponse` survives because the
 * collapsed row says whether a reply was captured.
 */
export function readTraffic(q: TrafficQuery = {}): TrafficPage {
  // `|| 0` also swallows NaN: these come off a query string, and ?page=x must not blank the view.
  const pageSize = Math.max(1, Math.min(Math.floor(Number(q.pageSize)) || PAGE_SIZE, KEEP));
  const page = Math.max(0, Math.floor(Number(q.page)) || 0);
  const all = q.mcp || q.client || q.method || q.actionsOnly
    ? ring.filter((e) => matches(e, q))
    : ring;
  const start = page * pageSize;
  // The ring is oldest-first; the view is newest-first, so a page is taken from the end.
  const end = all.length - start;
  const rows = end <= 0 ? [] : all.slice(Math.max(0, end - pageSize), end).reverse();
  return {
    entries: rows.map(({ body: _b, response, ...rest }) => ({ ...rest, hasResponse: !!response })),
    total: all.length,
    totalUnfiltered: ring.length,
    page,
    pageSize,
    more: Math.max(0, end - pageSize) > 0,
  };
}

/** One entry's raw request and reply, fetched when a row is expanded. */
export function readTrafficEntry(seq: number): { body: string; response?: string } | undefined {
  const e = ring.find((x) => x.seq === seq);
  return e ? { body: e.body, response: e.response } : undefined;
}

/**
 * Every client seen in the ring, folded to one row each — computed over the WHOLE ring, never over
 * the current page. This summary is the answer to "who is talking to my gateway", and a summary
 * derived from page 3 of an actions-only filter would answer a different question each time you
 * paged. Newest-active first.
 */
export function trafficClients(): Array<{
  key: string; label: string; tokens: string[]; mcps: string[];
  count: number; lastAt: string; lastSeq: number;
}> {
  const map = new Map<string, {
    key: string; label: string; tokens: Set<string>; mcps: Set<string>;
    count: number; lastAt: string; lastSeq: number;
  }>();
  for (const e of ring) {
    const key = clientKeyOf(e);
    let c = map.get(key);
    if (!c) {
      const label = e.clientName
        ? e.clientName + (e.clientVersion ? " " + e.clientVersion : "")
        : e.client ? "token " + e.client : "unknown client";
      c = { key, label, tokens: new Set(), mcps: new Set(), count: 0, lastAt: e.at, lastSeq: e.seq };
      map.set(key, c);
    }
    // The label can improve mid-ring: the frames before `initialize` land under "token X", and the
    // handshake then names the client. Take the better one rather than whichever came first.
    if (e.clientName) c.label = e.clientName + (e.clientVersion ? " " + e.clientVersion : "");
    if (e.client) c.tokens.add(e.client);
    c.mcps.add(e.mcp);
    c.count++;
    if (e.seq > c.lastSeq) { c.lastSeq = e.seq; c.lastAt = e.at; }
  }
  return [...map.values()]
    .map((c) => ({ ...c, tokens: [...c.tokens], mcps: [...c.mcps] }))
    .sort((a, b) => b.lastSeq - a.lastSeq);
}

/**
 * The client identity the panel groups rows by — exported so the clear-by-client filter uses the
 * exact same key. Keep in lock-step with `clientKey` in admin.html.
 */
export function clientKeyOf(e: { clientName?: string; client?: string }): string {
  if (e.clientName) return "n:" + e.clientName;
  if (e.client) return "t:" + e.client;
  return "?";
}

/** Drop recorded interactions. With a `clientKey` (the panel's prefixed key, e.g. `n:claude-code` or
 *  `t:default`) only that client's rows are dropped and the rest kept; without it everything is cleared.
 *  (The panel's Clear button clears the selected client when one is filtered, otherwise all.) */
export function clearTraffic(clientKey?: string): void {
  if (clientKey) {
    ring = ring.filter((e) => clientKeyOf(e) !== clientKey);
    return;
  }
  ring = [];
  seq = 0;
  // Intentionally NOT clearing knownClient: "Clear" wipes the log, not the gateway's memory of which
  // token is which client. Forgetting it here would make ongoing traffic drop back to "token X" until
  // the client happens to re-initialize — the split looking like it came back.
}
