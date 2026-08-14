import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelStore } from "../src/tunnels/store.js";
import { DependentsError, TunnelManager, type McpView, type SshHooksIn, type SshLike } from "../src/tunnels/manager.js";
import { probePort } from "../src/tunnels/port.js";
import { TunnelError, type SshConnDef } from "../src/tunnels/types.js";

let dir: string;
let store: TunnelStore;
let echo: Server;
let echoPort = 0;
const liveEchoes = new Set<Socket>();
/** Every fake connection built during a test, newest last. */
let built: FakeConn[] = [];

/**
 * A stand-in for SshConnection: `openChannel` returns a TCP socket to the echo server, so the whole
 * manager lifecycle runs with no SSH server anywhere.
 */
class FakeConn implements SshLike {
  state: SshLike["state"] = "idle";
  reason?: string;
  banner = "SSH-2.0-fake";
  refs = 0;
  dials = 0;
  ended = 0;
  /** Set to make the next connect() fail with this error. */
  failWith?: TunnelError;
  /** Set to fail channel opens. */
  channelFails?: Error;

  constructor(public def: SshConnDef, public hooks: SshHooksIn) {
    built.push(this);
  }
  get connected(): boolean { return this.state === "connected"; }
  setDef(def: SshConnDef): void { this.def = def; }
  async connect(): Promise<void> {
    if (this.connected) return;
    this.dials++;
    if (this.failWith) {
      this.state = "error";
      this.reason = this.failWith.message;
      throw this.failWith;
    }
    this.state = "connected";
    this.reason = undefined;
  }
  openChannel(host: string, port: number): Promise<Duplex> {
    if (this.channelFails) return Promise.reject(this.channelFails);
    if (!this.connected) return Promise.reject(new TunnelError("not established", "network"));
    return new Promise((resolve, reject) => {
      const s = createConnection({ host, port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }
  async end(): Promise<void> {
    this.ended++;
    this.state = "idle";
  }
  /** Simulate the transport dying under running rules. */
  die(kind: "network" | "auth" = "network"): void {
    this.state = "error";
    this.hooks.onLost?.(new TunnelError(`ssh connection lost: ${kind} failure`, kind));
  }
}

function manager(mcps?: McpView): TunnelManager {
  return new TunnelManager(store, { mcps, makeConnection: (def, hooks) => new FakeConn(def, hooks) });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = createConnection({ host: "127.0.0.1", port });
    let out = "";
    c.setTimeout(4000, () => { c.destroy(); reject(new Error("timeout")); });
    c.on("connect", () => c.write(text));
    c.on("data", (b) => { out += b.toString("utf8"); c.end(); resolve(out); });
    c.on("error", reject);
  });
}

const connDef = {
  name: "srv", host: "10.0.0.1", port: 22, username: "deploy",
  authType: "key" as const, keyPath: "C:/keys/id_rsa",
};

beforeEach(async () => {
  built = [];
  dir = mkdtempSync(join(tmpdir(), "tmgr-"));
  store = new TunnelStore(join(dir, "tunnels.json"), 19999);
  echo = createServer((s) => {
    liveEchoes.add(s);
    s.on("close", () => liveEchoes.delete(s));
    s.on("error", () => s.destroy());
    s.on("data", (b) => s.write(b.toString("utf8").toUpperCase()));
  });
  await new Promise<void>((r) => echo.listen({ port: 0, host: "127.0.0.1" }, () => r()));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  for (const s of [...liveEchoes]) s.destroy();
  await new Promise<void>((r) => echo.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("start and stop", () => {
  it("binds the port, carries traffic, and frees the port on stop", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });

    await m.startRule(r.id);
    expect(m.rows().rules[0].state).toBe("up");
    expect(await roundTrip(port, "ping")).toBe("PING");
    expect(store.rule(r.id)!.enabled).toBe(true);

    await m.stopRule(r.id);
    expect(m.rows().rules[0].state).toBe("stopped");
    expect(await probePort(port)).toBe(true);
    expect(store.rule(r.id)!.enabled).toBe(false);
  });

  it("reports the holder when the local port is taken by someone else", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: "127.0.0.1", exclusive: true }, () => r()));
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    try {
      await expect(m.startRule(r.id)).rejects.toThrow(/is held by pid \d+/);
      const row = m.rows().rules[0];
      expect(row.state).toBe("error");
      expect(row.portOwner?.pid).toBe(process.pid);
      expect(row.reason).toMatch(/held by pid/);
    } finally {
      await new Promise<void>((r2) => squatter.close(() => r2()));
    }
  }, 25000);

  it("fails a rule whose connection is unknown, without touching the port", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const broken = store.addRule({ name: "orphan", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    // Break the link the way a hand-edited tunnels.json does — the store keeps such a rule on load
    // rather than discarding the file, so the manager has to report it rather than crash.
    (store as unknown as { ruleList: Array<{ id: string; connectionId: string }> }).ruleList
      .find((x) => x.id === broken.id)!.connectionId = "gone";
    await expect(m.startRule(broken.id)).rejects.toThrow(/unknown SSH connection/);
    expect(m.rows().rules[0].state).toBe("error");
    expect(await probePort(port)).toBe(true);
  });

  it("is idempotent: a second start is a no-op, a second stop too", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(r.id);
    await m.startRule(r.id);
    expect(built[0].dials).toBe(1);
    await m.stopRule(r.id);
    await m.stopRule(r.id);
    expect(m.rows().rules[0].state).toBe("stopped");
  });

  it("serializes a start and a stop that arrive together", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await Promise.allSettled([m.startRule(r.id), m.stopRule(r.id), m.startRule(r.id)]);
    // Whatever the order, the reported state and the actual port agree.
    const state = m.rows().rules[0].state;
    const free = await probePort(port);
    expect(state === "up" ? !free : free).toBe(true);
    await m.closeAll();
  });
});

