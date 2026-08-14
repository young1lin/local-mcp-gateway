import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelStore } from "../src/tunnels/store.js";

let dir: string;
let path: string;
const conn = {
  name: "test", host: "10.0.0.1", port: 22, username: "deploy",
  authType: "key" as const, keyPath: "~/.ssh/id_rsa",
};
const rule = { name: "pg", connectionId: "", localPort: 5433, targetHost: "127.0.0.1", targetPort: 5432 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tunnels-"));
  path = join(dir, "tunnels.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("TunnelStore CRUD", () => {
  it("assigns an id, fills defaults and persists", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    const r = s.addRule({ ...rule, connectionId: c.id });
    expect(r.autoReconnect).toBe(false);
    expect(r.reconnectInterval).toBe(10);
    expect(r.enabled).toBe(false);
    expect(r.mcps).toEqual([]);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.connections).toHaveLength(1);
    expect(onDisk.rules[0].localPort).toBe(5433);
    expect(new TunnelStore(path).rules()).toHaveLength(1);
  });

  it("hands back copies, so a caller cannot mutate stored state by accident", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    s.connections()[0].name = "clobbered";
    expect(s.connection(c.id)!.name).toBe("test");
    const r = s.addRule({ ...rule, connectionId: c.id, mcps: ["a"] });
    s.rule(r.id)!.mcps.push("b");
    expect(s.rule(r.id)!.mcps).toEqual(["a"]);
  });

  it("rejects a duplicate local port, naming the rule that already holds it", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    s.addRule({ ...rule, connectionId: c.id });
    expect(() => s.addRule({ ...rule, name: "other", connectionId: c.id }))
      .toThrow(/local port 5433 is already used by 'pg'/i);
  });

  it("allows a rule to keep its own port when edited", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    const r = s.addRule({ ...rule, connectionId: c.id });
    expect(() => s.updateRule(r.id, { ...rule, connectionId: c.id, name: "pg2" })).not.toThrow();
    expect(s.rule(r.id)!.name).toBe("pg2");
  });

  it("rejects an unknown connection, a bad port and the gateway's own port", () => {
    const s = new TunnelStore(path, 19999);
    const c = s.addConnection(conn);
    expect(() => s.addRule({ ...rule, connectionId: "nope" })).toThrow(/unknown SSH connection/i);
    expect(() => s.addRule({ ...rule, connectionId: c.id, localPort: 0 })).toThrow(/invalid local port/i);
    expect(() => s.addRule({ ...rule, connectionId: c.id, localPort: 19999 })).toThrow(/gateway's own port/i);
  });

  it("requires the fields each auth type actually needs", () => {
    const s = new TunnelStore(path);
    expect(() => s.addConnection({ ...conn, keyPath: "" })).toThrow(/private key path/i);
    expect(() => s.addConnection({ ...conn, authType: "password", keyPath: undefined })).toThrow(/password/i);
    expect(() => s.addConnection({ ...conn, host: "" })).toThrow(/host is required/i);
    expect(() => s.addConnection({ ...conn, username: " " })).toThrow(/username is required/i);
  });

  it("keeps a learned host key across an unrelated edit, and drops it when the host moves", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    s.setHostKey(c.id, "SHA256:abc");
    s.updateConnection(c.id, { ...conn, username: "other" });
    expect(s.connection(c.id)!.hostKey).toBe("SHA256:abc");
    s.updateConnection(c.id, { ...conn, host: "10.0.0.2" });
    expect(s.connection(c.id)!.hostKey).toBeUndefined();
  });

  it("refuses to delete a connection that rules still reference", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    s.addRule({ ...rule, connectionId: c.id });
    expect(() => s.removeConnection(c.id)).toThrow(/still used by: pg/i);
    s.removeRule(s.rules()[0].id);
    expect(() => s.removeConnection(c.id)).not.toThrow();
    expect(s.isEmpty()).toBe(true);
  });

  it("does not let an edit flip enabled, which the manager owns", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    const r = s.addRule({ ...rule, connectionId: c.id });
    s.setEnabled(r.id, true);
    s.updateRule(r.id, { ...rule, connectionId: c.id, enabled: false });
    expect(s.rule(r.id)!.enabled).toBe(true);
  });
});

describe("TunnelStore loading", () => {
  it("keeps a rule whose connection is unknown rather than discarding the file", () => {
    writeFileSync(path, JSON.stringify({
      connections: [{ id: "c1", name: "a", host: "h", port: 22, username: "u", authType: "key", keyPath: "k" }],
      rules: [
        { id: "r1", name: "good", connectionId: "c1", localPort: 1, targetHost: "127.0.0.1", targetPort: 2 },
        { id: "r2", name: "orphan", connectionId: "gone", localPort: 3, targetHost: "127.0.0.1", targetPort: 4 },
        { id: "r3", name: "junk" },
      ],
    }));
    const s = new TunnelStore(path);
    expect(s.rules().map((r) => r.name)).toEqual(["good", "orphan"]);
  });

  it("survives an unparseable file", () => {
    writeFileSync(path, "{ this is not json");
    expect(new TunnelStore(path).isEmpty()).toBe(true);
  });

  it("reports a fresh store only when there is no file", () => {
    expect(new TunnelStore(path).isFresh()).toBe(true);
    const s = new TunnelStore(path);
    s.addConnection(conn);
    expect(new TunnelStore(path).isFresh()).toBe(false);
  });
});

describe("TunnelStore MCP links", () => {
  it("follows a rename and forgets a deletion", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    const r = s.addRule({ ...rule, connectionId: c.id, mcps: ["pg-analytics", "other"] });
    s.renameMcp("pg-analytics", "pg-wk");
    expect(s.rule(r.id)!.mcps).toEqual(["pg-wk", "other"]);
    s.forgetMcp("other");
    expect(s.rule(r.id)!.mcps).toEqual(["pg-wk"]);
  });

  it("does not write the file when nothing referenced the MCP", () => {
    const s = new TunnelStore(path);
    s.addConnection(conn);
    const before = readFileSync(path, "utf8");
    s.forgetMcp("nobody");
    s.renameMcp("nobody", "somebody");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
