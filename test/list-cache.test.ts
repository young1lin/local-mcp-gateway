import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ListCache, type ListSnapshot } from "../src/list-cache.js";
import { answerableFromSnapshot, buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { makeAdapter } from "../src/adapters/factory.js";
import { singleTokenManager } from "../src/token.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "fixtures", "stdio-echo.mjs");
const TOKEN = "list-cache-token";
const ACCEPT = "application/json, text/event-stream";
const registries: Registry[] = [];

afterAll(async () => {
  await Promise.all(registries.map((r) => r.closeAll()));
});

function cachePath(): string {
  return join(mkdtempSync(join(tmpdir(), "mcpgw-list-cache-")), "list-cache.json");
}

function mcp(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function parseMcp(res: request.Response): any {
  if (res.body && typeof res.body === "object" && Object.keys(res.body).length > 0) return res.body;
  const m = (res.text as string).match(/data:\s*(\{[\s\S]*\})/);
  return JSON.parse(m ? m[1] : res.text);
}

async function until(check: () => boolean, ms = 12000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const SNAPSHOT: ListSnapshot = { tools: [{ name: "t", inputSchema: { type: "object" } }] };

describe("ListCache", () => {
  it("answers only for the definition the snapshot was taken under", () => {
    const cache = new ListCache(cachePath());
    const def = { type: "proc", command: "node a.js" };
    cache.set("a", def, SNAPSHOT);
    expect(cache.get("a", { ...def })).toEqual(SNAPSHOT);
    expect(cache.get("a", { ...def, command: "node b.js" })).toBeUndefined();
    expect(cache.get("b", def)).toBeUndefined();
  });

  it("still answers once boot has copied the persisted tool toggles onto the definition", () => {
    const cache = new ListCache(cachePath());
    const added = { type: "proc", command: "node a.js" };
    cache.set("a", added, SNAPSHOT);
    expect(cache.get("a", { ...added, disabledTools: [] })).toEqual(SNAPSHOT);
    expect(cache.get("a", { ...added, disabledTools: ["t"] })).toEqual(SNAPSHOT);
  });

  it("survives a restart, follows a rename and forgets a delete", () => {
    const path = cachePath();
    const def = { type: "proc", command: "node a.js" };
    new ListCache(path).set("a", def, SNAPSHOT);
    const reopened = new ListCache(path);
    expect(reopened.get("a", def)).toEqual(SNAPSHOT);
    reopened.rename("a", "b");
    expect(new ListCache(path).get("b", def)).toEqual(SNAPSHOT);
    reopened.delete("b");
    expect(new ListCache(path).get("b", def)).toBeUndefined();
  });
});

describe("answerableFromSnapshot", () => {
  it("takes the handshake and uncursored lists, alone or batched", () => {
    expect(answerableFromSnapshot(mcp("initialize"))).toBe(true);
    expect(answerableFromSnapshot({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(answerableFromSnapshot([mcp("tools/list"), mcp("prompts/list", {}, 2)])).toBe(true);
  });

  it("refuses anything that needs the child", () => {
    expect(answerableFromSnapshot(mcp("tools/call", { name: "echo" }))).toBe(false);
    expect(answerableFromSnapshot(mcp("tools/list", { cursor: "page-2" }))).toBe(false);
    expect(answerableFromSnapshot(mcp("resources/templates/list"))).toBe(false); // the proxy has no handler
    expect(answerableFromSnapshot([mcp("tools/list"), mcp("resources/read", { uri: "x" }, 2)])).toBe(false);
    expect(answerableFromSnapshot([])).toBe(false);
    expect(answerableFromSnapshot(undefined)).toBe(false);
  });
});

describe("an idle lazy proc with a cached snapshot", () => {
  it("answers the handshake and lists without spawning, and spawns for the first call", { timeout: 60000 }, async () => {
    const reg = new Registry(60000, new ListCache(cachePath()));
    registries.push(reg);
    const def = { type: "proc", command: `node "${fixture}"`, idleMs: 0 };
    reg.register("lp", "config", def, makeAdapter(def, "lp"));
    const app = buildApp(reg, singleTokenManager(TOKEN));
    const post = (body: unknown) =>
      request(app).post("/lp").set("Authorization", `Bearer ${TOKEN}`).set("Accept", ACCEPT).send(body as object);

    // No snapshot yet: the first list wakes the child, as before, and the start records one.
    expect(parseMcp(await post(mcp("tools/list"))).result.tools.map((t: any) => t.name)).toEqual(["echo"]);
    await until(() => reg.cachedLists("lp") !== undefined);
    expect(reg.cachedLists("lp")?.tools.map((t) => t.name)).toEqual(["echo"]);
    await reg.stop("lp");
    expect(reg.get("lp")!.lifecycle).toBe("idle");
    expect(reg.childPids()).toEqual([]);

    // Idle again: handshake and lists come from the snapshot — no child.
    const init = await post(mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(init.status).toBe(200);
    expect(parseMcp(init).result.capabilities.tools).toBeDefined();
    expect(parseMcp(await post(mcp("tools/list"))).result.tools.map((t: any) => t.name)).toEqual(["echo"]);
    expect(parseMcp(await post(mcp("prompts/list"))).result.prompts.map((p: any) => p.name)).toEqual(["greet"]);
    expect(parseMcp(await post(mcp("resources/list"))).result.resources.map((r: any) => r.uri)).toEqual(["echo://stdio-echo"]);
    expect(reg.get("lp")!.lifecycle).toBe("idle");
    expect(reg.childPids()).toEqual([]);

    // The first real call spawns the child and is served by it.
    const call = await post(mcp("tools/call", { name: "echo", arguments: { msg: "hi" } }));
    expect(parseMcp(call).result.content[0].text).toBe("stdio-echo:hi");
    expect(reg.get("lp")!.lifecycle).toBe("started");
  });

  it("notifies a tools change only when a start finds lists that differ from the snapshot", { timeout: 60000 }, async () => {
    class CountingCache extends ListCache {
      sets = 0;
      override set(name: string, def: Parameters<ListCache["set"]>[1], snapshot: ListSnapshot): void {
        super.set(name, def, snapshot);
        this.sets++;
      }
    }
    const cache = new CountingCache(cachePath());
    const def = { type: "proc", command: `node "${fixture}"`, idleMs: 0 };
    cache.set("lp", def, SNAPSHOT); // a stale snapshot: the child now answers "echo", not "t"
    const reg = new Registry(60000, cache);
    registries.push(reg);
    reg.register("lp", "config", def, makeAdapter(def, "lp"));
    let toolsChanged = 0;
    const notifier = {
      toolsChanged: () => {
        toolsChanged++;
        throw new Error("a failing notifier must not break the start");
      },
      promptsChanged: () => {},
      resourcesChanged: () => {},
      resourceUpdated: () => {},
    };

    reg.setNotifier("lp", notifier);
    await reg.start("lp");
    await until(() => cache.sets === 2);
    expect(reg.cachedLists("lp")?.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(toolsChanged).toBe(1);

    // The same lists again: the snapshot is refreshed, nobody is told to re-list.
    await reg.stop("lp");
    reg.setNotifier("lp", notifier);
    await reg.start("lp");
    await until(() => cache.sets === 3);
    expect(cache.sets).toBe(3);
    expect(toolsChanged).toBe(1);
  });

  it("wakes the child again once the definition changed", { timeout: 60000 }, async () => {
    const reg = new Registry(60000, new ListCache(cachePath()));
    registries.push(reg);
    const def = { type: "proc", command: `node "${fixture}"`, idleMs: 0 };
    reg.register("lp", "config", def, makeAdapter(def, "lp"));
    await reg.start("lp");
    await until(() => reg.cachedLists("lp") !== undefined);
    const edited = { ...def, env: { MY_ECHO_TAG: "edited" } };
    await reg.updateDef("lp", edited, makeAdapter(edited, "lp"), { start: false });
    expect(reg.get("lp")!.lifecycle).toBe("idle");
    expect(reg.cachedLists("lp")).toBeUndefined();

    const app = buildApp(reg, singleTokenManager(TOKEN));
    const res = await request(app).post("/lp").set("Authorization", `Bearer ${TOKEN}`).set("Accept", ACCEPT)
      .send(mcp("resources/list"));
    expect(parseMcp(res).result.resources.map((r: any) => r.uri)).toEqual(["echo://edited"]);
    expect(reg.get("lp")!.lifecycle).toBe("started");
  });
});
