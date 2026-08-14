import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { buildApp } from "../src/router.js";
import { TokenManager } from "../src/token.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { makeAdapter } from "../src/adapters/factory.js";
import type { ServerDef } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setCallLogDir } from "../src/calls.js";
import { recordBusEvent, recordTraffic } from "../src/traffic.js";

// The call log is on disk; keep this suite out of the repo's logs/ directory.
setCallLogDir(mkdtempSync(join(tmpdir(), "mcp-api-calls-")));

const TOKEN = "admin-tok";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "stdio-echo.mjs");
let counter = 0;
const registries: Registry[] = [];

afterEach(async () => {
  // Kill any spawned proc children so tests don't leak node processes.
  await Promise.all(registries.splice(0).map((r) => r.closeAll()));
});

function setup() {
  const path = join(tmpdir(), `mcp-managed-test-${process.pid}-${counter++}.json`);
  rmSync(path, { force: true });
  const registry = new Registry(60000);
  const store = new ManagedStore(path);
  registries.push(registry);
  const app = buildApp(registry, new TokenManager(store, TOKEN), store);
  const auth = { Authorization: `Bearer ${TOKEN}` };
  return { registry, store, app, auth, path };
}

describe("admin API", () => {
  it("rejects every mutation without the bearer token", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/mcps");
    expect(res.status).toBe(401);
    const add = await request(app).post("/api/mcps").send({ name: "x", command: "node x" });
    expect(add.status).toBe(401);
  });

  it("logs in with admin/admin and accepts Basic auth on /api", async () => {
    const { app } = setup();
    const login = await request(app).post("/api/login").send({ username: "admin", password: "admin" });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);

    const basic = "Basic " + Buffer.from("admin:admin").toString("base64");
    const list = await request(app).get("/api/mcps").set("Authorization", basic);
    expect(list.status).toBe(200);
  });

  it("rejects a wrong password at login", async () => {
    const { app } = setup();
    const login = await request(app).post("/api/login").send({ username: "admin", password: "nope" });
    expect(login.status).toBe(401);
  });

  it("tags each MCP row with how it is launched", async () => {
    const { app, auth, registry } = setup();
    const cases: Array<[string, ServerDef, string]> = [
      ["t-echo", { type: "echo" }, "echo"],
      ["t-http", { type: "http", url: "https://example.invalid/mcp" }, "http"],
      ["t-rest", { type: "rest", baseUrl: "https://example.invalid", tools: [{ name: "x", request: { path: "/x" } }] }, "rest"],
      ["t-npx", { type: "proc", command: "npx -y @some/server" }, "npx"],
      ["t-uvx", { type: "proc", command: "uvx mcp-server-x" }, "uvx"],
      ["t-docker", { type: "proc", command: "docker run -i mcp/x" }, "docker"],
      ["t-cmd", { type: "proc", command: "node server.js" }, "proc"],
      ["t-mysql", { type: "mysql", host: "127.0.0.1" }, "mysql"],
    ];
    for (const [name, def] of cases) registry.register(name, "config", def, makeAdapter(def, name));
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.status).toBe(200);
    for (const [name, , tag] of cases) {
      const row = list.body.mcps.find((m: any) => m.name === name);
      expect(row?.tag, `tag of ${name}`).toBe(tag);
    }
  });

  it("sorts by name until the user arranges the list", async () => {
    const { app, auth, registry } = setup();
    // Registered in an order nobody would choose to look at, to prove registration order is not it.
    for (const n of ["zeta", "mid", "alpha"]) registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.mcps.map((m: any) => m.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("appends MCPs the user has never positioned in name order, after the ones they have", async () => {
    const { app, auth, registry } = setup();
    for (const n of ["a", "zeta", "mid", "alpha"]) registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    await request(app).put("/api/order").set(auth).send({ order: ["zeta", "a"] });
    const list = await request(app).get("/api/mcps").set(auth);
    // The arrangement wins for the two it names; the rest sort among themselves rather than landing
    // wherever the registry started them.
    expect(list.body.mcps.map((m: any) => m.name)).toEqual(["zeta", "a", "alpha", "mid"]);
  });

  it("goes back to name order when the arrangement is cleared", async () => {
    const { app, auth, registry } = setup();
    for (const n of ["b", "c", "a"]) registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    await request(app).put("/api/order").set(auth).send({ order: ["c", "b", "a"] });
    await request(app).put("/api/order").set(auth).send({ order: [] });
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.mcps.map((m: any) => m.name)).toEqual(["a", "b", "c"]);
  });

  it("persists a panel order and lists by it, appending unknown names", async () => {
    const { app, auth, registry, path } = setup();
    for (const n of ["a", "b", "c"]) registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    const put = await request(app).put("/api/order").set(auth).send({ order: ["c", "a"] });
    expect(put.status).toBe(200);
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.mcps.map((m: any) => m.name)).toEqual(["c", "a", "b"]); // b not in the order → appended
    // survives a restart of the store
    expect(new ManagedStore(path).getOrder()).toEqual(["c", "a"]);
  });

  it("rejects a malformed order payload", async () => {
    const { app, auth } = setup();
    const bad = await request(app).put("/api/order").set(auth).send({ order: "c,a" });
    expect(bad.status).toBe(400);
  });

  it("keeps a renamed MCP's position and prunes a deleted one from the order", async () => {
    const { app, auth, registry, store } = setup();
    for (const n of ["a", "b", "c"]) registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    await request(app).put("/api/order").set(auth).send({ order: ["a", "b", "c"] });
    await request(app).post("/api/mcps/a/rename").set(auth).send({ name: "z" });
    expect(store.getOrder()).toEqual(["z", "b", "c"]);
    // a deleted managed MCP leaves the order; config MCPs cannot be deleted, so prune via the store
    store.remove("b");
    expect(store.getOrder()).toEqual(["z", "c"]);
  });

  it("stores and returns a per-MCP proxy on http and rest MCPs", async () => {
    const { app, auth } = setup();
    const add = await request(app).post("/api/mcps").set(auth).send({
      name: "prox-http", type: "http", url: "https://example.invalid/mcp", proxy: "http://127.0.0.1:7890",
    });
    expect(add.status).toBe(201);
    const det = await request(app).get("/api/mcps/prox-http/details").set(auth);
    expect(det.body.config.proxy).toBe("http://127.0.0.1:7890");

    const addRest = await request(app).post("/api/mcps").set(auth).send({
      name: "prox-rest", type: "rest", baseUrl: "https://example.invalid",
      proxy: "${MY_PROXY}",
      tools: [{ name: "x", request: { method: "GET", path: "/x" } }],
    });
    expect(addRest.status).toBe(201);
    const detRest = await request(app).get("/api/mcps/prox-rest/details").set(auth);
    expect(detRest.body.config.proxy).toBe("${MY_PROXY}"); // env ref stays a ref
  });

  it("rejects a proxy that is not an http(s) URL", async () => {
    const { app, auth } = setup();
    const badHttp = await request(app).post("/api/mcps").set(auth).send({
      name: "bad-proxy", type: "http", url: "https://example.invalid/mcp", proxy: "127.0.0.1:7890",
    });
    expect(badHttp.status).toBe(400);
    expect(String(badHttp.body.error)).toMatch(/proxy/i);
    const badRest = await request(app).post("/api/mcps").set(auth).send({
      name: "bad-proxy-rest", type: "rest", baseUrl: "https://example.invalid", proxy: "socks5://x",
      tools: [{ name: "x", request: { method: "GET", path: "/x" } }],
    });
    expect(badRest.status).toBe(400);
    expect(String(badRest.body.error)).toMatch(/proxy/i);
  });

  it("adds a proc MCP, starts it; list is status-only, details load tools + resources", async () => {
    const { app, auth, registry } = setup();
    const add = await request(app).post("/api/mcps").set(auth)
      .send({ name: "echo1", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "echo1" } });
    expect(add.status).toBe(201);
    expect(add.body.lifecycle).toBe("started");

    // The live gateway probes on boot; in the test we trigger a probe explicitly.
    await registry.checkAll();

    // list is light: status only, no tools/resources arrays
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.status).toBe(200);
    const row = list.body.mcps.find((m: any) => m.name === "echo1");
    expect(row.state).toBe("up");
    expect(row.tools).toBeUndefined();
    expect(row.resources).toBeUndefined();

    // tools + resources are paged via the MCP cursor endpoint (not /details)
    const tools = await request(app).get("/api/mcps/echo1/tools").set(auth);
    expect(tools.body.tools.map((t: any) => t.name)).toContain("echo");
    expect(tools.body.nextCursor).toBeUndefined();
    const resources = await request(app).get("/api/mcps/echo1/resources").set(auth);
    expect(resources.body.resources.map((r: any) => r.uri)).toContain("echo://echo1");
    // details now carries logs only
    const d = await request(app).get("/api/mcps/echo1/details").set(auth);
    expect(d.body.tools).toBeUndefined();
    expect(typeof d.body.logs).toBe("string");
  });

  it("forwards MCP traffic to the added server on POST /<name>", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "e2", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "e2" } });
    const A = "application/json, text/event-stream";
    const list = await request(app).post("/e2").set(auth).set("Accept", A)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.status).toBe(200);
  });

  it("tools/resources are paged; details carry logs", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "e3", command: `node "${fixture}"` });
    const t = await request(app).get("/api/mcps/e3/tools").set(auth);
    expect(t.status).toBe(200);
    expect(t.body.tools.map((x: any) => x.name)).toContain("echo");
    const r = await request(app).get("/api/mcps/e3/resources").set(auth);
    expect(r.body.resources.map((x: any) => x.uri)).toContain("echo://stdio-echo");
    const d = await request(app).get("/api/mcps/e3/details").set(auth);
    expect(d.body.tools).toBeUndefined();
    expect(typeof d.body.logs).toBe("string");
  });

  it("exposes the token's env var name, never the token", async () => {
    const { app, auth } = setup();
    const info = await request(app).get("/api/info").set(auth);
    expect(info.status).toBe(200);
    expect(info.body.tokenEnv).toBe("MCP_GATEWAY_TOKEN");
    expect(JSON.stringify(info.body)).not.toContain(TOKEN);
    // and it is gated like everything else under /api
    expect((await request(app).get("/api/info")).status).toBe(401);
  });

  it("lists, creates, revokes and rotates named tokens", async () => {
    const { app, auth, path } = setup();
    // The migrated seed is present as the "default" token, and the list carries no secrets.
    const list0 = await request(app).get("/api/tokens").set(auth);
    expect(list0.status).toBe(200);
    expect(list0.body.tokens.map((t: { label: string }) => t.label)).toContain("default");
    expect(JSON.stringify(list0.body.tokens)).not.toContain(TOKEN);

    // Create a named token; its secret comes back once and authenticates an MCP request.
    const created = await request(app).post("/api/tokens").set(auth).send({ label: "claude-code" });
    expect(created.status).toBe(201);
    expect(created.body.label).toBe("claude-code");
    expect(created.body.secret).toMatch(/^[0-9a-f]{48}$/);
    const id = created.body.id as string;
    const secret = created.body.secret as string;
    expect((await request(app).post("/anything").set("Authorization", `Bearer ${secret}`)).status).toBe(503);

    // Rotate: new secret under the same id; the old one stops working at the gate.
    const rot = await request(app).post(`/api/tokens/${id}/rotate`).set(auth);
    expect(rot.status).toBe(200);
    expect(rot.body.id).toBe(id);
    expect(rot.body.secret).not.toBe(secret);
    expect((await request(app).post("/anything").set("Authorization", `Bearer ${secret}`)).status).toBe(401);
    expect((await request(app).post("/anything").set("Authorization", `Bearer ${rot.body.secret}`)).status).toBe(503);

    // Revoke: gone, no longer authenticates, 404 on a second attempt.
    expect((await request(app).delete(`/api/tokens/${id}`).set(auth)).status).toBe(200);
    expect((await request(app).post("/anything").set("Authorization", `Bearer ${rot.body.secret}`)).status).toBe(401);
    expect((await request(app).delete(`/api/tokens/${id}`).set(auth)).status).toBe(404);

    // Persisted: a fresh read has the default token (the created one was revoked).
    expect(new ManagedStore(path).getTokens().map((t) => t.label)).toEqual(["default"]);
  });

  it("records MCP traffic attributed to the token and the client's self-reported name", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "echo", command: `node "${fixture}"` });
    const init = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1.2.3" } },
    };
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    await request(app).post("/echo").set(bearer).send(init);
    const tr = await request(app).get("/api/traffic").set(auth);
    expect(tr.status).toBe(200);
    const hit = tr.body.entries.find((e: { method: string }) => e.method === "initialize");
    expect(hit).toBeDefined();
    expect(hit.client).toBe("default");       // the token label that authenticated
    expect(hit.clientName).toBe("claude-code"); // self-reported during initialize
    expect(hit.clientVersion).toBe("1.2.3");
  });

  it("attributes a server/discover frame to the client via its _meta.clientInfo", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "echo", command: `node "${fixture}"` });
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    // server/discover (Claude Code's capability probe) carries clientInfo nested in _meta, not at the
    // top level like initialize — splitClientInfo must lift it from there too.
    await request(app).post("/echo").set(bearer).send({
      jsonrpc: "2.0", id: 2, method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.232" } } },
    });
    const tr = await request(app).get("/api/traffic").set(auth);
    const hit = tr.body.entries.find((e: { method: string }) => e.method === "server/discover");
    expect(hit).toBeDefined();
    expect(hit.clientName).toBe("claude-code");
    expect(hit.clientVersion).toBe("2.1.232");
  });

  it("attributes a token's later frames to the name it announced at initialize", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "echo", command: `node "${fixture}"` });
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    // initialize announces the client name once; tools/list after it carries no clientInfo, but it is
    // the same token — so it must inherit "claude-code" rather than appear as an unknown second client.
    await request(app).post("/echo").set(bearer).send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.88" } },
    });
    await request(app).post("/echo").set(bearer).send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tr = await request(app).get("/api/traffic").set(auth);
    const list = tr.body.entries.find((e: { method: string }) => e.method === "tools/list");
    expect(list).toBeDefined();
    expect(list.clientName).toBe("claude-code"); // learned from initialize on the same token
  });

  it("stores the full redacted request body for the expandable raw view", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "echo", command: `node "${fixture}"` });
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    await request(app).post("/echo").set(bearer).send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "echo", arguments: { msg: "hi", password: "shh" } },
    });
    const tr = await request(app).get("/api/traffic").set(auth);
    const hit = tr.body.entries.find((e: { method: string }) => e.method === "tools/call");
    expect(hit).toBeDefined();
    // The list row carries no payload — only the flag the collapsed row needs. The body arrives from
    // the per-entry endpoint when the row is expanded.
    expect(hit.body).toBeUndefined();
    expect(hit.response).toBeUndefined();
    expect(hit.hasResponse).toBe(true);

    const one = await request(app).get(`/api/traffic/${hit.seq}`).set(auth);
    expect(one.status).toBe(200);
    expect(one.body.body).toContain('"method":"tools/call"'); // the whole envelope, not just params
    expect(one.body.body).toContain('"msg":"hi"');
    expect(one.body.body).not.toContain("shh");          // a secret value is never stored
    expect(one.body.body).toContain('"password":"•••"'); // key kept, value redacted
    expect(one.body.response).toContain('"result"');     // the reply is captured too, not only the request
    expect(one.body.response).toContain("stdio-echo:hi"); // the echoed reply text
  });

  it("pages the activity log newest-first and filters to actions server-side", async () => {
    const { app, auth } = setup();
    await request(app).delete("/api/traffic").set(auth);
    // 7 protocol frames + 3 actions, interleaved so a naive slice cannot pass by accident.
    for (let i = 0; i < 10; i++) {
      const action = i % 3 === 2;
      recordTraffic("m", { jsonrpc: "2.0", id: i, method: action ? "tools/call" : "tools/list" }, "pg", true, 1);
    }
    const p0 = await request(app).get("/api/traffic?pageSize=4").set(auth);
    expect(p0.body.entries.length).toBe(4);
    expect(p0.body.total).toBe(10);
    expect(p0.body.more).toBe(true);
    // Newest first, and page 1 continues where page 0 stopped rather than repeating it.
    const seqs0 = p0.body.entries.map((e: { seq: number }) => e.seq);
    expect([...seqs0].sort((a, b) => b - a)).toEqual(seqs0);
    const p1 = await request(app).get("/api/traffic?pageSize=4&page=1").set(auth);
    expect(p1.body.entries.map((e: { seq: number }) => e.seq)).toEqual(seqs0.map((s: number) => s - 4));

    // The last page reports no more, and a page past the end is empty rather than an error.
    const p2 = await request(app).get("/api/traffic?pageSize=4&page=2").set(auth);
    expect(p2.body.entries.length).toBe(2);
    expect(p2.body.more).toBe(false);
    expect((await request(app).get("/api/traffic?pageSize=4&page=9").set(auth)).body.entries).toEqual([]);

    // actions=1 filters BEFORE paging: the count is of matching rows, not of rows on this page.
    const act = await request(app).get("/api/traffic?actions=1").set(auth);
    expect(act.body.entries.every((e: { method: string }) => e.method === "tools/call")).toBe(true);
    expect(act.body.total).toBe(3);
    expect(act.body.totalUnfiltered).toBe(10); // the "3 of 10 interactions" readout
  });

  it("folds clients over the whole ring, not over the returned page", async () => {
    const { app, auth } = setup();
    await request(app).delete("/api/traffic").set(auth);
    recordTraffic("m1", { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "app-a", version: "1" } } }, "ta", true, 1);
    recordTraffic("m2", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "ta", true, 1);
    for (let i = 0; i < 8; i++) {
      recordTraffic("m3", { jsonrpc: "2.0", id: 10 + i, method: "tools/list" }, "tb", true, 1);
    }
    // Page 0 at this size holds only tb's rows; ta must still appear in the summary.
    const r = await request(app).get("/api/traffic?pageSize=3").set(auth);
    expect(r.body.entries.every((e: { client?: string }) => e.client === "tb")).toBe(true);
    const keys = r.body.clients.map((c: { key: string }) => c.key);
    expect(keys).toContain("n:app-a"); // named by its initialize, and its later frames inherit it
    expect(keys).toContain("t:tb");
    const a = r.body.clients.find((c: { key: string }) => c.key === "n:app-a");
    expect(a.label).toBe("app-a 1");
    expect(a.count).toBe(2);                 // both of ta's rows, though neither is on this page
    expect(a.mcps.sort()).toEqual(["m1", "m2"]);
    expect(a.tokens).toEqual(["ta"]);
  });

  it("404s a traffic entry that has rolled out of the ring", async () => {
    const { app, auth } = setup();
    const gone = await request(app).get("/api/traffic/999999").set(auth);
    expect(gone.status).toBe(404);
  });

  it("records each outbound change event from the SDK bus (the unified outlet)", async () => {
    const { app, auth } = setup();
    // recordBusEvent is subscribed to createMcpHandler's bus in the router; drive it directly here.
    recordBusEvent("echo", { kind: "tools_list_changed" });
    recordBusEvent("echo", { kind: "resources_list_changed" });
    recordBusEvent("echo", { kind: "resource_updated", uri: "echo://x" });
    recordBusEvent("echo", { kind: "something_else" }); // not a change event → not recorded

    const tr = await request(app).get("/api/traffic").set(auth);
    const tool = tr.body.entries.find((e: { method: string }) => e.method === "notifications/tools/list_changed");
    expect(tool).toBeDefined();
    expect(tool.mcp).toBe("echo");
    expect(tool.ok).toBe(true);
    expect(tr.body.entries.find((e: { method: string }) => e.method === "notifications/resources/list_changed")).toBeDefined();
    const upd = tr.body.entries.find((e: { method: string }) => e.method === "notifications/resources/updated");
    expect(upd).toBeDefined();
    expect((await request(app).get(`/api/traffic/${upd.seq}`).set(auth)).body.body).toContain("echo://x");
  });

  it("clears one client's traffic via DELETE ?client=, leaving the others intact", async () => {
    const { app, auth } = setup();
    const mine = (e: { client?: string }) => e.client === "clrA" || e.client === "clrB";
    recordTraffic("m", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "clrA", true, 1);
    recordTraffic("m", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "clrB", true, 1);
    const before = (await request(app).get("/api/traffic").set(auth)).body.entries.filter(mine);
    expect(before.length).toBe(2);

    const del = await request(app).delete("/api/traffic?client=t:clrA").set(auth); // the panel's prefixed key
    expect(del.status).toBe(200);
    expect(del.body.client).toBe("t:clrA");
    const after = (await request(app).get("/api/traffic").set(auth)).body.entries.filter(mine);
    expect(after.map((e: { client?: string }) => e.client)).toEqual(["clrB"]); // clrA cleared, clrB kept

    // A bare DELETE (no client) still clears everything.
    await request(app).delete("/api/traffic").set(auth);
    const none = (await request(app).get("/api/traffic").set(auth)).body.entries.filter(mine);
    expect(none).toEqual([]);
  });

  it("fans a tool/resource change out to modern subscribers via the SDK notifier", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "echo", command: `node "${fixture}"` });
    const saw = { tools: 0, res: 0 };
    registry.setNotifier("echo", {
      toolsChanged: () => { saw.tools++; },
      resourcesChanged: () => { saw.res++; },
      promptsChanged: () => {}, resourceUpdated: () => {},
    });
    await registry.notifyToolsChanged("echo");
    await registry.notifyResourcesChanged("echo");
    expect(saw.tools).toBe(1); // SDK notify → every active subscriptions/listen stream (2026-07-28)
    expect(saw.res).toBe(1);
  });

  it("pages the call log and serves one reply in full", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "pg1", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "pg1" } });
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/mcps/pg1/call").set(auth).send({ tool: "echo", arguments: { msg: `m${i}` } });
    }
    const page = await request(app).get("/api/mcps/pg1/calls?page=0").set(auth);
    expect(page.body.calls.length).toBe(3);
    expect(page.body.page).toBe(0);
    expect(page.body.more).toBe(false);
    expect(page.body.calls[0].output).toBe("pg1:m2"); // newest first

    const one = await request(app).get(`/api/mcps/pg1/calls/${page.body.calls[0].seq}`).set(auth);
    expect(one.status).toBe(200);
    expect(one.body.call.output).toBe("pg1:m2");
    expect((await request(app).get("/api/mcps/pg1/calls/9999").set(auth)).status).toBe(404);
  });

  it("records every tool call — arguments, reply and source — and clears on request", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "cl", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "cl" } });

    const empty = await request(app).get("/api/mcps/cl/calls").set(auth);
    expect(empty.status).toBe(200);
    expect(empty.body.calls).toEqual([]);

    // Once through the panel, once as an MCP client on the HTTP endpoint.
    const run = await request(app).post("/api/mcps/cl/call").set(auth).send({ tool: "echo", arguments: { msg: "from-panel" } });
    expect(run.body.text).toBe("cl:from-panel");
    await request(app).post("/cl").set(auth).set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { msg: "from-client" } } });

    const calls = (await request(app).get("/api/mcps/cl/calls").set(auth)).body.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ tool: "echo", ok: true, via: "mcp" });      // newest first
    expect(calls[0].args).toContain("from-client");
    expect(calls[0].output).toBe("cl:from-client");
    expect(calls[1]).toMatchObject({ tool: "echo", via: "panel" });
    expect(typeof calls[0].ms).toBe("number");

    const cleared = await request(app).delete("/api/mcps/cl/calls").set(auth);
    expect(cleared.status).toBe(200);
    expect((await request(app).get("/api/mcps/cl/calls").set(auth)).body.calls).toEqual([]);
  });

  it("edits a managed MCP config and restarts with the new config", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "ed", command: `node "${fixture}"`, env: { MY_ECHO_TAG: "v1" } });
    const put = await request(app).put("/api/mcps/ed").set(auth)
      .send({ command: `node "${fixture}"`, env: { MY_ECHO_TAG: "v2" } });
    expect(put.status).toBe(200);
    expect(put.body.lifecycle).toBe("started");
    const r = await request(app).get("/api/mcps/ed/resources").set(auth);
    expect(r.body.resources.map((x: any) => x.uri)).toContain("echo://v2");
    const d = await request(app).get("/api/mcps/ed/details").set(auth);
    expect(d.body.config.env.MY_ECHO_TAG).toBe("v2");
  });

  it("edits a config-file MCP and persists an override", async () => {
    const { app, auth, registry, store } = setup();
    registry.register("cfg", "config", { type: "echo" }, echoAdapter);
    await registry.start("cfg");
    const put = await request(app).put("/api/mcps/cfg").set(auth).send({ type: "echo" });
    expect(put.status).toBe(200);
    expect(put.body.lifecycle).toBe("started");
    expect(store.has("cfg")).toBe(true); // override persisted to managed.json
  });

  it("lists prompts (paged)", async () => {
    const { app, auth } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "p1", command: `node "${fixture}"` });
    const r = await request(app).get("/api/mcps/p1/prompts").set(auth);
    expect(r.status).toBe(200);
    expect(r.body.prompts.map((x: any) => x.name)).toContain("greet");
  });

  it("stop frees the server; start brings it back", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "e4", command: `node "${fixture}"` });
    const stop = await request(app).post("/api/mcps/e4/stop").set(auth);
    expect(stop.status).toBe(200);
    expect(registry.getServer("e4")).toBeUndefined();

    const start = await request(app).post("/api/mcps/e4/start").set(auth);
    expect(start.status).toBe(200);
    expect(registry.getServer("e4")).toBeDefined();
  });

  it("renames a managed MCP", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "e5", command: `node "${fixture}"` });
    const rn = await request(app).post("/api/mcps/e5/rename").set(auth).send({ name: "e5b" });
    expect(rn.status).toBe(200);
    expect(registry.has("e5")).toBe(false);
    expect(registry.has("e5b")).toBe(true);
  });

  it("deletes a managed MCP and updates the store", async () => {
    const { app, auth, store, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "e6", command: `node "${fixture}"` });
    expect(store.has("e6")).toBe(true);
    const del = await request(app).delete("/api/mcps/e6").set(auth);
    expect(del.status).toBe(200);
    expect(registry.has("e6")).toBe(false);
    expect(store.has("e6")).toBe(false);
  });

  it("persists added MCPs to managed.json", async () => {
    const { app, auth, path } = setup();
    await request(app).post("/api/mcps").set(auth).send({ name: "persist1", command: `node "${fixture}"` });
    const reloaded = new ManagedStore(path).all();
    expect(reloaded.find((m) => m.name === "persist1")).toBeTruthy();
  });

  it("rejects an invalid name and a duplicate", async () => {
    const { app, auth } = setup();
    const bad = await request(app).post("/api/mcps").set(auth).send({ name: "bad name!", command: "node x" });
    expect(bad.status).toBe(400);
    await request(app).post("/api/mcps").set(auth).send({ name: "dup", command: `node "${fixture}"` });
    const dup = await request(app).post("/api/mcps").set(auth).send({ name: "dup", command: "node x" });
    expect(dup.status).toBe(409);
  });

  // Regression: the panel had no cwd field, so buildDef never received one and editing a proc MCP
  // silently dropped it (same for exposeResources/exposePrompts).
  it("keeps cwd and the expose flags across an edit", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({
      name: "keep", command: `node "${fixture}"`, cwd: here, exposeResources: false, exposePrompts: false,
    });
    expect(registry.get("keep")!.def.cwd).toBe(here);
    expect(registry.get("keep")!.def.exposeResources).toBe(false);

    const put = await request(app).put("/api/mcps/keep").set(auth)
      .send({ type: "proc", command: `node "${fixture}"`, cwd: here, exposeResources: false, exposePrompts: false });
    expect(put.status).toBe(200);
    expect(registry.get("keep")!.def.cwd).toBe(here);
    expect(registry.get("keep")!.def.exposeResources).toBe(false);
    expect(registry.get("keep")!.def.exposePrompts).toBe(false);
  });

  // A remote MCP is configured, not launched: url + the headers its key travels in. Registered
  // disabled so the test never reaches for a network.
  it("adds a remote http MCP and never hands its key to the browser", async () => {
    const { app, auth, registry } = setup();
    const add = await request(app).post("/api/mcps").set(auth).send({
      name: "remote",
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "Bearer sk-live-1" },
      enabled: false,
    });
    expect(add.status).toBe(201);
    expect(registry.get("remote")!.def.url).toBe("https://mcp.context7.com/mcp");
    expect((registry.get("remote")!.def.headers as Record<string, string>).Authorization).toBe("Bearer sk-live-1");

    // The key travels in a header, so /details has to mask it there — the panel edits this definition
    // and must never receive the credential (see maskDef's `headers` rule).
    const details = await request(app).get("/api/mcps/remote/details").set(auth);
    expect(details.body.config.headers.Authorization).toBe("••••••••");
    expect(details.body.config.url).toBe("https://mcp.context7.com/mcp");
  });

  // A rest MCP's `tools` is an array of declarations, so buildDef has to keep it whole — without this
  // branch, opening a config-defined rest MCP in the panel and pressing save answers "unknown type".
  it("adds a declared rest MCP and keeps its tool declarations", async () => {
    const { app, auth, registry } = setup();
    const tools = [{
      name: "get_repo",
      description: "Get a public GitHub repo.",
      input: { owner: { type: "string", required: true }, repo: { type: "string", required: true } },
      request: { method: "GET", path: "/repos/{{owner}}/{{repo}}" },
      pick: ["full_name", "description", "stargazers_count"],
    }];
    const add = await request(app).post("/api/mcps").set(auth).send({
      name: "github-rest",
      type: "rest",
      baseUrl: "https://api.github.com",
      headers: { Authorization: "Bearer sk-live-2" },
      tools,
      enabled: false,
    });
    expect(add.status).toBe(201);
    expect(registry.get("github-rest")!.def.tools).toEqual(tools);
    expect(registry.get("github-rest")!.def.baseUrl).toBe("https://api.github.com");

    // Same rule as every other adapter: the key does not go to the browser.
    const details = await request(app).get("/api/mcps/github-rest/details").set(auth);
    expect(details.body.config.headers.Authorization).toBe("••••••••");
  });

  it("rejects a rest MCP with no tools", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps").set(auth)
      .send({ name: "notools", type: "rest", baseUrl: "https://x.test", enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tools/);
  });

  it("rejects an http MCP with no url", async () => {
    const { app, auth } = setup();
    const res = await request(app).post("/api/mcps").set(auth).send({ name: "nourl", type: "http", enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url is required/);
  });

  it("masks secrets in /details and keeps the stored value when the mask is sent back", async () => {
    const { app, auth, registry } = setup();
    const add = await request(app).post("/api/mcps").set(auth).send({
      name: "db", type: "mysql", host: "127.0.0.1", user: "app", password: "hunter2", database: "d", enabled: false,
    });
    expect(add.status).toBe(201);

    const details = await request(app).get("/api/mcps/db/details").set(auth);
    expect(details.body.config.password).not.toBe("hunter2");
    expect(details.body.config.password).toBe("••••••••");
    expect(details.body.config.user).toBe("app"); // non-secret fields are untouched

    // Saving the form unchanged must not overwrite the password with the mask.
    const put = await request(app).put("/api/mcps/db").set(auth)
      .send({ type: "mysql", host: "127.0.0.1", user: "app", password: "••••••••", database: "d" });
    expect(put.status).toBe(200);
    expect(registry.get("db")!.def.password).toBe("hunter2");

    // A real edit still goes through.
    await request(app).put("/api/mcps/db").set(auth)
      .send({ type: "mysql", host: "127.0.0.1", user: "app", password: "newpass", database: "d" });
    expect(registry.get("db")!.def.password).toBe("newpass");
  });

  it("never stores the mask sentinel when the type changes under an edit", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({
      name: "db", type: "mysql", host: "127.0.0.1", user: "app", password: "hunter2", database: "d", enabled: false,
    });
    // The panel's type dropdown can submit a pg url against a def that has no url to restore from.
    // Writing the sentinel through would replace a credential with dots and report success.
    const put = await request(app).put("/api/mcps/db").set(auth)
      .send({ type: "pg", url: "postgresql://u:••••••••@127.0.0.1:5432/d" });
    expect(JSON.stringify(registry.get("db")!.def)).not.toContain("•");
    expect(put.status).toBe(400); // no usable url survived, so the edit is refused out loud
  });

  it("masks only the password inside a connection URL, and restores it on save", async () => {
    const { app, auth, registry } = setup();
    await request(app).post("/api/mcps").set(auth).send({
      name: "pgx", type: "pg", url: "postgresql://chatuser:s3cret@127.0.0.1:5432/chat", enabled: false,
    });
    const details = await request(app).get("/api/mcps/pgx/details").set(auth);
    expect(details.body.config.url).toBe("postgresql://chatuser:••••••••@127.0.0.1:5432/chat");

    await request(app).put("/api/mcps/pgx").set(auth)
      .send({ type: "pg", url: "postgresql://chatuser:••••••••@127.0.0.1:5432/other" });
    expect(registry.get("pgx")!.def.url).toBe("postgresql://chatuser:s3cret@127.0.0.1:5432/other");
  });

  it("reports gateway memory without walking a process tree when nothing was spawned", async () => {
    const { app, auth } = setup();
    const res = await request(app).get("/api/memory").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.gatewayMb).toBeGreaterThan(0);
    expect(res.body.childrenMb).toBe(0);
    expect(res.body.childrenPending).toBe(false);
    expect(res.body.processCount).toBe(1);
  });

  it("refuses to delete a config MCP", async () => {
    const { app, auth, registry } = setup();
    registry.register("cfg", "config", { type: "echo" }, { type: "echo", async build() { throw new Error("x"); } } as any);
    const del = await request(app).delete("/api/mcps/cfg").set(auth);
    expect(del.status).toBe(400);
  });
});

