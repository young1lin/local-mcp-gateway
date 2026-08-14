import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/router.js";
import { Registry, isLazy } from "../src/registry.js";
import { makeAdapter } from "../src/adapters/factory.js";
import { singleTokenManager } from "../src/token.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "fixtures", "stdio-echo.mjs");
const TOKEN = "lazy-test-token";
const ACCEPT = "application/json, text/event-stream";

/** Every registry made here, closed once at the end so a spawned stdio child never leaks past the run. */
const registries: Registry[] = [];

function mcp(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

// The SDK answers a POST with an SSE "data:" stream; parse the data line, fall back to JSON.
function parseMcp(res: request.Response): any {
  if (res.body && typeof res.body === "object" && Object.keys(res.body).length > 0) return res.body;
  const text = res.text as string;
  const m = text.match(/data:\s*(\{[\s\S]*\})/);
  return JSON.parse(m ? m[1] : text);
}

/** A registry holding one lazy proc over the stdio echo fixture, with per-test def overrides. */
function lazyRegistry(over: Record<string, unknown> = {}): Registry {
  const reg = new Registry(60000);
  registries.push(reg);
  const def = { type: "proc", command: `node "${fixture}"`, ...over };
  reg.register("lazyproc", "config", def, makeAdapter(def, "lazyproc"));
  return reg;
}

afterAll(async () => {
  await Promise.all(registries.map((r) => r.closeAll()));
});

/** Wait until the entry is back to idle. A child tree-kill on Windows takes longer than any fixed
 *  sleep worth writing — poll for it instead of guessing. Tests using this carry a raised vitest
 *  timeout: the poll deadline and the default 5s test timeout must not be the same number. */
async function untilIdle(reg: Registry, name = "lazyproc", ms = 12000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (reg.get(name)?.lifecycle === "idle") return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("isLazy", () => {
  it("proc is lazy by default; every other type is not, until lazy:true opts it in", () => {
    expect(isLazy({ type: "proc", command: "x" })).toBe(true);
    expect(isLazy({ type: "proc", command: "x", lazy: true })).toBe(true);
    expect(isLazy({ type: "proc", command: "x", lazy: false })).toBe(false);
    expect(isLazy({ type: "echo" })).toBe(false);
    // lazy:true opts ANY type in — what the panel's "Start automatically" checkbox writes.
    expect(isLazy({ type: "http", url: "https://x.invalid", lazy: true })).toBe(true);
    expect(isLazy({ type: "mysql", lazy: true })).toBe(true);
  });

  it("lazy:true opts any type into idle-at-boot + wake-on-request", async () => {
    const reg = new Registry(60000);
    registries.push(reg);
    reg.register("lazyecho", "config", { type: "echo", lazy: true }, makeAdapter({ type: "echo", lazy: true }, "lazyecho"));
    expect(reg.get("lazyecho")!.lifecycle).toBe("idle");

    const app = buildApp(reg, singleTokenManager(TOKEN));
    const res = await request(app).post("/lazyecho").set("Authorization", `Bearer ${TOKEN}`).set("Accept", ACCEPT)
      .send(mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(res.status).toBe(200);
    expect(reg.get("lazyecho")!.lifecycle).toBe("started");
  });
});

describe("lazy proc lifecycle", () => {
  it("registers idle — no child spawned at registration", () => {
    const reg = lazyRegistry();
    const e = reg.get("lazyproc")!;
    expect(e.lifecycle).toBe("idle");
    expect(e.server).toBeUndefined();
    expect(reg.status()[0].state).toBe("idle");
  });

  it("ensureStarted wakes it; concurrent calls coalesce into ONE spawn", async () => {
    const reg = lazyRegistry();
    await Promise.all([reg.ensureStarted("lazyproc"), reg.ensureStarted("lazyproc")]);
    const e = reg.get("lazyproc")!;
    expect(e.lifecycle).toBe("started");
    expect(e.server).toBeDefined();
    expect(e.gen).toBe(1); // the queue serialized the second call behind the first, which no-op'd
  });

  it("an idle timer stops the child and returns the entry to idle", { timeout: 20000 }, async () => {
    const reg = lazyRegistry({ idleMs: 120 });
    await reg.ensureStarted("lazyproc");
    expect(reg.get("lazyproc")!.lifecycle).toBe("started");
    await untilIdle(reg);
    const e = reg.get("lazyproc")!;
    expect(e.lifecycle).toBe("idle");
    expect(e.server).toBeUndefined();
  });

  it("noteActivity pushes the reaping back", { timeout: 20000 }, async () => {
    const reg = lazyRegistry({ idleMs: 250 });
    await reg.ensureStarted("lazyproc");
    await new Promise((r) => setTimeout(r, 150));
    reg.noteActivity("lazyproc"); // activity resets the deadline…
    await new Promise((r) => setTimeout(r, 150));
    expect(reg.get("lazyproc")!.lifecycle).toBe("started"); // …so the original one did not fire
    await untilIdle(reg); // the pushed-back deadline did fire, and the child was reaped
    expect(reg.get("lazyproc")!.lifecycle).toBe("idle");
  });

  it("idleMs 0 keeps the child once woken", async () => {
    const reg = lazyRegistry({ idleMs: 0 });
    await reg.ensureStarted("lazyproc");
    await new Promise((r) => setTimeout(r, 200));
    expect(reg.get("lazyproc")!.lifecycle).toBe("started");
  });

  it("an explicit stop also lands on idle — a lazy entry's resting state", async () => {
    const reg = lazyRegistry();
    await reg.ensureStarted("lazyproc");
    await reg.stop("lazyproc");
    expect(reg.get("lazyproc")!.lifecycle).toBe("idle");
  });

  it("lazy:false registers stopped — the boot path starts it like today", () => {
    const reg = new Registry(60000);
    registries.push(reg);
    const def = { type: "proc", command: `node "${fixture}"`, lazy: false };
    reg.register("eager", "config", def, makeAdapter(def, "eager"));
    expect(reg.get("eager")!.lifecycle).toBe("stopped");
  });

  it("a non-proc MCP ignores the whole idea — registering an echo is stopped as before", () => {
    const reg = new Registry(60000);
    registries.push(reg);
    reg.register("echo", "config", { type: "echo" }, makeAdapter({ type: "echo" }, "echo"));
    expect(reg.get("echo")!.lifecycle).toBe("stopped");
  });

  // The regression that ate the demo gateway: armIdle used to run for EVERY started entry, so an
  // http MCP and an external adapter were both reaped ten minutes after boot — "where did the
  // tools go?". The reaper belongs to lazy entries only, and nothing else ever arms it.
  it("a non-proc MCP NEVER gets an idle timer, even with idleMs set on it", async () => {
    const reg = new Registry(60000);
    registries.push(reg);
    reg.register("echo", "config", { type: "echo", idleMs: 150 }, makeAdapter({ type: "echo", idleMs: 150 }, "echo"));
    await reg.start("echo");
    await new Promise((r) => setTimeout(r, 400)); // past the deadline a wrongly-armed timer would use
    expect(reg.get("echo")!.lifecycle).toBe("started");
    expect(reg.get("echo")!.server).toBeDefined();
  });
});

describe("router: waking a lazy proc", () => {
  it("a POST to an idle lazy proc waits for the spawn and serves it", async () => {
    const reg = lazyRegistry();
    const app = buildApp(reg, singleTokenManager(TOKEN));
    expect(reg.get("lazyproc")!.lifecycle).toBe("idle");

    const auth = { Authorization: `Bearer ${TOKEN}` };
    const init = await request(app).post("/lazyproc").set(auth).set("Accept", ACCEPT)
      .send(mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.status).toBe(200);
    expect(reg.get("lazyproc")!.lifecycle).toBe("started"); // the request woke it

    const list = await request(app).post("/lazyproc").set(auth).set("Accept", ACCEPT).send(mcp("tools/list"));
    expect(list.status).toBe(200);
    expect(Array.isArray(parseMcp(list).result?.tools)).toBe(true);
  });

  // The legacy-era test above wakes with initialize; a modern (2026-07-28) client's FIRST frame is
  // the server/discover capability probe. The wake trigger is the request, not the method — so the
  // discover probe must wake an idle proc too, and be answered by the freshly spawned child's era.
  it("a 2026-07-28 server/discover probe wakes an idle lazy proc", async () => {
    const reg = lazyRegistry();
    const app = buildApp(reg, singleTokenManager(TOKEN));
    expect(reg.get("lazyproc")!.lifecycle).toBe("idle");

    const res = await request(app).post("/lazyproc")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .set("MCP-Protocol-Version", "2026-07-28")
      .set("Mcp-Method", "server/discover")
      .send({
        jsonrpc: "2.0",
        id: "d1",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
    expect(res.status).toBe(200);
    const body = parseMcp(res);
    expect(body.error).toBeUndefined();
    expect(body.result?.supportedVersions).toContain("2026-07-28");
    expect(reg.get("lazyproc")!.lifecycle).toBe("started"); // the probe woke it
  });
});
