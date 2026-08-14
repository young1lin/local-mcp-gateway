import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { buildApp } from "../src/router.js";
import { TokenManager } from "../src/token.js";
import { setShutdownSignal } from "../src/adminapi.js";

const TOKEN = "shutdown-tok";
const registries: Registry[] = [];
let counter = 0;

function setup() {
  const path = join(tmpdir(), `mcp-shutdown-${process.pid}-${counter++}.json`);
  rmSync(path, { force: true });
  const registry = new Registry(60000);
  const store = new ManagedStore(path);
  registries.push(registry);
  return {
    app: buildApp(registry, new TokenManager(store, TOKEN), store),
    auth: { Authorization: `Bearer ${TOKEN}` },
  };
}

afterEach(async () => {
  setShutdownSignal(); // put the real signal back, so no later test can be affected
  await Promise.all(registries.splice(0).map((r) => r.closeAll()));
});

/** Let the server's 'finish' handler run before asserting on it. */
const settle = () => new Promise((r) => setImmediate(r));

describe("POST /api/shutdown", () => {
  it("refuses without the bearer token, and stops nothing", async () => {
    const { app } = setup();
    let raised = 0;
    setShutdownSignal(() => raised++);
    expect((await request(app).post("/api/shutdown")).status).toBe(401);
    await settle();
    expect(raised).toBe(0);
  });

  // Answering in full is the contract: `lmg stop` tells a clean shutdown from a crash by receiving
  // this body, so the teardown must not begin until the response has been written.
  it("answers in full, then raises the shutdown exactly once", async () => {
    const { app, auth } = setup();
    let raised = 0;
    setShutdownSignal(() => raised++);
    const res = await request(app).post("/api/shutdown").set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stopping: true });
    await settle();
    expect(raised).toBe(1);
  });
});
