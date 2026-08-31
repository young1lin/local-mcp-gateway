import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createServer, type Server as HttpServer } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { TokenManager } from "../src/token.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { singleTokenManager } from "../src/token.js";

const TOKEN = "test-endpoint-token";
const REMOTE_TOKEN = "remote-echo-token";
let counter = 0;
const paths: string[] = [];
const registries: Registry[] = [];
const closers: Array<() => Promise<void>> = [];

/** A real bearer-gated streamable-HTTP MCP endpoint on an ephemeral port — the same shape the
 *  http-adapter tests use, so the http test path exercises a genuine initialize handshake. */
async function remoteEcho() {
  const reg = new Registry(60000);
  registries.push(reg);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  await reg.start("echo");
  const server: HttpServer = buildApp(reg, singleTokenManager(REMOTE_TOKEN)).listen(0);
  const { port } = server.address() as { port: number };
  closers.push(async () => {
    server.closeAllConnections?.();
    server.close();
  });
  return { url: `http://127.0.0.1:${port}/echo` };
}

function setup() {
  const path = join(tmpdir(), `mcp-conn-test-${process.pid}-${counter++}.json`);
  rmSync(path, { force: true });
  paths.push(path);
  const registry = new Registry(60000);
  registries.push(registry);
  const store = new ManagedStore(path);
  const app = buildApp(registry, new TokenManager(store, TOKEN), store);
  return { app, auth: { Authorization: `Bearer ${TOKEN}` } };
}

afterAll(async () => {
  for (const c of closers) await c();
  await Promise.all(registries.map((r) => r.closeAll()));
  for (const p of paths) rmSync(p, { force: true });
});

describe("POST /api/mcps/test", () => {
  it("runs the test without credentials — /api has no gate beyond the loopback guard", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/mcps/test").send({ type: "mysql", host: "127.0.0.1", port: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false); // the request itself is served; nothing listens on port 1
  });

  it("refuses a type with no connection test, naming the testable ones", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth).send({ type: "proc", command: "x" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/mysql.*redis.*pg.*mongo/);
  });

  it("http: a real initialize handshake — ok with the right key", async () => {
    const remote = await remoteEcho();
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "http", url: remote.url, headers: { Authorization: `Bearer ${REMOTE_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("http: a wrong key fails the handshake honestly", async () => {
    const remote = await remoteEcho();
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "http", url: remote.url, headers: { Authorization: "Bearer not-the-key" } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toBeTruthy();
  });

  it("rest: any HTTP answer from the baseUrl counts as reachable, status included", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no root route");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const { port } = srv.address() as { port: number };
    closers.push(async () => {
      srv.closeAllConnections?.();
      srv.close();
    });
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "rest", baseUrl: `http://127.0.0.1:${port}`, tools: [{ name: "x", request: { method: "GET", path: "/x" } }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(404); // reached; the base path itself need not serve anything
  });

  it("rest: a network failure is a failure, not a 404", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "rest", baseUrl: "http://127.0.0.1:1", tools: [{ name: "x", request: { method: "GET", path: "/x" } }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/fetch|ECONN|refused/i);
  });

  it("reports a refused MySQL honestly, with the driver's own error", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "mysql", host: "127.0.0.1", port: 1, user: "u", password: "p" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/connect|refused|ECONN/i);
  });

  it("reports a refused Redis", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "redis", host: "127.0.0.1", port: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toBeTruthy();
  });

  it("parses a pg URL down to its host and port, and reports the refusal", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "pg", url: "postgresql://u:p@127.0.0.1:1/db" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/connect|refused|ECONN|timeout/i);
  });

  // Mongo's driver can sit in server selection for its own 30s; the endpoint's cap answers first,
  // but the request still costs the full 5s — so this test needs a timeout above vitest's default.
  it("bounds a Mongo target with the 5s cap rather than hanging on server selection", { timeout: 12000 }, async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "mongo", url: "mongodb://127.0.0.1:1/db" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.ms).toBeLessThan(8000);
  });

  it("a malformed def is an honest failure, not a crash", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth).send({ type: "mysql" });
    const honest = res.status === 400 || (res.status === 200 && res.body.ok === false);
    expect(honest).toBe(true);
  });

  // The positive path needs a REAL reachable database. Gated on a dedicated opt-in var, not PG_URL:
  // the repo's test setup loads the developer's own ~/.mcp-gateway/.env, where PG_URL names a
  // database that may exist but not be running — an ambient var must not decide whether this runs.
  it.skipIf(!process.env.LMG_TEST_LIVE_PG_URL)("really connects when the credentials are right", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps/test").set(auth)
      .send({ type: "pg", url: "${LMG_TEST_LIVE_PG_URL}" }); // env ref — expanded server-side, exactly like config
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
