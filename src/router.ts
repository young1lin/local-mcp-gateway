import type { Server as HttpServer } from "node:http";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type Server } from "@modelcontextprotocol/server";
import { bearerSecret } from "./auth.js";
import { log } from "./log.js";
import type { Registry, RegistryEntry } from "./registry.js";
import type { ManagedStore } from "./managed.js";
import type { TokenManager } from "./token.js";
import { recordTraffic, recordBusEvent } from "./traffic.js";
import { withCallClient, currentCallClient } from "./calls.js";
import { makeAuthed, mountAdminApi, type AdminCreds } from "./adminapi.js";
import { mountTunnelApi } from "./tunnels/api.js";
import type { TunnelManager } from "./tunnels/manager.js";
import type { TunnelStore } from "./tunnels/store.js";
import { adminHtml } from "./admin.js";
import { remoteRequestReason } from "./local-only.js";
import { Router, header, sendEmpty, sendJson, sendText, type Handler, type Req, type Res } from "./http.js";

function jsonError(res: Res, status: number, message: string) {
  if (!res.headersSent) {
    sendJson(res, status, { jsonrpc: "2.0", error: { code: -32603, message }, id: null });
    return;
  }
  // Headers already out (the SDK writes them before opening an SSE stream): the error can no longer
  // be reported in-band, but the response still has to be closed — dropping it here left the client
  // holding an open stream until its own timeout. Matches Router.dispatch's own catch-all.
  res.end();
}

/**
 * Capture the bytes written as the HTTP response body (clipped) so the traffic log can record what
 * was answered, not only what was asked. Wraps res.write/res.end transparently; toNodeHandler's write
 * backpressure (it relies on res.write's boolean return) is preserved by forwarding every argument
 * and the original return value unchanged. Returns the captured text once the response is finished.
 */
function captureResponse(res: Res): () => string {
  const chunks: Buffer[] = [];
  let captured = 0;
  const CAP = 16 * 1024; // enough to parse a typical JSON-RPC reply whole; larger replies are previewed
  const push = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || captured >= CAP) return;
    let b: Buffer | null = null;
    if (typeof chunk === "string") b = Buffer.from(chunk);
    else if (Buffer.isBuffer(chunk)) b = chunk;
    else if (chunk instanceof Uint8Array) b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!b) return;
    const take = Math.min(b.length, CAP - captured);
    chunks.push(take === b.length ? b : b.subarray(0, take));
    captured += take;
  };
  const origWrite = res.write;
  const origEnd = res.end;
  res.write = function (this: Res, chunk?: unknown, ...rest: unknown[]) {
    push(chunk);
    return Reflect.apply(origWrite, this, chunk === undefined ? rest : [chunk, ...rest]) as boolean;
  } as Res["write"];
  res.end = function (this: Res, chunk?: unknown, ...rest: unknown[]) {
    push(chunk);
    return Reflect.apply(origEnd, this, chunk === undefined ? rest : [chunk, ...rest]) as Res;
  } as Res["end"];
  return () => Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the gateway HTTP server. MCP endpoints are a catch-all single-segment route resolved
 * dynamically from the registry, so paths can be added/removed at runtime. If a managed store is
 * given, the token-gated management API is mounted under /api.
 *
 * Returns an unstarted http.Server: the caller calls listen(), and tests hand it to supertest.
 */
