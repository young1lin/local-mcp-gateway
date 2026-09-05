import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedStore,
  loadManaged,
  loadToolToggles,
  loadResourceToggles,
  loadGroups,
  loadMcpGroups,
  DEFAULT_GROUP,
} from "../src/managed.js";
import { readSecureJson } from "../src/secure/statefile.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "managed-"));
  path = join(dir, "managed.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ManagedStore persistence", () => {
  it("leaves no temp file behind after a successful save", () => {
    const store = new ManagedStore(path);
    store.add({ name: "a", def: { type: "echo" }, enabled: true });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readSecureJson<{ mcps: unknown[] }>(path)!.mcps).toHaveLength(1);
  });

  it("reports a failed save instead of pretending it worked", () => {
    // A path under a directory that does not exist: the write cannot succeed.
    const store = new ManagedStore(join(dir, "missing", "managed.json"));
    expect(() => store.add({ name: "a", def: { type: "echo" }, enabled: true })).toThrow(/could not save/i);
  });

  it("replaces the file only with complete content, so a reader never sees a half-written file", () => {
    const store = new ManagedStore(path);
    store.add({ name: "a", def: { type: "echo" }, enabled: true });
    store.add({ name: "b", def: { type: "echo" }, enabled: false });
    // Whatever is on disk at any moment must parse and hold whole entries.
    expect(loadManaged(path).map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("keeps every mutation durable", () => {
    const store = new ManagedStore(path);
    store.add({ name: "a", def: { type: "echo" }, enabled: true });
    store.rename("a", "b");
    store.setEnabled("b", false);
    store.updateDef("b", { type: "proc", command: "node x.js" });
    const reloaded = loadManaged(path);
    expect(reloaded).toEqual([{ name: "b", def: { type: "proc", command: "node x.js" }, enabled: false, override: false }]);
  });
});

describe("ManagedStore tool toggles", () => {
  it("persists and reloads disabledTools alongside mcps, for any MCP name", () => {
    const store = new ManagedStore(path);
    store.setDisabledTools("mysql", ["mysql_query"]);
    store.setDisabledTools("redis-a-6379", ["redis_scan", "redis_read"]);
    // round-trips through a fresh store
    const reloaded = new ManagedStore(path);
    expect(reloaded.disabledTools("mysql")).toEqual(["mysql_query"]);
    expect(reloaded.disabledTools("redis-a-6379")).toEqual(["redis_scan", "redis_read"]);
    // the file holds both sections
    expect(loadToolToggles(path)).toEqual({ mysql: ["mysql_query"], "redis-a-6379": ["redis_scan", "redis_read"] });
  });

  it("answers [] for an unknown MCP, and drops the key when the list empties", () => {
    const store = new ManagedStore(path);
    expect(store.disabledTools("nope")).toEqual([]);
    store.setDisabledTools("mysql", ["mysql_query"]);
    store.setDisabledTools("mysql", []);
    expect(store.disabledTools("mysql")).toEqual([]);
    // an empty list is not persisted as a key
    expect(loadToolToggles(path)).toEqual({});
  });

  it("ignores a malformed disabledTools section rather than failing to load", () => {
    writeFileSync(path, JSON.stringify({ mcps: [], disabledTools: { mysql: "not-an-array", ok: [1, 2] } }));
    const reloaded = new ManagedStore(path);
    expect(reloaded.disabledTools("mysql")).toEqual([]); // non-array dropped
    expect(reloaded.disabledTools("ok")).toEqual([]); // non-string entries dropped, leaving [] -> treated as none
  });

  it("keeps toggles when an MCP is added or removed", () => {
    const store = new ManagedStore(path);
    store.setDisabledTools("mysql", ["mysql_query"]);
    store.add({ name: "redis", def: { type: "redis" }, enabled: true });
    expect(new ManagedStore(path).disabledTools("mysql")).toEqual(["mysql_query"]);
  });
});

describe("ManagedStore resource toggles", () => {
  it("persists and reloads an explicit on and off", () => {
    const store = new ManagedStore(path);
    store.setResourceEnabled("mysql", false);
    store.setResourceEnabled("redis", true);
    const reloaded = new ManagedStore(path);
    expect(reloaded.resourceEnabled("mysql")).toBe(false);
    expect(reloaded.resourceEnabled("redis")).toBe(true);
    expect(reloaded.resourceEnabled("never-toggled")).toBeUndefined();
    expect(loadResourceToggles(path)).toEqual({ mysql: false, redis: true });
  });

  it("survives alongside tool toggles in the same file", () => {
    const store = new ManagedStore(path);
    store.setDisabledTools("mysql", ["mysql_query"]);
    store.setResourceEnabled("mysql", false);
    const reloaded = new ManagedStore(path);
    expect(reloaded.disabledTools("mysql")).toEqual(["mysql_query"]);
    expect(reloaded.resourceEnabled("mysql")).toBe(false);
  });
});

describe("ManagedStore groups", () => {
  it("puts every MCP in the default group until one is assigned, storing nothing", () => {
    const store = new ManagedStore(path);
    expect(store.getGroups()).toEqual([]);
    expect(store.groupOf("anything")).toBe(DEFAULT_GROUP);
    store.add({ name: "a", def: { type: "echo" }, enabled: true });
    // A file with no groups at all is exactly "everything is in default" — no migration needed.
    const raw = readSecureJson<Record<string, unknown>>(path)!;
    expect(raw.groups).toBeUndefined();
    expect(raw.mcpGroups).toBeUndefined();
  });

  it("persists custom groups in order and reloads them", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Search", "Docs"]);
    expect(new ManagedStore(path).getGroups()).toEqual(["Search", "Docs"]);
    expect(loadGroups(path)).toEqual(["Search", "Docs"]);
  });

  it("assigns an MCP to a group and back to default, keeping the map sparse", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs"]);
    store.setMcpGroup("context7", "Docs");
    expect(store.groupOf("context7")).toBe("Docs");
    expect(loadMcpGroups(path)).toEqual({ context7: "Docs" });

    store.setMcpGroup("context7", null);
    expect(store.groupOf("context7")).toBe(DEFAULT_GROUP);
    // Back in default means "no entry", not an entry saying "default".
    expect(loadMcpGroups(path)).toEqual({});
  });

  it("groups a config-sourced MCP that has no managed entry at all", () => {
    // The whole reason membership is a name-keyed map and not a field on ServerDef: config MCPs
    // never get a ManagedEntry, and they are the ones this user actually has.
    const store = new ManagedStore(path);
    store.setGroups(["Docs"]);
    store.setMcpGroup("context7", "Docs");
    expect(store.all()).toHaveLength(0); // no managed entry was created
    expect(new ManagedStore(path).groupOf("context7")).toBe("Docs");
  });

  it("refuses an unknown group, so a typo cannot strand an MCP", () => {
    const store = new ManagedStore(path);
    expect(() => store.setMcpGroup("a", "Nope")).toThrow(/unknown group/i);
  });

  it("reserves the default name and rejects duplicates, case-insensitively", () => {
    const store = new ManagedStore(path);
    expect(() => store.setGroups(["default"])).toThrow(/reserved/i);
    expect(() => store.setGroups(["DEFAULT"])).toThrow(/reserved/i);
    expect(() => store.setGroups(["Docs", "docs"])).toThrow(/duplicate/i);
    expect(() => store.setGroups([" "])).toThrow(/empty/i);
  });

  it("renames a group and carries its members across", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs", "Search"]);
    store.setMcpGroup("context7", "Docs");
    store.setMcpGroup("deepwiki", "Docs");
    store.renameGroup("Docs", "Reference");

    const reloaded = new ManagedStore(path);
    expect(reloaded.getGroups()).toEqual(["Reference", "Search"]); // order preserved
    expect(reloaded.groupOf("context7")).toBe("Reference");
    expect(reloaded.groupOf("deepwiki")).toBe("Reference");
  });

  it("refuses to rename onto the reserved name or an existing group", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs", "Search"]);
    expect(() => store.renameGroup("Docs", "default")).toThrow(/reserved/i);
    expect(() => store.renameGroup("Docs", "Search")).toThrow(/duplicate/i);
    expect(() => store.renameGroup("Missing", "X")).toThrow(/unknown group/i);
  });

  it("drops a group without deleting its MCPs — they fall back to default", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs"]);
    store.setMcpGroup("context7", "Docs");
    store.removeGroup("Docs");

    const reloaded = new ManagedStore(path);
    expect(reloaded.getGroups()).toEqual([]);
    expect(reloaded.groupOf("context7")).toBe(DEFAULT_GROUP);
    expect(loadMcpGroups(path)).toEqual({});
  });

  it("prunes members of groups dropped by a whole-list setGroups", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs", "Search"]);
    store.setMcpGroup("context7", "Docs");
    store.setMcpGroup("github", "Search");
    store.setGroups(["Search"]); // Docs deleted by omission

    expect(store.groupOf("context7")).toBe(DEFAULT_GROUP);
    expect(store.groupOf("github")).toBe("Search");
    expect(loadMcpGroups(path)).toEqual({ "github": "Search" });
  });

  it("follows an MCP through rename and forgets it on delete, like order does", () => {
    const store = new ManagedStore(path);
    store.setGroups(["Docs"]);
    store.add({ name: "a", def: { type: "echo" }, enabled: true });
    store.setMcpGroup("a", "Docs");

    store.rename("a", "b");
    expect(store.groupOf("b")).toBe("Docs");
    expect(store.groupOf("a")).toBe(DEFAULT_GROUP);

    store.remove("b");
    expect(loadMcpGroups(path)).toEqual({});
  });

  it("treats a member of a group that vanished from the file as default", () => {
    writeFileSync(path, JSON.stringify({ mcps: [], groups: ["Docs"], mcpGroups: { a: "Docs", b: "Ghost" } }));
    const store = new ManagedStore(path);
    expect(store.groupOf("a")).toBe("Docs");
    expect(store.groupOf("b")).toBe(DEFAULT_GROUP);
  });

  it("ignores a malformed groups section rather than failing to load", () => {
    writeFileSync(path, JSON.stringify({ mcps: [], groups: "nope", mcpGroups: { a: 5, b: "Docs" } }));
    const store = new ManagedStore(path);
    expect(store.getGroups()).toEqual([]);
    expect(store.groupOf("a")).toBe(DEFAULT_GROUP); // non-string value dropped
    expect(store.groupOf("b")).toBe(DEFAULT_GROUP); // group list is empty, so Docs is dead
  });

  it("survives alongside order, toggles and tokens in one file", () => {
    const store = new ManagedStore(path);
    store.setOrder(["b", "a"]);
    store.setDisabledTools("a", ["t"]);
    store.setGroups(["Docs"]);
    store.setMcpGroup("a", "Docs");

    const reloaded = new ManagedStore(path);
    expect(reloaded.getOrder()).toEqual(["b", "a"]);
    expect(reloaded.disabledTools("a")).toEqual(["t"]);
    expect(reloaded.getGroups()).toEqual(["Docs"]);
    expect(reloaded.groupOf("a")).toBe("Docs");
  });
});