describe("token secrets", () => {
  it("hands a stored secret back, so a connect command needs no rotate", async () => {
    const { app, auth } = setup();
    const made = await request(app).post("/api/tokens").set(auth).send({ label: "claude-code" });
    expect(made.status).toBe(201);

    const got = await request(app).get(`/api/tokens/${made.body.id}/secret`).set(auth);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ id: made.body.id, label: "claude-code", secret: made.body.secret });
  });

  it("keeps secrets out of the list, and off the unauthenticated path", async () => {
    const { app, auth } = setup();
    const made = await request(app).post("/api/tokens").set(auth).send({ label: "a" });

    // The list is what the panel polls; reading a secret stays a separate, explicit request.
    const list = await request(app).get("/api/tokens").set(auth);
    expect(list.body.tokens[0].secret).toBeUndefined();

    const anon = await request(app).get(`/api/tokens/${made.body.id}/secret`);
    expect(anon.status).toBe(401);
  });

  it("404s an unknown token id", async () => {
    const { app, auth } = setup();
    const res = await request(app).get("/api/tokens/nope/secret").set(auth);
    expect(res.status).toBe(404);
  });

  it("returns the new secret after a rotate, not the old one", async () => {
    const { app, auth } = setup();
    const made = await request(app).post("/api/tokens").set(auth).send({ label: "a" });
    const rot = await request(app).post(`/api/tokens/${made.body.id}/rotate`).set(auth);

    const got = await request(app).get(`/api/tokens/${made.body.id}/secret`).set(auth);
    expect(got.body.secret).toBe(rot.body.secret);
    expect(got.body.secret).not.toBe(made.body.secret);
  });
});

