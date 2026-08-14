import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";
import { logged } from "../calls.js";
import { ResourceFault, type ResourceProvider } from "./resources.js";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (an `object` schema). */
  inputSchema: object;
}

/**
 * Output budget for a single tool result. Without one, `KEYS *` or `SELECT * FROM big_table` builds
 * the entire reply in memory and then a JSON copy of it — a reply of 200k redis keys or 50k SQL rows
 * can push RSS from 40 MB to 114 MB, and V8 does not hand that back to the OS promptly. It also floods
 * the client's context, which is the more expensive of the two problems.
 */
export interface RenderLimits {
  /** Max array elements rendered. */
  maxItems: number;
  /** Max serialized bytes. */
  maxBytes: number;
}
export const DEFAULT_LIMITS: RenderLimits = { maxItems: 1000, maxBytes: 256 * 1024 };

/**
 * Results this small stay pretty-printed; anything larger is rendered compact.
 *
 * Indentation is ~25% of a wide SQL row (one newline plus six spaces per column), which buys nothing
 * on a reply that is already too long to read at a glance. Small answers — SELECT 1, a describe, a
 * handful of keys — still arrive formatted.
 */
const PRETTY_MAX = 1024;

/**
 * Cut a string down to a BYTE budget.
 *
 * `String.prototype.slice` counts UTF-16 code units, so cutting at `maxBytes` overshoots the budget
 * threefold on CJK text and can split a surrogate pair, handing the client a lone surrogate — the
 * one thing an output budget exists to prevent. Cut in the buffer instead, backing off any trailing
 * continuation byte (`10xxxxxx`) so the last character is dropped whole rather than replaced by
 * U+FFFD, which would cost three bytes of the room we just made.
 */
function clipBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Buffers serialize as `{"type":"Buffer","data":[...]}`, which is useless to a model — decode them. */
function normalize(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (Array.isArray(v)) return v.map(normalize);
  return v;
}

/**
 * The array a result is mostly made of, so items can be dropped from it.
 *
 * A bare array is its own list, but the SQL adapters return `{ rowCount, rows: [...] }` and redis_scan
 * returns `{ cursor, keys: [...] }` — the list is one level down. Without this, shedding never applied
 * to the shapes that actually get large, and a 200-row `SELECT *` was hard-cut mid-string: the model
 * received JSON it could not parse, which is the one outcome this function exists to prevent.
 */
function listOf(value: unknown): { items: unknown[]; rewrap: (items: unknown[]) => unknown } | undefined {
  if (Array.isArray(value)) return { items: value, rewrap: (items) => items };
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  let key: string | undefined;
  let best = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > best) { key = k; best = v.length; }
  }
  if (!key) return undefined;
  const field = key;
  return {
    items: obj[field] as unknown[],
    // Report the count actually returned, so `rowCount` never contradicts the rows beside it.
    rewrap: (items) => ({
      ...obj,
      [field]: items,
      ...(typeof obj.rowCount === "number" ? { rowCount: items.length } : {}),
    }),
  };
}

/**
 * Serialize a tool result within the given budget, telling the model explicitly when output was
 * dropped and how to narrow it — a silently truncated list reads as a complete one.
 */
export function renderResult(result: unknown, limits: RenderLimits = DEFAULT_LIMITS): string {
  let value = normalize(result);
  const notes: string[] = [];

  if (typeof value === "string") {
    if (Buffer.byteLength(value) <= limits.maxBytes) return value;
    return clipBytes(value, limits.maxBytes) + `\n\n[truncated at ${limits.maxBytes} bytes]`;
  }

  const list = listOf(value);
  const totalItems = list?.items.length ?? 0;

  if (list && totalItems > limits.maxItems) {
    notes.push(`showing the first ${limits.maxItems} of ${totalItems} items`);
    value = list.rewrap(list.items.slice(0, limits.maxItems));
  }

  let text = JSON.stringify(value) ?? String(value);

  // Over budget: drop items until it fits, so the output stays valid JSON rather than being cut
  // mid-token. A result with no list to shed has nothing to give and gets a hard cut.
  if (Buffer.byteLength(text) > limits.maxBytes && list) {
    let items = list.items.slice(0, Math.min(list.items.length, limits.maxItems));
    while (items.length > 1 && Buffer.byteLength(text) > limits.maxBytes) {
      items = items.slice(0, Math.floor(items.length / 2));
      text = JSON.stringify(list.rewrap(items)) ?? text;
    }
    notes.length = 0; // the item count changed — restate it below
    notes.push(`showing ${items.length} of ${totalItems} items (${limits.maxBytes}-byte output budget)`);
    value = list.rewrap(items);
  }

  if (Buffer.byteLength(text) <= PRETTY_MAX) text = JSON.stringify(value, null, 2) ?? text;

  if (Buffer.byteLength(text) > limits.maxBytes) {
    text = clipBytes(text, limits.maxBytes);
    notes.push(`truncated at ${limits.maxBytes} bytes — this is no longer valid JSON`);
  }

  if (!notes.length) return text;
  return `${text}\n\n[${notes.join("; ")}. Narrow the request (SQL LIMIT, a key pattern, SCAN COUNT) to see the rest.]`;
}

