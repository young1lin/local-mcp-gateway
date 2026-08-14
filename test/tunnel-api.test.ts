import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { makeAdapter } from "../src/adapters/factory.js";
import { TunnelStore } from "../src/tunnels/store.js";
import { TunnelManager, type SshHooksIn, type SshLike } from "../src/tunnels/manager.js";
import { registryView } from "../src/tunnels/mcpmatch.js";
import { probePort } from "../src/tunnels/port.js";
import type { SshConnDef } from "../src/tunnels/types.js";
import { singleTokenManager } from "../src/token.js";

const TOKEN = "tok";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const MASK = "••••••••";

let dir: string;
let store: TunnelStore;
let managed: ManagedStore;
let registry: Registry;
let manager: TunnelManager;
let app: ReturnType<typeof buildApp>;
let echo: Server;
let echoPort = 0;
const liveEchoes = new Set<Socket>();
let built: FakeConn[] = [];

class FakeConn implements SshLike {
  state: SshLike["state"] = "idle";
  reason?: string;
  banner = "SSH-2.0-fake";
  refs = 0;
  constructor(public def: SshConnDef, public hooks: SshHooksIn) { built.push(this); }
  get connected(): boolean { return this.state === "connected"; }
  setDef(def: SshConnDef): void { this.def = def; }
  async connect(): Promise<void> { this.state = "connected"; }
  openChannel(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const s = createConnection({ host, port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }
  async end(): Promise<void> { this.state = "idle"; }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const conn = {
  name: "srv", host: "10.0.0.1", port: 22, username: "deploy",
  authType: "key" as const, keyPath: "C:/keys/id_rsa", passphrase: "secret-phrase",
};

beforeEach(async () => {
  built = [];
  dir = mkdtempSync(join(tmpdir(), "tapi-"));
  store = new TunnelStore(join(dir, "tunnels.json"), 19999);
  managed = new ManagedStore(join(dir, "managed.json"));
  registry = new Registry(1e9);
  manager = new TunnelManager(store, {
    mcps: registryView(registry),
    makeConnection: (def, hooks) => new FakeConn(def, hooks),
  });
  app = buildApp(registry, singleTokenManager(TOKEN), managed, { user: "admin", pass: "admin" }, "MCP_GATEWAY_TOKEN", {
    store, manager,
  });
  echo = createServer((s) => {
    liveEchoes.add(s);
    s.on("close", () => liveEchoes.delete(s));
    s.on("data", (b) => s.write(b.toString("utf8").toUpperCase()));
    s.on("error", () => s.destroy());
  });
  await new Promise<void>((r) => echo.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  await manager.closeAll();
  for (const s of [...liveEchoes]) s.destroy();
  await new Promise<void>((r) => echo.close(() => r()));
  registry.stopTimer();
  rmSync(dir, { recursive: true, force: true });
});

async function addConn(body: Record<string, unknown> = conn) {
  const r = await request(app).post("/api/tunnels/connections").set(AUTH).send(body);
  expect(r.status).toBe(201);
  return r.body.connection as Record<string, unknown>;
}

async function addRule(connectionId: string, extra: Record<string, unknown> = {}) {
  const localPort = (extra.localPort as number) ?? (await freePort());
  const r = await request(app).post("/api/tunnels/rules").set(AUTH)
    .send({ name: "pg", connectionId, localPort, targetHost: "127.0.0.1", targetPort: echoPort, ...extra });
  expect(r.status).toBe(201);
  return r.body.rule as Record<string, any>;
}

describe("auth", () => {
  it("rejects every tunnel route without credentials", async () => {
    for (const [method, path] of [
      ["get", "/api/tunnels"], ["get", "/api/tunnels/keys"], ["post", "/api/tunnels/connections"],
      ["post", "/api/tunnels/start-all"], ["post", "/api/tunnels/stop-all"], ["get", "/api/tunnels/port/1234"],
    ] as const) {
      const r = await (request(app) as never as Record<string, (p: string) => request.Test>)[method](path);
      expect(r.status).toBe(401);
    }
  });

  it("accepts panel credentials as well as the bearer token", async () => {
    const basic = "Basic " + Buffer.from("admin:admin").toString("base64");
    expect((await request(app).get("/api/tunnels").set({ Authorization: basic })).status).toBe(200);
  });
});

describe("connections", () => {
  it("creates one and never sends the passphrase to the browser", async () => {
    const c = await addConn();
    expect(c.passphrase).toBe(MASK);
    expect(c.keyPath).toBe("C:/keys/id_rsa"); // a path is not a secret
    const list = await request(app).get("/api/tunnels").set(AUTH);
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0].state).toBe("idle");
    expect(JSON.stringify(list.body)).not.toContain("secret-phrase");
  });

  it("keeps the stored passphrase when an edit returns the sentinel", async () => {
    const c = await addConn();
    const r = await request(app).put(`/api/tunnels/connections/${c.id}`).set(AUTH)
      .send({ ...conn, username: "renamed", passphrase: MASK });
    expect(r.status).toBe(200);
    expect(store.connection(String(c.id))!.passphrase).toBe("secret-phrase");
    expect(store.connection(String(c.id))!.username).toBe("renamed");
  });

  it("stores a genuinely changed passphrase", async () => {
    const c = await addConn();
    await request(app).put(`/api/tunnels/connections/${c.id}`).set(AUTH)
      .send({ ...conn, passphrase: "new-phrase" }).expect(200);
    expect(store.connection(String(c.id))!.passphrase).toBe("new-phrase");
  });

  it("rejects a bad definition with the reason", async () => {
    const r = await request(app).post("/api/tunnels/connections").set(AUTH).send({ ...conn, host: "" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/host is required/i);
  });

  it("404s an unknown id on update, test and delete", async () => {
    expect((await request(app).put("/api/tunnels/connections/nope").set(AUTH).send(conn)).status).toBe(404);
    expect((await request(app).post("/api/tunnels/connections/nope/test").set(AUTH)).status).toBe(404);
    expect((await request(app).delete("/api/tunnels/connections/nope").set(AUTH)).status).toBe(404);
  });

  it("409s a delete while rules reference it, naming them", async () => {
    const c = await addConn();
    await addRule(String(c.id));
    const r = await request(app).delete(`/api/tunnels/connections/${c.id}`).set(AUTH);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/still used by: pg/);
  });
});

describe("rules", () => {
  it("creates, starts and stops one, freeing the port", async () => {
    const c = await addConn();
    const port = await freePort();
    const rule = await addRule(String(c.id), { localPort: port });
    expect(rule.state).toBe("stopped");

    const started = await request(app).post(`/api/tunnels/rules/${rule.id}/start`).set(AUTH);
    expect(started.status).toBe(200);
    expect(started.body.rule.state).toBe("up");
    expect(await probePort(port)).toBe(false);

    const stopped = await request(app).post(`/api/tunnels/rules/${rule.id}/stop`).set(AUTH);
    expect(stopped.status).toBe(200);
    expect(stopped.body.rule.state).toBe("stopped");
    expect(await probePort(port)).toBe(true);
  });

  it("can create and start in one call", async () => {
    const c = await addConn();
    const port = await freePort();
    const rule = await addRule(String(c.id), { localPort: port, start: true });
    expect(rule.state).toBe("up");
    expect(await probePort(port)).toBe(false);
  });

  it("reports a start failure as a result carrying the port holder, not as a 500", async () => {
    const c = await addConn();
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: "127.0.0.1", exclusive: true }, () => r()));
    try {
      const rule = await addRule(String(c.id), { localPort: port });
      const r = await request(app).post(`/api/tunnels/rules/${rule.id}/start`).set(AUTH);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(r.body.rule.state).toBe("error");
      expect(r.body.rule.portOwner.pid).toBe(process.pid);
      expect(r.body.rule.reason).toMatch(/held by pid/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 25000);

  it("rejects a duplicate local port and the gateway's own port", async () => {
    const c = await addConn();
    const port = await freePort();
    await addRule(String(c.id), { localPort: port });
    const dup = await request(app).post("/api/tunnels/rules").set(AUTH)
      .send({ name: "other", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: 1 });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/already used by 'pg'/);
    const own = await request(app).post("/api/tunnels/rules").set(AUTH)
      .send({ name: "own", connectionId: c.id, localPort: 19999, targetHost: "127.0.0.1", targetPort: 1 });
    expect(own.status).toBe(400);
    expect(own.body.error).toMatch(/gateway's own port/);
  });

  it("edits a running rule onto a new port", async () => {
    const c = await addConn();
    const oldPort = await freePort();
    const newPort = await freePort();
    const rule = await addRule(String(c.id), { localPort: oldPort, start: true });
    const r = await request(app).put(`/api/tunnels/rules/${rule.id}`).set(AUTH)
      .send({ name: "pg", connectionId: c.id, localPort: newPort, targetHost: "127.0.0.1", targetPort: echoPort });
    expect(r.status).toBe(200);
    expect(r.body.rule.state).toBe("up");
    expect(await probePort(oldPort)).toBe(true);
    expect(await probePort(newPort)).toBe(false);
  });

  it("deletes a rule and frees its port", async () => {
    const c = await addConn();
    const port = await freePort();
    const rule = await addRule(String(c.id), { localPort: port, start: true });
    expect((await request(app).delete(`/api/tunnels/rules/${rule.id}`).set(AUTH)).status).toBe(200);
    expect(await probePort(port)).toBe(true);
    expect((await request(app).get("/api/tunnels").set(AUTH)).body.rules).toHaveLength(0);
  });

  it("404s an unknown rule", async () => {
    expect((await request(app).post("/api/tunnels/rules/nope/start").set(AUTH)).status).toBe(404);
    expect((await request(app).post("/api/tunnels/rules/nope/stop").set(AUTH)).status).toBe(404);
    expect((await request(app).delete("/api/tunnels/rules/nope").set(AUTH)).status).toBe(404);
    expect((await request(app).put("/api/tunnels/rules/nope").set(AUTH).send({})).status).toBe(404);
  });

  it("starts and stops everything, reporting per rule", async () => {
    const c = await addConn();
    const ports = [await freePort(), await freePort()];
    for (const p of ports) await addRule(String(c.id), { localPort: p, name: `r${p}` });
    const started = await request(app).post("/api/tunnels/start-all").set(AUTH);
    expect(started.body.results).toHaveLength(2);
    expect(started.body.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    for (const p of ports) expect(await probePort(p)).toBe(false);
    const stopped = await request(app).post("/api/tunnels/stop-all").set(AUTH);
    expect(stopped.body.results).toHaveLength(2);
    for (const p of ports) expect(await probePort(p)).toBe(true);
  });
});

describe("MCP linkage", () => {
  beforeEach(async () => {
    // A real pg MCP pointing at 127.0.0.1:5433 — the shape that makes the suggestion meaningful.
    const def = { type: "pg", url: "postgresql://u:p@127.0.0.1:5433/db" };
    registry.register("pg-analytics", "config", def, makeAdapter(def, "pg-analytics"));
  });

  it("suggests the MCP whose loopback target matches the local port", async () => {
    const r = await request(app).get("/api/tunnels/suggest/5433").set(AUTH);
    expect(r.status).toBe(200);
    expect(r.body.mcps).toEqual(["pg-analytics"]);
    expect((await request(app).get("/api/tunnels/suggest/9999").set(AUTH)).body.mcps).toEqual([]);
    expect((await request(app).get("/api/tunnels/suggest/abc").set(AUTH)).status).toBe(400);
  });

  it("lists the MCPs a rule serves, with their live state", async () => {
    const c = await addConn();
    await addRule(String(c.id), { mcps: ["pg-analytics"] });
    const rows = (await request(app).get("/api/tunnels").set(AUTH)).body.rules;
    expect(rows[0].mcpRows).toEqual([{ name: "pg-analytics", state: "stopped", known: true }]);
  });

  it("shows the dependency on the MCP detail page too", async () => {
    const c = await addConn();
    const port = await freePort();
    await addRule(String(c.id), { localPort: port, mcps: ["pg-analytics"] });
    const d = await request(app).get("/api/mcps/pg-analytics/details").set(AUTH);
    expect(d.status).toBe(200);
    expect(d.body.tunnels).toHaveLength(1);
    expect(d.body.tunnels[0]).toMatchObject({ name: "pg", localPort: port, state: "stopped", stalePool: false });
  });

  it("409s a stop while the linked MCP is started, then obeys force", async () => {
    await registry.start("pg-analytics");
    const c = await addConn();
    const port = await freePort();
    const rule = await addRule(String(c.id), { localPort: port, mcps: ["pg-analytics"], start: true });
    const blocked = await request(app).post(`/api/tunnels/rules/${rule.id}/stop`).set(AUTH);
    expect(blocked.status).toBe(409);
    expect(blocked.body.confirmRequired).toBe(true);
    expect(blocked.body.dependents).toEqual(["pg-analytics"]);
    expect(await probePort(port)).toBe(false); // still up — not stopped behind the user's back

    const forced = await request(app).post(`/api/tunnels/rules/${rule.id}/stop?force=1`).set(AUTH);
    expect(forced.status).toBe(200);
    expect(await probePort(port)).toBe(true);
  });

  it("409s stop-all and a rule delete the same way", async () => {
    await registry.start("pg-analytics");
    const c = await addConn();
    const rule = await addRule(String(c.id), { mcps: ["pg-analytics"], start: true });
    expect((await request(app).post("/api/tunnels/stop-all").set(AUTH)).status).toBe(409);
    const del = await request(app).delete(`/api/tunnels/rules/${rule.id}`).set(AUTH);
    expect(del.status).toBe(409);
    expect(del.body.dependents).toEqual(["pg-analytics"]);
    expect((await request(app).delete(`/api/tunnels/rules/${rule.id}?force=1`).set(AUTH)).status).toBe(200);
  });

  it("carries a link through an MCP rename and drops it on delete", async () => {
    const c = await addConn();
    const rule = await addRule(String(c.id), { mcps: ["pg-analytics"] });
    // pg-analytics is a config MCP, so use a managed one for the rename/delete paths.
    const def = { type: "echo" };
    registry.register("echo-mcp", "managed", def, makeAdapter(def, "echo-mcp"));
    managed.add({ name: "echo-mcp", def, enabled: false });
    await request(app).put(`/api/tunnels/rules/${rule.id}`).set(AUTH)
      .send({ name: "pg", connectionId: c.id, localPort: rule.localPort, targetHost: "127.0.0.1", targetPort: echoPort, mcps: ["echo-mcp"] })
      .expect(200);

    await request(app).post("/api/mcps/echo-mcp/rename").set(AUTH).send({ name: "echo-renamed" }).expect(200);
    expect(store.rule(String(rule.id))!.mcps).toEqual(["echo-renamed"]);

    await request(app).delete("/api/mcps/echo-renamed").set(AUTH).expect(200);
    expect(store.rule(String(rule.id))!.mcps).toEqual([]);
  });
});

describe("ports and keys", () => {
  it("reports a port as free or names its holder", async () => {
    const port = await freePort();
    const free = await request(app).get(`/api/tunnels/port/${port}`).set(AUTH);
    expect(free.body).toMatchObject({ port, free: true, owner: null });

    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: "127.0.0.1", exclusive: true }, () => r()));
    try {
      const taken = await request(app).get(`/api/tunnels/port/${port}`).set(AUTH);
      expect(taken.body.free).toBe(false);
      expect(taken.body.owner.pid).toBe(process.pid);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 25000);

  it("rejects a nonsense port", async () => {
    expect((await request(app).get("/api/tunnels/port/0").set(AUTH)).status).toBe(400);
    expect((await request(app).get("/api/tunnels/port/99999").set(AUTH)).status).toBe(400);
    expect((await request(app).post("/api/tunnels/port/abc/free").set(AUTH)).status).toBe(400);
  });

  it("refuses to force-free a port nobody holds", async () => {
    const port = await freePort();
    const r = await request(app).post(`/api/tunnels/port/${port}/free`).set(AUTH);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/nothing is listening/);
  }, 25000);

  it("offers the keys in ~/.ssh with a default path", async () => {
    const r = await request(app).get("/api/tunnels/keys").set(AUTH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.keys)).toBe(true);
    expect(r.body.defaultPath).toMatch(/[\\/]\.ssh[\\/]id_rsa$/);
    for (const k of r.body.keys) expect(k.name).not.toMatch(/\.pub$/);
  });
});

describe("without a tunnel subsystem", () => {
  it("serves everything it did before, and has no tunnel routes", async () => {
    const plain = buildApp(registry, singleTokenManager(TOKEN), managed, { user: "admin", pass: "admin" });
    expect((await request(plain).get("/health")).status).toBe(200);
    expect((await request(plain).get("/api/mcps").set(AUTH)).status).toBe(200);
    // /api/tunnels is not mounted, so it falls through to the MCP catch-all as an unknown path.
    const r = await request(plain).get("/api/tunnels").set(AUTH);
    expect(r.status).toBe(404);
  });
});