describe("connection sharing", () => {
  it("dials once for many rules and ends the client when the last one stops", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const ports = [await freePort(), await freePort(), await freePort()];
    const rules = ports.map((p, i) =>
      store.addRule({ name: `r${i}`, connectionId: c.id, localPort: p, targetHost: "127.0.0.1", targetPort: echoPort }),
    );
    const results = await m.startAll();
    expect(results.every((x) => x.ok)).toBe(true);
    expect(built).toHaveLength(1);
    expect(built[0].dials).toBe(1);
    expect(built[0].refs).toBe(3);

    await m.stopRule(rules[0].id);
    expect(built[0].ended).toBe(0); // still two rules using it
    await m.stopRule(rules[1].id);
    await m.stopRule(rules[2].id);
    expect(built[0].refs).toBe(0);
    expect(built[0].ended).toBe(1);
  });

  it("does not double-count a reference when a rule is started twice", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(r.id);
    await m.startRule(r.id);
    expect(built[0].refs).toBe(1);
    await m.stopRule(r.id);
    expect(built[0].ended).toBe(1);
  });
});

describe("transport loss", () => {
  it("releases the port and schedules a reconnect when auto-reconnect is on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const m = manager();
      const c = store.addConnection(connDef);
      const port = await freePort();
      const r = store.addRule({
        name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
        autoReconnect: true, reconnectInterval: 1,
      });
      await m.startRule(r.id);
      built[0].die("network");
      await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("reconnecting"));
      // The port must be free while the tunnel is down — this is the whole point.
      expect(await probePort(port)).toBe(true);

      built[0].state = "idle"; // the server is reachable again
      await vi.advanceTimersByTimeAsync(1400);
      await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("up"));
      expect(await probePort(port)).toBe(false);
      expect(m.rows().rules[0].reconnectedAt).toBeTruthy();
      await m.closeAll();
    } finally {
      vi.useRealTimers();
    }
  }, 25000);

  it("does not schedule a reconnect for an auth failure, even with auto-reconnect on", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({
      name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
      autoReconnect: true, reconnectInterval: 1,
    });
    await m.startRule(r.id);
    built[0].failWith = new TunnelError("All configured authentication methods failed", "auth");
    built[0].die("auth");
    await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("error"));
    expect(await probePort(port)).toBe(true);
    // Wait past the interval: nothing may retry.
    await new Promise((r2) => setTimeout(r2, 1300));
    expect(m.rows().rules[0].state).toBe("error");
    expect(built[0].dials).toBe(1);
  }, 25000);

  it("leaves a rule in error, port released, when auto-reconnect is off", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(r.id);
    built[0].die("network");
    await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("error"));
    expect(await probePort(port)).toBe(true);
    expect(m.rows().rules[0].reason).toMatch(/lost/i);
  });

  it("brings every rule on a shared connection down together", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const ports = [await freePort(), await freePort()];
    ports.forEach((p, i) =>
      store.addRule({ name: `r${i}`, connectionId: c.id, localPort: p, targetHost: "127.0.0.1", targetPort: echoPort }),
    );
    await m.startAll();
    built[0].die("network");
    await vi.waitFor(() => expect(m.rows().rules.every((x) => x.state === "error")).toBe(true));
    for (const p of ports) expect(await probePort(p)).toBe(true);
  });
});