describe("sidebar groups", () => {
  /** Three config-sourced MCPs — the case that matters, since those have no managed entry. */
  function withMcps() {
    const s = setup();
    for (const n of ["context7", "deepwiki", "github"]) {
      s.registry.register(n, "config", { type: "echo" }, makeAdapter({ type: "echo" }, n));
    }
    return s;
  }

  it("starts with no groups and every MCP in default", async () => {
    const { app, auth } = withMcps();
    const res = await request(app).get("/api/mcps").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.mcps.map((m: any) => m.group)).toEqual(["default", "default", "default"]);
  });

  it("creates groups and reports them on the list", async () => {
    const { app, auth } = withMcps();
    const put = await request(app).put("/api/groups").set(auth).send({ groups: ["Docs", "Search"] });
    expect(put.status).toBe(200);
    expect(put.body.groups).toEqual(["Docs", "Search"]);

    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.groups).toEqual(["Docs", "Search"]);
  });

  it("rejects a malformed, reserved, duplicate or empty group name", async () => {
    const { app, auth } = withMcps();
    const bad = await request(app).put("/api/groups").set(auth).send({ groups: "Docs" });
    expect(bad.status).toBe(400);

    for (const groups of [["default"], ["DEFAULT"], ["Docs", "docs"], [" "]]) {
      const res = await request(app).put("/api/groups").set(auth).send({ groups });
      expect(res.status).toBe(400);
    }
    // A rejected call must not have half-applied.
    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.groups).toEqual([]);
  });

  it("assigns a config-sourced MCP to a group and back to default", async () => {
    const { app, auth } = withMcps();
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs"] });

    const put = await request(app).put("/api/mcps/context7/group").set(auth).send({ group: "Docs" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ name: "context7", group: "Docs" });

    let list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.mcps.find((m: any) => m.name === "context7").group).toBe("Docs");
    expect(list.body.mcps.find((m: any) => m.name === "deepwiki").group).toBe("default");

    const back = await request(app).put("/api/mcps/context7/group").set(auth).send({ group: null });
    expect(back.status).toBe(200);
    list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.mcps.find((m: any) => m.name === "context7").group).toBe("default");
  });

  it("survives a restart — the assignment is on disk, not in the registry", async () => {
    const { app, auth, path } = withMcps();
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs"] });
    await request(app).put("/api/mcps/context7/group").set(auth).send({ group: "Docs" });

    const reloaded = new ManagedStore(path);
    expect(reloaded.getGroups()).toEqual(["Docs"]);
    expect(reloaded.groupOf("context7")).toBe("Docs");
  });

  it("404s an unknown MCP and 400s an unknown group", async () => {
    const { app, auth } = withMcps();
    const noMcp = await request(app).put("/api/mcps/ghost/group").set(auth).send({ group: null });
    expect(noMcp.status).toBe(404);

    const noGroup = await request(app).put("/api/mcps/context7/group").set(auth).send({ group: "Nope" });
    expect(noGroup.status).toBe(400);
  });

  it("renames a group and carries its members", async () => {
    const { app, auth } = withMcps();
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs", "Search"] });
    await request(app).put("/api/mcps/context7/group").set(auth).send({ group: "Docs" });
    await request(app).put("/api/mcps/deepwiki/group").set(auth).send({ group: "Docs" });

    const ren = await request(app).post("/api/groups/Docs/rename").set(auth).send({ name: "Reference" });
    expect(ren.status).toBe(200);

    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.groups).toEqual(["Reference", "Search"]); // keeps its slot
    expect(list.body.mcps.find((m: any) => m.name === "context7").group).toBe("Reference");
    expect(list.body.mcps.find((m: any) => m.name === "deepwiki").group).toBe("Reference");
  });

  it("refuses a rename onto the reserved name, an existing group, or a group that is not there", async () => {
    const { app, auth } = withMcps();
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs", "Search"] });

    for (const [from, name, status] of [["Docs", "default", 400], ["Docs", "Search", 400], ["Ghost", "X", 404]] as const) {
      const res = await request(app).post(`/api/groups/${from}/rename`).set(auth).send({ name });
      expect(res.status).toBe(status);
    }
  });

  it("deleting a group by omission returns its MCPs to default without deleting them", async () => {
    const { app, auth } = withMcps();
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs", "Search"] });
    await request(app).put("/api/mcps/context7/group").set(auth).send({ group: "Docs" });
    await request(app).put("/api/mcps/github/group").set(auth).send({ group: "Search" });

    await request(app).put("/api/groups").set(auth).send({ groups: ["Search"] });

    const list = await request(app).get("/api/mcps").set(auth);
    expect(list.body.groups).toEqual(["Search"]);
    expect(list.body.mcps).toHaveLength(3); // nothing was deleted
    expect(list.body.mcps.find((m: any) => m.name === "context7").group).toBe("default");
    expect(list.body.mcps.find((m: any) => m.name === "github").group).toBe("Search");
  });

  it("carries an MCP's group through a rename and drops it on delete", async () => {
    const { app, auth, store } = setup();
    const res = await request(app).post("/api/mcps").set(auth).send({ name: "a", type: "echo", enabled: false });
    expect(res.status).toBe(201);
    await request(app).put("/api/groups").set(auth).send({ groups: ["Docs"] });
    await request(app).put("/api/mcps/a/group").set(auth).send({ group: "Docs" });

    await request(app).post("/api/mcps/a/rename").set(auth).send({ name: "b" });
    expect(store.groupOf("b")).toBe("Docs");

    await request(app).delete("/api/mcps/b").set(auth);
    expect(store.getMcpGroups()).toEqual({});
  });
});