/**
 * Wire resources/list, resources/templates/list and resources/read onto a server.
 *
 * A `ResourceFault` — an unknown URI, a cursor that means nothing — becomes `-32602`, which the spec
 * requires for a resource that does not exist. Anything else keeps the SDK's default `-32603`.
 * Reads go through the call log, so the panel's Logs tab shows which schema a client attached.
 */
function mountResources(
  server: Server,
  resources: ResourceProvider,
  meta: ServerMeta,
  limits: RenderLimits,
): void {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ResourceFault) throw new ProtocolError(ProtocolErrorCode.InvalidParams, err.message);
      throw err;
    }
  };

  server.setRequestHandler('resources/list', async (req) =>
    guard(async () => {
      const { resources: list, nextCursor } = await resources.list(req.params?.cursor);
      return { resources: list, ...(nextCursor ? { nextCursor } : {}) };
    }),
  );

  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: resources.templates(),
  }));

  server.setRequestHandler('resources/read', async (req) =>
    logged(
      meta.name,
      "resources/read",
      { uri: req.params.uri },
      () =>
        guard(async () => {
          const bodies = await resources.read(req.params.uri);
          // The same output budget tool results get: an `@` mention drops this straight into a
          // context window, and a resource is no less capable of being enormous than a query is.
          return {
            contents: bodies.map((b) => {
              if (Buffer.byteLength(b.text) <= limits.maxBytes) return b;
              return {
                ...b,
                text: clipBytes(b.text, limits.maxBytes) + `\n\n[truncated at ${limits.maxBytes} bytes]`,
              };
            }),
          };
        }),
      (result) => ({ ok: true, output: result.contents.map((c) => c.text).join("\n") }),
    ),
  );
}

/**
 * Identity of one hosted MCP, so a client can tell same-engine endpoints apart.
 *
 * A gateway can host several instances of the same engine — two Redis caches, two Postgres
 * databases. Without this, every one of them advertises an identical tool set and the only
 * distinguishing information is the path — which says nothing about which application's data is
 * behind it.
 */
export interface ServerMeta {
  /** Registry name of this MCP — the key its call log is filed under. */
  name?: string;
  /** What this MCP is for and which application it serves, from the config's `description`. */
  description?: string;
  /** Where it connects — "app @ localhost:3306", "localhost:6380 db 0". Never a password. */
  target?: string;
  limits?: RenderLimits;
}

/**
 * Build the MCP `instructions` string returned by initialize — the server-level description of what
 * this endpoint is and what it is connected to. This is the one place it belongs: it describes the
 * MCP, so it is stated once per server rather than repeated into every tool's description.
 */
export function buildInstructions(meta: ServerMeta): string | undefined {
  const parts: string[] = [];
  if (meta.description) parts.push(meta.description);
  if (meta.target) parts.push(`Connected to ${meta.target}; every tool here acts on that instance.`);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Build a FRESH in-process MCP Server exposing a fixed set of tools. Used by the direct DB
 * adapters (mysql/redis/pg): there is no child process, just a handler that talks to a shared
 * driver connection. Returned per HTTP request via `Adapter.makeServer` so concurrent requests
 * don't share a single transport-bound Server (the concurrency bug that hung Claude Code).
 *
 * The call handler receives the tool name + args and returns any JSON-serializable value; it is
 * rendered as a single text content block within `limits`. Errors can throw — the SDK surfaces them
 * to the client as a JSON-RPC error with the message.
 *
 * Note: tools deliberately carry no `annotations` (readOnlyHint & co). Claude Code negotiates
 * protocol 2024-11-05 over HTTP, where that key is unknown and strict parsing rejects the whole
 * tools/list. Read-only vs destructive is encoded in the tool name and description instead.
 */
export function makeToolServer(
  tools: ToolDef[],
  call: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>,
  meta: ServerMeta = {},
  resources?: ResourceProvider,
): Server {
  const limits = meta.limits ?? DEFAULT_LIMITS;
  const instructions = buildInstructions(meta);
  const server = new Server(
    { name: "mcp-gateway-direct", version: "1.0" },
    {
      // `tools.listChanged` and `resources.listChanged` are both announced because either can be
      // toggled at runtime, and a held-open client is told to re-list (see Registry.notifyToolsChanged
      // / notifyResourcesChanged). `resources` carries neither `listChanged`'s sibling `subscribe`:
      // that would oblige polling the catalog forever to catch a once-a-day migration, and clients
      // re-list when the user opens the picker anyway.
      capabilities: {
        tools: { listChanged: true },
        ...(resources ? { resources: { listChanged: true } } : {}),
      },
      ...(instructions ? { instructions } : {}),
    },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: tools as Tool[] }));
  if (resources) mountResources(server, resources, meta, limits);
  server.setRequestHandler('tools/call', async (req) =>
    // Logged here rather than in each adapter: this is where the rendered text exists, so the log
    // holds exactly what the caller was sent.
    logged(
      meta.name,
      req.params.name,
      req.params.arguments,
      async () => ({ content: [{ type: "text", text: renderResult(await call(req.params.name, req.params.arguments), limits) }] }),
      (result) => ({ ok: true, output: result.content[0].text }),
    ),
  );
  return server;
}