describe("reconnect policy", () => {
  it("does not retry a port failure — a foreign holder will not free the port on its own", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: "127.0.0.1", exclusive: true }, () => r()));
    const r = store.addRule({
      name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
      autoReconnect: true, reconnectInterval: 1,
    });
    try {
      await expect(m.startRule(r.id)).rejects.toThrow(/held by pid/);
      expect(m.rows().rules[0].state).toBe("error"); // not "reconnecting"
      // Wait well past the interval: the port is held by someone else and will not self-heal, so
      // retrying would only thrash (and spawn netstat/tasklist each time). No retry must happen.
      await new Promise((r2) => setTimeout(r2, 1400));
      expect(m.rows().rules[0].state).toBe("error");
      expect(built[0].dials).toBe(1); // the one failed start, nothing more
    } finally {
      await new Promise<void>((r2) => squatter.close(() => r2()));
    }
  }, 25000);

  it("spaces network reconnects out with backoff, not a flat storm, and never gives up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Every dial fails with a network error, so the rule can never come up — it only retries.
      const m = new TunnelManager(store, {
        makeConnection: (def, hooks) => {
          const fc = new FakeConn(def, hooks);
          fc.failWith = new TunnelError("host unreachable", "network");
          return fc;
        },
      });
      const c = store.addConnection(connDef);
      const port = await freePort();
      const r = store.addRule({
        name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
        autoReconnect: true, reconnectInterval: 1,
      });
      await m.startRule(r.id).catch(() => {}); // first attempt fails -> reconnecting
      await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("reconnecting"));
      await vi.advanceTimersByTimeAsync(10_000);
      // Backoff (1,2,4,8s …) means ~3-4 attempts in 10s; a flat 1s loop would have made ~10.
      expect(built[0].dials).toBeGreaterThanOrEqual(2); // it did retry
      expect(built[0].dials).toBeLessThanOrEqual(5); // but not a storm
      expect(m.rows().rules[0].state).toBe("reconnecting"); // a network outage is retried forever
      await m.closeAll();
    } finally {
      vi.useRealTimers();
    }
  }, 25000);
});

describe("edits", () => {
  it("restarts a running rule on the new port and frees the old one", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const oldPort = await freePort();
    const newPort = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: oldPort, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(r.id);
    await m.applyRuleUpdate(r.id, {
      name: "pg", connectionId: c.id, localPort: newPort, targetHost: "127.0.0.1", targetPort: echoPort,
    });
    expect(m.rows().rules[0].state).toBe("up");
    expect(await probePort(oldPort)).toBe(true);
    expect(await roundTrip(newPort, "hi")).toBe("HI");
    await m.closeAll();
  });

  it("leaves a stopped rule stopped after an edit", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.applyRuleUpdate(r.id, { name: "pg2", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    expect(m.rows().rules[0].state).toBe("stopped");
    expect(await probePort(port)).toBe(true);
  });

  it("restarts only the rules that were running when a connection is edited", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const p1 = await freePort();
    const p2 = await freePort();
    const running = store.addRule({ name: "on", connectionId: c.id, localPort: p1, targetHost: "127.0.0.1", targetPort: echoPort });
    const stopped = store.addRule({ name: "off", connectionId: c.id, localPort: p2, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(running.id);

    await m.applyConnectionUpdate(c.id, { ...connDef, username: "someone-else" });
    const rows = m.rows().rules;
    expect(rows.find((x) => x.id === running.id)!.state).toBe("up");
    expect(rows.find((x) => x.id === stopped.id)!.state).toBe("stopped");
    // The old client was ended and a new one dialed.
    expect(built).toHaveLength(2);
    expect(built[0].ended).toBe(1);
    expect(built[1].def.username).toBe("someone-else");
    await m.closeAll();
  });

  it("refuses to delete a connection with rules, and succeeds once they are gone", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort });
    await expect(m.deleteConnection(c.id)).rejects.toThrow(/still used by: pg/);
    await m.deleteRule(r.id);
    await expect(m.deleteConnection(c.id)).resolves.toBeUndefined();
    expect(store.isEmpty()).toBe(true);
  });

  it("frees the port when a running rule is deleted", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({ name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort });
    await m.startRule(r.id);
    await m.deleteRule(r.id);
    expect(await probePort(port)).toBe(true);
    expect(store.rules()).toHaveLength(0);
  });
});

