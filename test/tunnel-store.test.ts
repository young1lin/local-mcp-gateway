import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelStore } from "../src/tunnels/store.js";
import { readSecureJson } from "../src/secure/statefile.js";

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
    const onDisk = readSecureJson<Record<string, any>>(path)!;
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

describe("TunnelStore groups and order", () => {
  function seeded() {
    const s = new TunnelStore(path);
    const a = s.addConnection(conn);
    const b = s.addConnection({ ...conn, name: "second", host: "10.0.0.2" });
    const r1 = s.addRule({ ...rule, name: "one", connectionId: a.id, localPort: 1111 });
    const r2 = s.addRule({ ...rule, name: "two", connectionId: b.id, localPort: 2222 });
    return { s, a, b, r1, r2 };
  }

  it("stores group names per list, dropping blanks, duplicates and the reserved default", () => {
    const { s } = seeded();
    expect(s.setGroups("rules", ["prod", "prod", "", "default", "staging"])).toEqual(["prod", "staging"]);
    expect(s.setGroups("connections", ["bastion"])).toEqual(["bastion"]);
    expect(s.groupsOf("rules")).toEqual(["prod", "staging"]); // lists are independent
    const onDisk = readSecureJson<Record<string, any>>(path)!;
    expect(onDisk.ruleGroups).toEqual(["prod", "staging"]);
    expect(onDisk.connGroups).toEqual(["bastion"]);
    // and it survives a reload
    expect(new TunnelStore(path).groupsOf("rules")).toEqual(["prod", "staging"]);
  });

  it("assigns a row to a group, and an empty assignment means default", () => {
    const { s, r1 } = seeded();
    s.setGroups("rules", ["prod"]);
    expect(s.setGroup("rules", r1.id, "prod")).toBe("prod");
    expect(s.rule(r1.id)!.group).toBe("prod");
    expect(s.setGroup("rules", r1.id, "")).toBe("default");
    expect(s.rule(r1.id)!.group).toBeUndefined();
    expect(() => s.setGroup("rules", r1.id, "nope")).toThrow(/unknown group: nope/);
    expect(() => s.setGroup("rules", "missing", "prod")).toThrow(/unknown rule: missing/);
  });

  it("keeps a row's group across an edit that does not mention one", () => {
    const { s, r1 } = seeded();
    s.setGroups("rules", ["prod"]);
    s.setGroup("rules", r1.id, "prod");
    s.updateRule(r1.id, { ...rule, connectionId: r1.connectionId, name: "renamed" });
    expect(s.rule(r1.id)!.group).toBe("prod");
    // An explicit group in the input wins; clearing one is setGroup's job, not an edit's.
    s.setGroups("rules", ["prod", "staging"]);
    s.updateRule(r1.id, { ...rule, connectionId: r1.connectionId, name: "renamed", group: "staging" });
    expect(s.rule(r1.id)!.group).toBe("staging");
  });

  it("renames a group, moving its members and refusing collisions", () => {
    const { s, r1, r2 } = seeded();
    s.setGroups("rules", ["prod", "staging"]);
    s.setGroup("rules", r1.id, "prod");
    const out = s.renameGroup("rules", "prod", "live");
    expect(out.groups).toEqual(["live", "staging"]);
    expect(out.moved).toBe(1);
    expect(s.rule(r1.id)!.group).toBe("live");
    expect(s.rule(r2.id)!.group).toBeUndefined();
    expect(() => s.renameGroup("rules", "live", "staging")).toThrow(/group already exists/);
    expect(() => s.renameGroup("rules", "nope", "other")).toThrow(/unknown group/);
  });

  it("deleting a group strands its members in the implicit default", () => {
    const { s, r1 } = seeded();
    s.setGroups("rules", ["prod"]);
    s.setGroup("rules", r1.id, "prod");
    s.setGroups("rules", []);
    expect(s.rule(r1.id)!.group).toBeUndefined();
  });

  it("reorders by id, keeping unmentioned rows at the end in their relative order", () => {
    const { s, r1, r2 } = seeded();
    const c = s.addRule({ ...rule, name: "three", connectionId: s.connections()[0].id, localPort: 3333 });
    s.reorder("rules", [c.id, r1.id]); // r2 omitted on purpose
    expect(s.rules().map((x) => x.name)).toEqual(["three", "one", "two"]);
    expect(() => s.reorder("rules", "nope")).toThrow(/ids must be an array/);
    // connections reorder independently
    s.reorder("connections", [s.connections()[1].id]);
    expect(s.connections().map((x) => x.name)).toEqual(["second", "test"]);
  });

  it("round-trips groups and per-row membership through a reload", () => {
    const { s, a, r1 } = seeded();
    s.setGroups("rules", ["prod"]);
    s.setGroups("connections", ["bastion"]);
    s.setGroup("rules", r1.id, "prod");
    s.setGroup("connections", a.id, "bastion");
    const again = new TunnelStore(path);
    expect(again.groupsOf("rules")).toEqual(["prod"]);
    expect(again.groupsOf("connections")).toEqual(["bastion"]);
    expect(again.rule(r1.id)!.group).toBe("prod");
    expect(again.connection(a.id)!.group).toBe("bastion");
  });
});

describe("host-key learning vs clearing", () => {
  it("clearHostKey drops the key where updateConnection would have silently re-adopted it", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    s.setHostKey(c.id, "SHA256:x");
    expect(s.connection(c.id)!.hostKey).toBe("SHA256:x");
    s.clearHostKey(c.id);
    expect(s.connection(c.id)!.hostKey).toBeUndefined();

    // Why clearHostKey exists: the ordinary edit path re-adopts a learned key when host/port are
    // unchanged, so "clearing" through updateConnection is a no-op.
    s.setHostKey(c.id, "SHA256:y");
    const def = s.connection(c.id)!;
    s.updateConnection(c.id, { ...def, hostKey: undefined } as never);
    expect(s.connection(c.id)!.hostKey).toBe("SHA256:y");
  });
});

describe("updateRule mcps links", () => {
  it("keeps the stored links when the update omits mcps; an explicit [] clears them", () => {
    const s = new TunnelStore(path);
    const c = s.addConnection(conn);
    const r = s.addRule({ ...rule, connectionId: c.id, mcps: ["pg"] });
    const base2 = { name: r.name, connectionId: c.id, localPort: r.localPort, targetHost: "10.9.9.9", targetPort: 1 };
    const kept = s.updateRule(r.id, base2 as never);
    expect(kept.mcps).toEqual(["pg"]); // omitted — carry over, like group/enabled
    const cleared = s.updateRule(r.id, { ...base2, mcps: [] } as never);
    expect(cleared.mcps).toEqual([]); // explicit — clear
  });
});
