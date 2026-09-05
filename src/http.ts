import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Minimal HTTP routing on top of node:http — the whole reason express is not a dependency.
 *
 * express cost ~9.6 MB of RSS (measured) to serve ~15 trivial routes, none of which used anything
 * beyond `:param` matching, a JSON body parser and `res.json`. That is exactly what this file is.
 */

/** Max JSON request body accepted. Above express's old 100kb default because a tool call can carry
 *  a sizeable SQL statement, but still bounded so a bad client can't balloon the heap. */
const BODY_LIMIT = 2 * 1024 * 1024;

export interface Req extends IncomingMessage {
  /** Values captured from the route pattern, already percent-decoded (`/:name` -> `{ name }`). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body; undefined when the request carried no JSON payload. */
  body?: any;
  /** Request path with the query string stripped. */
  path: string;
}
export type Res = ServerResponse;
export interface Handler {
  (req: Req, res: Res): unknown | Promise<unknown>;
  /**
   * Optional synchronous pre-check, run after the route matches but BEFORE the body is read.
   *
   * Auth lives inside the handler, so an unauthenticated caller used to get to push a whole
   * BODY_LIMIT of JSON into the heap and only then be told 401. Anything that can refuse a request
   * from its headers alone belongs here instead. Return the response to send — status and body, so
   * each route keeps its own error shape — or undefined to let the request through to the handler
   * as usual.
   */
  refuse?: (req: IncomingMessage) => { status: number; body: unknown } | undefined;
}

/** Read a single request header, case-insensitively (node lowercases them; arrays only for set-cookie). */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function sendJson(res: Res, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res: Res, status: number, body: string, contentType: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

export function sendEmpty(res: Res, status: number): void {
  if (res.headersSent) return;
  res.writeHead(status);
  res.end();
}

/**
 * Throw away a request body nobody is going to read.
 *
 * Ending a response while the request still has unread data makes node close the connection rather
 * than keep it alive, so a client that gets a run of 404s pays a new TCP handshake for each. Resume
 * rather than destroy: the bytes are discarded as they arrive and nothing is buffered.
 */
function discardBody(req: IncomingMessage): void {
  if (req.readableEnded || req.destroyed) return;
  req.on("error", () => { /* the peer gave up mid-body; there is nothing to report */ });
  req.resume();
}

interface Route {
  method: string;
  /** Pattern split into segments; a segment starting with ':' captures into params. */
  segs: string[];
  handler: Handler;
}

function split(path: string): string[] {
  // "/a/b/" -> ["a","b"]; "/" -> []
  const out: string[] = [];
  for (const s of path.split("/")) if (s) out.push(s);
  return out;
}

/** Match a request's segments against a route pattern, returning captured params or null. */
function match(route: Route, segs: string[]): Record<string, string> | null {
  // A trailing "*" segment (as in "/admin/*") swallows whatever remains, uncaptured — the express
  // suffix wildcard, for static trees whose depth the pattern should not have to know.
  const star = route.segs.length > 0 && route.segs[route.segs.length - 1] === "*";
  if (star ? segs.length < route.segs.length - 1 : route.segs.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const p = route.segs[i];
    if (p === "*") return params; // only reachable as the last segment (see star above)
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(segs[i]);
      } catch {
        params[p.slice(1)] = segs[i]; // malformed escape — hand through raw rather than 400
      }
      continue;
    }
    if (p !== segs[i]) return null;
  }
  return params;
}

/** Collect a JSON body (only when the client actually sent JSON), enforcing BODY_LIMIT. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // Media types are case-insensitive (RFC 7231), and a client is free to send `Application/JSON`.
  // A case-sensitive check dropped the body silently, so the handler saw {} and answered with a
  // confusing complaint about a missing field.
  const type = (header(req, "content-type") ?? "").toLowerCase();
  if (!type.includes("json")) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error(`request body exceeds ${BODY_LIMIT} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body: ${(err as Error).message}`), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Routes are matched in registration order, first match wins — so specific paths must be added
 * before catch-alls (e.g. `/api/mcps/:name/details` before `/:path`), same as express.
 */
export class Router {
  private routes: Route[] = [];
  private guardFn?: (req: IncomingMessage) => string | undefined;

  /**
   * A check every request passes before anything else happens — before route matching, and before the
   * body is read, since a request that is going to be refused should not be listened to. Returning a
   * string refuses it with that reason; returning undefined lets it through.
   *
   * Kept as a hook so this file stays generic plumbing: what counts as an acceptable request is the
   * gateway's policy, and it is installed in buildApp.
   */
  guard(fn: (req: IncomingMessage) => string | undefined): this {
    this.guardFn = fn;
    return this;
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, segs: split(pattern), handler });
    return this;
  }
  get(pattern: string, handler: Handler): this { return this.add("GET", pattern, handler); }
  post(pattern: string, handler: Handler): this { return this.add("POST", pattern, handler); }
  put(pattern: string, handler: Handler): this { return this.add("PUT", pattern, handler); }
  delete(pattern: string, handler: Handler): this { return this.add("DELETE", pattern, handler); }

  /** The node:http request listener. */
  listener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (raw, res) => {
      void this.dispatch(raw, res);
    };
  }

  private async dispatch(raw: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = this.guardFn?.(raw);
    if (refusal) {
      sendJson(res, 403, { error: refusal });
      return;
    }
    const url = raw.url ?? "/";
    const qIdx = url.indexOf("?");
    const path = qIdx < 0 ? url : url.slice(0, qIdx);
    const segs = split(path);
    const method = (raw.method ?? "GET").toUpperCase();

    for (const route of this.routes) {
      // HEAD falls back to the GET handler, as express did: node suppresses the body of a HEAD
      // response by itself, so a handler needs no special case, and `curl -I` or an uptime probe
      // against / or /health gets headers instead of a hard 404.
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
      const params = match(route, segs);
      if (!params) continue;
      const req = raw as Req;
      req.params = params;
      req.query = new URLSearchParams(qIdx < 0 ? "" : url.slice(qIdx + 1));
      req.path = path;
      // Before the body: a request that is going to be refused should not be listened to (see the
      // note on Handler.refuse).
      const refused = route.handler.refuse?.(raw);
      if (refused) {
        discardBody(raw);
        sendJson(res, refused.status, refused.body);
        return;
      }
      try {
        req.body = await readJsonBody(raw);
      } catch (err) {
        sendJson(res, (err as { status?: number }).status ?? 400, { error: (err as Error).message });
        return;
      }
      try {
        await route.handler(req, res);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
        else res.end();
      }
      return;
    }
    // Nothing handled this, so nothing consumed the body. Answering an unread request makes node
    // drop the connection instead of keeping it alive, so drain it first.
    discardBody(raw);
    sendJson(res, 404, { error: `no route for ${method} ${path}` });
  }

  /** Wrap this router in an http.Server (not listening). Kept unstarted so callers — and supertest —
   *  decide the port. */
  server(): Server {
    return createServer(this.listener());
  }
}