describe("request parsing", () => {
  it("parses a JSON body sent with an uppercase Content-Type", async () => {
    const { app, auth } = setup();
    // Media types are case-insensitive per RFC 7231; a case-sensitive check dropped the body, so the
    // handler saw {} and rejected a perfectly valid request with a confusing message.
    const res = await request(app)
      .post("/api/mcps")
      .set(auth)
      .set("Content-Type", "Application/JSON")
      .send(JSON.stringify({ name: "ct", type: "echo", enabled: false }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/mcps/import", () => {
  it("imports stdio and http entries, suffixes collisions, skips this-gateway URLs", async () => {
    const { app, auth, registry } = setup();
    registry.register("redis", "config", { type: "echo" }, echoAdapter);

    const res = await request(app).post("/api/mcps/import").set(auth).send({
      mcpServers: {
        redis: { type: "http", url: "https://example.invalid/a" },
        docs: { type: "http", url: "https://example.invalid/b", headers: { Authorization: "Bearer ${K}" } },
        already: { url: "http://127.0.0.1:19999/mysql" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.imported.map((r: { name: string }) => r.name).sort()).toEqual(["docs", "redis-1"]);
    expect(res.body.skipped.some((s: { name: string }) => s.name === "already")).toBe(true);
    expect(registry.has("redis-1")).toBe(true);
    expect(registry.has("docs")).toBe(true);
  });

  it("rejects import without a token", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/mcps/import").send({ mcpServers: {} });
    expect(res.status).toBe(401);
  });
});