export function buildApp(
  registry: Registry,
  tokens: TokenManager,
  store?: ManagedStore,
  creds: AdminCreds = { user: "admin", pass: "admin" },
  /** Name of the env var the token was seeded from. Safe to show in client configs. */
  tokenEnv = "MCP_GATEWAY_TOKEN",
  /** SSH tunnels. Optional: without it the gateway serves exactly what it did before. */
  tunnels?: { store: TunnelStore; manager: TunnelManager },
): HttpServer {
  const r = new Router();

  // The boundary: this gateway answers its own machine and nothing else. Installed ahead of every
  // route, so it covers the unauthenticated ones too — the panel at `/` and `/health` have no token
  // in front of them, and this is what stands there instead. See src/local-only.ts for why loopback
  // binding alone is not enough.
  r.guard((req) => {
    const reason = remoteRequestReason(req);
    if (reason) log("warn", "refused a non-local request", { reason, method: req.method, url: req.url });
    return reason;
  });

  /** Every MCP endpoint is bearer-gated against the token set, and answers a rejection in JSON-RPC
   *  shape. The matched token's label is carried across the SDK (via withCallClient) so the call log
   *  and the traffic log can attribute every request to the client that made it. */
  const bearer = (h: Handler): Handler => (req, res) => {
    const rec = tokens.verify(bearerSecret(header(req, "authorization")));
    if (!rec) return jsonError(res, 401, "Unauthorized");
    return withCallClient(rec.label, () => h(req, res));
  };

  /**
   * One createMcpHandler per started MCP, cached by the entry's generation.
   *
   * createMcpHandler serves BOTH protocol eras from a single endpoint: modern (2026-07-28) traffic —
   * including the `server/discover` capability probe clients send before falling back to initialize —
   * over the per-request-envelope path, and legacy 2025-era traffic (initialize, and every request
   * from a client that stayed on the old handshake) over its built-in stateless fallback. The factory
   * returns a fresh per-request Server (Adapter.makeServer), exactly what the old hand-built POST did.
   *
   * Rebuilt when the entry restarts (gen bump): the factory captures the adapter+server at build time,
   * not the mutable entry, so a config edit that swapped the adapter is served by a fresh handler and
   * the old one is close()d (which tears down any in-flight modern exchanges).
   */
  interface EntryHandler {
    gen: number;
    handler: ReturnType<typeof createMcpHandler>;
    node: NodeMcpRequestHandler;
  }
  const handlers = new Map<string, EntryHandler>();

  // Rename/delete abandon an entry's name; the createMcpHandler cached under it would then leak,
  // because the POST path that normally evicts a stale handler (gen mismatch, or a stopped entry) never
  // runs for a name that no longer resolves. The registry calls this back so the handler is closed and
  // dropped — closing it also tears down any subscriptions/listen stream still held on the old name.
  registry.setEvictor((name) => {
    const h = handlers.get(name);
    if (!h) return;
    handlers.delete(name);
    void h.handler.close().catch(() => { /* best effort */ });
  });

  function nodeHandlerFor(entry: RegistryEntry): NodeMcpRequestHandler | undefined {
    if (!entry.server) {
      // Entry is stopped. Drop a handler left over from a previous run so it cannot be reused if the
      // entry restarts under a new adapter before the gen check below runs.
      const stale = handlers.get(entry.name);
      if (stale) { handlers.delete(entry.name); void stale.handler.close().catch(() => {}); }
      return undefined;
    }
    const cached = handlers.get(entry.name);
    if (cached && cached.gen === entry.gen) return cached.node;
    if (cached) void cached.handler.close().catch(() => {}); // superseded by a restart
    const adapter = entry.adapter;
    const builtServer = entry.server;
    const factory = (): Server =>
      // makeServer returns a fresh server for one request (the concurrency fix); adapters without it
      // reuse the single built server (fine when requests are serial).
      adapter.makeServer ? adapter.makeServer() : builtServer;
    const handler = createMcpHandler(factory, {
      legacy: "stateless", // modern path handles server/discover; 2025-era initialize still served
      onerror: (e) => log("warn", "mcp handler error", { name: entry.name, err: e.message }),
    });
    const node = toNodeHandler(handler, {
      onerror: (e) => log("warn", "mcp adapter error", { name: entry.name, err: e.message }),
    });
    handlers.set(entry.name, { gen: entry.gen, handler, node });
    // Expose the SDK notifier so a tool/resource toggle can fan the change out to every active
    // subscriptions/listen stream a 2026-07-28 client holds (see ServerNotifier / notifyToolsChanged).
    registry.setNotifier(entry.name, handler.notify);
    // The unified recording outlet: every change event the notifier publishes onto the handler's bus
    // (fanned to subscribers by the listenRouter) is recorded here in one place — see recordBusEvent.
    handler.bus.subscribe((event) => recordBusEvent(entry.name, event));
    return node;
  }

  // Management dashboard + health (localhost-only; MCP endpoints stay bearer-gated).
  r.get("/", (_req, res) => {
    // no-store: always serve the latest HTML, so editing admin.html needs no gateway restart.
    sendText(res, 200, adminHtml(), "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  });

  r.get("/health", (_req, res) => {
    sendJson(res, 200, { ok: true });
  });

  r.get("/health/check", async (_req, res) => {
    await registry.checkAll();
    sendJson(res, 200, { ok: true });
  });

  if (store) mountAdminApi(r, registry, store, creds, tokens, tokenEnv, tunnels?.manager);
  // Registered before the /:path MCP catch-all, which would otherwise swallow /api/tunnels.
  if (tunnels) {
    mountTunnelApi(r, tunnels.store, tunnels.manager, makeAuthed(creds, tokens), registry);
  }

  // DELETE: session teardown. Stateless → nothing to tear down; acknowledge so the client closes cleanly.
  // (No GET handler: on the 2026-07-28 protocol the gateway serves notifications through the client's
  // subscriptions/listen POST stream, not a standalone GET SSE stream — there is nothing for a GET to
  // open, so it falls through to a 404. A 2025-era client that opened a GET is not supported.)
  r.delete("/:path", bearer((_req, res) => sendEmpty(res, 204)));

  // MCP endpoint: POST /<mcp-name>
  //
  // Served through createMcpHandler so the endpoint answers BOTH eras: the modern per-request-envelope
  // path (native `server/discover`, which previously returned method-not-found and errored in the
  // traffic log) and the legacy 2025-era initialize handshake. toNodeHandler bridges the web-standard
  // handler to node:http. The Router already drained+parsed the JSON body into req.body, so it is
  // passed as parsedBody — otherwise toNodeHandler would re-read an already-consumed Node stream.
  r.post("/:path", bearer(async (req, res) => {
    const t0 = Date.now();
    const name = req.params.path;
    const entry = registry.get(name);
    if (!entry) { jsonError(res, 503, `Unknown MCP path: ${name}`); return; }
    // A lazy proc idle at boot (or reaped since): this request is the wakeup. The await IS the
    // contract — the client's request waits for the spawn and then gets served by it, bounded by
    // the adapter's own start timeout, because AI clients do not retry a 503 helpfully.
    if (entry.lifecycle === "idle") {
      try {
        await registry.ensureStarted(name);
      } catch (err) {
        jsonError(res, 503, `MCP '${name}' failed to start: ${(err as Error).message}`);
        return;
      }
    }
    registry.noteActivity(name); // served traffic pushes a lazy proc's idle-reap deadline back
    const node = nodeHandlerFor(entry);
    if (!node) {
      jsonError(res, 503, `MCP '${name}' is not started (state: ${entry.lifecycle})`);
      return;
    }
    const respText = captureResponse(res);
    try {
      await node(req, res, req.body);
      recordTraffic(name, req.body, currentCallClient(), res.statusCode < 400, Date.now() - t0, respText());
      log("info", "request", { path: name, ms: Date.now() - t0 });
    } catch (err) {
      recordTraffic(name, req.body, currentCallClient(), false, Date.now() - t0, respText());
      log("error", "request failed", { path: name, err: (err as Error).message });
      jsonError(res, 500, (err as Error).message);
    }
  }));

  return r.server();
}