describe("MCP linkage", () => {
  const view = (started: string[]): McpView => ({
    has: (n) => ["pg-analytics", "redis-b-6380"].includes(n),
    stateOf: (n) => (started.includes(n) ? "up" : "stopped"),
    isStarted: (n) => started.includes(n),
    startedAt: (n) => (started.includes(n) ? "2026-08-13T10:00:00.000Z" : undefined),
  });

  it("blocks a stop while a linked MCP is started, and obeys force", async () => {
    const m = manager(view(["pg-analytics"]));
    const c = store.addConnection(connDef);
    const port = await freePort();
    const r = store.addRule({
      name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
      mcps: ["pg-analytics"],
    });
    await m.startRule(r.id);
    await expect(m.stopRule(r.id)).rejects.toThrow(DependentsError);
    await expect(m.stopRule(r.id)).rejects.toThrow(/pg-analytics/);
    expect(m.rows().rules[0].state).toBe("up"); // not stopped behind the user's back
    await m.stopRule(r.id, { force: true });
    expect(m.rows().rules[0].state).toBe("stopped");
  });

  it("does not block when the linked MCP is not running", async () => {
    const m = manager(view([]));
    const c = store.addConnection(connDef);
    const r = store.addRule({
      name: "pg", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort,
      mcps: ["pg-analytics"],
    });
    await m.startRule(r.id);
    await expect(m.stopRule(r.id)).resolves.toBeUndefined();
  });

  it("collects every dependent into one error for stop-all", async () => {
    const m = manager(view(["pg-analytics", "redis-b-6380"]));
    const c = store.addConnection(connDef);
    store.addRule({ name: "a", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort, mcps: ["pg-analytics"] });
    store.addRule({ name: "b", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort, mcps: ["redis-b-6380"] });
    await m.startAll();
    const err = await m.stopAll().catch((e) => e);
    expect(err).toBeInstanceOf(DependentsError);
    expect((err as DependentsError).dependents.sort()).toEqual(["pg-analytics", "redis-b-6380"]);
    const results = await m.stopAll(true);
    expect(results.every((x) => x.ok)).toBe(true);
  });

  it("reports link state and an unknown MCP name honestly", async () => {
    const m = manager(view(["pg-analytics"]));
    const c = store.addConnection(connDef);
    store.addRule({
      name: "pg", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort,
      mcps: ["pg-analytics", "ghost"],
    });
    const row = m.rows().rules[0];
    expect(row.mcpRows).toEqual([
      { name: "pg-analytics", state: "up", known: true },
      { name: "ghost", state: "stopped", known: false },
    ]);
  });

  it("flags a stale pool only when the reconnect came after the MCP started", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const m = manager(view(["pg-analytics"]));
      const c = store.addConnection(connDef);
      const port = await freePort();
      const r = store.addRule({
        name: "pg", connectionId: c.id, localPort: port, targetHost: "127.0.0.1", targetPort: echoPort,
        autoReconnect: true, reconnectInterval: 1, mcps: ["pg-analytics"],
      });
      await m.startRule(r.id);
      expect(m.tunnelsForMcp("pg-analytics")[0].stalePool).toBe(false);
      built[0].die("network");
      await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("reconnecting"));
      built[0].state = "idle";
      await vi.advanceTimersByTimeAsync(1400);
      await vi.waitFor(() => expect(m.rows().rules[0].state).toBe("up"));
      // The MCP started at 10:00 on 2026-08-13; this reconnect is now, so the pool may be stale.
      expect(m.tunnelsForMcp("pg-analytics")[0].stalePool).toBe(true);
      await m.closeAll();
    } finally {
      vi.useRealTimers();
    }
  }, 25000);
});

describe("boot and shutdown", () => {
  it("starts only enabled rules, and never throws when one fails", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const good = store.addRule({ name: "good", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort });
    const off = store.addRule({ name: "off", connectionId: c.id, localPort: await freePort(), targetHost: "127.0.0.1", targetPort: echoPort });
    const taken = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port: taken, host: "127.0.0.1", exclusive: true }, () => r()));
    const bad = store.addRule({ name: "bad", connectionId: c.id, localPort: taken, targetHost: "127.0.0.1", targetPort: echoPort });
    store.setEnabled(good.id, true);
    store.setEnabled(bad.id, true);
    try {
      const results = await m.startEnabled();
      expect(results.map((x) => x.name).sort()).toEqual(["bad", "good"]);
      expect(results.find((x) => x.name === "good")!.ok).toBe(true);
      expect(results.find((x) => x.name === "bad")!.ok).toBe(false);
      expect(m.rows().rules.find((x) => x.id === off.id)!.state).toBe("stopped");
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
      await m.closeAll();
    }
  }, 25000);

  it("closeAll frees every port but leaves enabled alone, so the next boot restores the set", async () => {
    const m = manager();
    const c = store.addConnection(connDef);
    const ports = [await freePort(), await freePort()];
    const rules = ports.map((p, i) =>
      store.addRule({ name: `r${i}`, connectionId: c.id, localPort: p, targetHost: "127.0.0.1", targetPort: echoPort }),
    );
    await m.startAll();
    await m.closeAll();
    for (const p of ports) expect(await probePort(p)).toBe(true);
    for (const r of rules) expect(store.rule(r.id)!.enabled).toBe(true);
    expect(built[0].ended).toBe(1);
  });
});
