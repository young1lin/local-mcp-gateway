import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelStore } from "../src/tunnels/store.js";
import { importForwardPort } from "../src/tunnels/import.js";

let dir: string;
let store: TunnelStore;
let src: string;

// A trimmed copy of the real %APPDATA%\forward-port\config.json shape.
const legacy = {
  connections: [
    { id: "c-1", name: "test-server", host: "203.0.113.10", port: 22, username: "deploy", auth_type: "key", key_path: "~/.ssh/id_rsa" },
    { id: "c-2", name: "im-server", host: "198.51.100.10", port: 22, username: "deploy", auth_type: "password", password: "s3cret" },
  ],
  tunnels: [
    { id: "t-1", name: "test-server-pgsql", local_port: 5433, connection_id: "c-1", target_host: "127.0.0.1", target_port: 5432, remark: "test-server pgsql", auto_reconnect: false, reconnect_interval: 10 },
    { id: "t-2", name: "im-server-redis", local_port: 6380, connection_id: "c-2", target_host: "127.0.0.1", target_port: 6379, remark: "", auto_reconnect: true, reconnect_interval: 15 },
    { id: "t-3", name: "orphan", local_port: 9999, connection_id: "gone", target_host: "127.0.0.1", target_port: 9999 },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-"));
  store = new TunnelStore(join(dir, "tunnels.json"));
  src = join(dir, "config.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("importForwardPort", () => {
  it("maps snake_case to camelCase and keeps the original ids", () => {
    writeFileSync(src, JSON.stringify(legacy));
    expect(importForwardPort(store, src)).toEqual({ connections: 2, rules: 2 });
    const c = store.connections();
    expect(c.map((x) => x.id)).toEqual(["c-1", "c-2"]);
    expect(c[0]).toMatchObject({ authType: "key", keyPath: "~/.ssh/id_rsa" });
    expect(c[1]).toMatchObject({ authType: "password", password: "s3cret" });
    const r = store.rules();
    expect(r[0]).toMatchObject({
      id: "t-1", name: "test-server-pgsql", connectionId: "c-1",
      localPort: 5433, targetHost: "127.0.0.1", targetPort: 5432,
      remark: "test-server pgsql", autoReconnect: false, reconnectInterval: 10,
    });
    expect(r[1]).toMatchObject({ autoReconnect: true, reconnectInterval: 15 });
  });

  it("imports every rule stopped, with no MCP links", () => {
    writeFileSync(src, JSON.stringify(legacy));
    importForwardPort(store, src);
    expect(store.rules().every((r) => r.enabled === false)).toBe(true);
    expect(store.rules().every((r) => r.mcps.length === 0)).toBe(true);
  });

  it("drops a rule whose connection is absent from the same file", () => {
    writeFileSync(src, JSON.stringify(legacy));
    importForwardPort(store, src);
    expect(store.rules().map((r) => r.name)).not.toContain("orphan");
  });

  it("skips a duplicate local port rather than failing the whole import", () => {
    writeFileSync(src, JSON.stringify({
      connections: legacy.connections,
      tunnels: [legacy.tunnels[0], { ...legacy.tunnels[0], id: "t-dup", name: "dup" }],
    }));
    expect(importForwardPort(store, src)).toEqual({ connections: 2, rules: 1 });
    expect(store.rules().map((r) => r.name)).toEqual(["test-server-pgsql"]);
  });

  it("is a no-op when the file is missing or unparseable", () => {
    expect(importForwardPort(store, join(dir, "nope.json"))).toBeNull();
    writeFileSync(src, "not json");
    expect(importForwardPort(store, src)).toBeNull();
    expect(store.isEmpty()).toBe(true);
  });

  it("never writes to the source file", () => {
    writeFileSync(src, JSON.stringify(legacy));
    const before = readFileSync(src, "utf8");
    importForwardPort(store, src);
    expect(readFileSync(src, "utf8")).toBe(before);
  });

  it("produces rules the store itself accepts as valid", () => {
    writeFileSync(src, JSON.stringify(legacy));
    importForwardPort(store, src);
    // Re-saving an imported rule unchanged must not trip validation — the import cannot write a
    // shape its own store would reject.
    const r = store.rules()[0];
    expect(() => store.updateRule(r.id, r)).not.toThrow();
  });
});