describe("mcpEnabled — run/stop state for config-sourced MCPs", () => {
  it("persists a Stop on a name with no managed entry, and reads it back after reload", () => {
    const store = new ManagedStore(path);
    store.setEnabled("from-config", false);
    expect(store.enabledFor("from-config")).toBe(false);
    const reloaded = new ManagedStore(path);
    expect(reloaded.enabledFor("from-config")).toBe(false);
    reloaded.setEnabled("from-config", true);
    expect(new ManagedStore(path).enabledFor("from-config")).toBe(true);
  });

  it("defaults to undefined (callers treat it as \"run\") when nothing was recorded", () => {
    const store = new ManagedStore(path);
    expect(store.enabledFor("never-touched")).toBeUndefined();
  });

  it("moves the flag on rename and clears it on remove", () => {
    const store = new ManagedStore(path);
    store.setEnabled("cfg-a", false);
    store.rename("cfg-a", "cfg-b");
    expect(store.enabledFor("cfg-a")).toBeUndefined();
    expect(store.enabledFor("cfg-b")).toBe(false);
    store.remove("cfg-b");
    expect(store.enabledFor("cfg-b")).toBeUndefined();
  });

  it("consumes the flag when the MCP becomes a managed override", () => {
    const store = new ManagedStore(path);
    store.setEnabled("cfg-a", false);
    store.upsertOverride("cfg-a", { type: "echo" });
    expect(store.enabledFor("cfg-a")).toBe(false); // entry.enabled inherited, not reset to true
  });
});
