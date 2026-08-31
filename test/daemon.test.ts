import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus, persistListenPort, startDaemon, stopDaemon, waitForHealth } from "../src/daemon.js";
import { readSecureJson } from "../src/secure/statefile.js";
import { listDaemonPorts, pidAlive, readPidFile, writePidFile } from "../src/pidfile.js";

/**
 * A stand-in for the real gateway: it reads its port out of the data dir's config exactly like the
 * gateway does, so nothing about the daemon under test is special-cased for the test.
 * STUB_IGNORE_SHUTDOWN makes it acknowledge POST /api/shutdown and then keep running, which is how
 * the forced-kill fallback gets exercised.
 */
const STUB = `
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const port = Number(process.env.MCP_GATEWAY_PORT) ||
  JSON.parse(readFileSync(join(process.env.MCP_GATEWAY_HOME, "stub-port.json"), "utf8")).port;
const ignore = process.env.STUB_IGNORE_SHUTDOWN === "1";
console.log("stub starting on", port);
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/mcps" || req.url.startsWith("/api/mcps?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mcps: [{ name: "echo", state: "up", latencyMs: 1 }] }));
    return;
  }
  if (req.url === "/api/memory" || req.url.startsWith("/api/memory?")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ gatewayMb: 12.3, childrenMb: 0, processCount: 1, childrenPending: false }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/shutdown") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    if (!ignore) res.on("finish", () => process.exit(0));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
`;

/** An entry that dies at once — what a bad config or a missing module looks like to start(). */
const CRASHER = `console.error("boom: cannot start"); process.exit(1);`;

let home: string;
let stub: string;
let crasher: string;
const started: number[] = [];

/** A port unlikely to collide with anything on the machine running the suite. */
function pickPort(): number {
  return 34000 + Math.floor((Date.now() + started.length * 7919) % 1500);
}

function writeConfig(port: number): void {
  // Plaintext on purpose: the daemon adopts (and seals) hand-authored plaintext state on read.
  writeFileSync(join(home, "gateway.config.json"), JSON.stringify({ port, host: "127.0.0.1", tokenEnv: "MCP_GATEWAY_TOKEN", servers: {} }));
  // The stub cannot import the gateway's decrypting reader, so it takes its port from here.
  writeFileSync(join(home, "stub-port.json"), JSON.stringify({ port }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcpgw-daemon-"));
  process.env.MCP_GATEWAY_HOME = home;
  stub = join(home, "stub.mjs");
  crasher = join(home, "crasher.mjs");
  writeFileSync(stub, STUB);
  writeFileSync(crasher, CRASHER);
});

afterEach(async () => {
  // Never leave a detached process behind, whatever the test did — but never signal this process
  // either: one test deliberately writes a pid file naming the test runner, to prove stop() refuses
  // to kill a pid it cannot identify. Cleaning that up blind would kill the worker.
  for (const port of listDaemonPorts()) {
    const rec = readPidFile(port);
    if (rec && rec.pid !== process.pid && rec.pid !== process.ppid && pidAlive(rec.pid)) {
      try { process.kill(rec.pid); } catch { /* already gone */ }
    }
  }
  delete process.env.MCP_GATEWAY_HOME;
  delete process.env.STUB_IGNORE_SHUTDOWN;
});

describe("startDaemon", () => {
  it("detaches a daemon, records it, and waits until it actually answers", async () => {
    const port = pickPort();
    writeConfig(port);
    const r = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    expect(r.port).toBe(port);
    expect(r.url).toBe(`http://127.0.0.1:${port}/`);
    started.push(port);

    // The pid file describes the process that is actually up.
    const rec = readPidFile(port);
    expect(rec?.pid).toBe(r.pid);
    expect(rec?.entry).toBe(stub);
    expect(pidAlive(r.pid)).toBe(true);

    // Detached: it is NOT a child of this test process any more.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it("sends the daemon's output to the log file, since it has no terminal to write to", async () => {
    const port = pickPort();
    writeConfig(port);
    const r = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(r.status).toBe("started");
    started.push(port);
    expect(readFileSync(join(home, `gateway-${port}.log`), "utf8")).toContain("stub starting on");
  });

  it("refuses to start a second one, and does not spawn anything", async () => {
    const port = pickPort();
    writeConfig(port);
    const first = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(first.status).toBe("started");
    started.push(port);

    const second = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(second.status).toBe("already-running");
    if (second.status !== "already-running") return;
    expect(second.pid).toBe(first.status === "started" ? first.pid : 0);
  });

  // A daemon that dies immediately is the common case for a bad config, and the CLI's only window
  // into it is the log file — so start() has to surface the tail rather than just "failed".
  it("reports the log tail when the daemon exits before it ever answers", async () => {
    const port = pickPort();
    writeConfig(port);
    const r = await startDaemon({ entry: crasher, timeoutMs: 4000 });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.logTail).toContain("boom: cannot start");
    // And it must not leave a pid file claiming something is running.
    expect(readPidFile(port)).toBeUndefined();
  });

  it("replaces a stale pid file left by a killed daemon instead of believing it", async () => {
    const port = pickPort();
    writeConfig(port);
    writePidFile({ pid: 2147483647, port, entry: stub, node: process.execPath, startedAt: new Date(0).toISOString() });
    const r = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(r.status).toBe("started");
    started.push(port);
    expect(readPidFile(port)?.pid).not.toBe(2147483647);
  });

  it("persistListenPort rewrites only the port field of an existing config", () => {
    writeConfig(19999);
    persistListenPort(18000);
    const cfg = readSecureJson<{ port: number; host: string }>(join(home, "gateway.config.json"))!;
    expect(cfg.port).toBe(18000);
    expect(cfg.host).toBe("127.0.0.1");
  });

  it("lmg start --port changes the listen port and persists it as the new default", async () => {
    const oldPort = pickPort();
    const newPort = pickPort();
    writeConfig(oldPort);
    const r = await startDaemon({ port: newPort, entry: stub, timeoutMs: 15000 });
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    started.push(newPort);
    expect(r.port).toBe(newPort);
    const cfg = readSecureJson<{ port: number }>(join(home, "gateway.config.json"))!;
    expect(cfg.port).toBe(newPort);
    const res = await fetch(`http://127.0.0.1:${newPort}/health`);
    expect(res.status).toBe(200);
  });
});

describe("stopDaemon", () => {
  it("asks the gateway to shut down, waits for the port to close, and clears the pid file", async () => {
    const port = pickPort();
    writeConfig(port);
    const s = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(s.status).toBe("started");

    const r = await stopDaemon({ port, timeoutMs: 8000 });
    expect(r.status).toBe("stopped");
    expect(readPidFile(port)).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  // Graceful has to have a floor: a wedged gateway that acks the request and never exits must not
  // leave `lmg stop` hanging, or leave the process running after it claims to have stopped it.
  // Raised timeout: this test kills a real process tree, which on a busy Windows CI box takes
  // seconds — the default 5s went from plenty to marginal as the suite grew.
  it("force-kills a daemon that acknowledges the request but never exits", { timeout: 20000 }, async () => {
    const port = pickPort();
    writeConfig(port);
    process.env.STUB_IGNORE_SHUTDOWN = "1";
    const s = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(s.status).toBe("started");
    if (s.status !== "started") return;

    const r = await stopDaemon({ port, gracePeriodMs: 1200, timeoutMs: 8000 });
    expect(r.status).toBe("forced");
    expect(pidAlive(s.pid)).toBe(false);
    expect(readPidFile(port)).toBeUndefined();
  });

  it("says so when nothing is running", async () => {
    const r = await stopDaemon({ port: pickPort() });
    expect(r.status).toBe("not-running");
  });

  it("clears a stale pid file rather than killing whatever owns that pid now", async () => {
    const port = pickPort();
    writePidFile({ pid: 2147483647, port, entry: "x", node: "y", startedAt: "z" });
    const r = await stopDaemon({ port });
    expect(r.status).toBe("not-running");
    expect(readPidFile(port)).toBeUndefined();
  });

  // The dangerous case: the pid is live but nothing answers on the port, so we cannot prove the
  // process is ours — the OS may have recycled the number. Refuse by default.
  it("refuses to kill a live pid it cannot identify, unless forced", async () => {
    const port = pickPort();
    writePidFile({ pid: process.pid, port, entry: "x", node: "y", startedAt: "z" });
    const r = await stopDaemon({ port });
    expect(r.status).toBe("refused");
    expect(readPidFile(port)).toBeDefined(); // left alone for the operator to look at
  });
});

describe("daemonStatus", () => {
  it("reports the running daemon with its health and memory", async () => {
    const port = pickPort();
    writeConfig(port);
    const s = await startDaemon({ entry: stub, timeoutMs: 15000 });
    expect(s.status).toBe("started");

    const st = await daemonStatus({ port });
    expect(st.running).toBe(true);
    expect(st.port).toBe(port);
    expect(st.health?.health).toEqual([{ name: "echo", state: "up", latencyMs: 1 }]);
    expect(st.memory?.gatewayMb).toBe(12.3);
    expect(st.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("reports not running when there is no daemon", async () => {
    const st = await daemonStatus({ port: pickPort() });
    expect(st.running).toBe(false);
    expect(st.health).toBeUndefined();
  });
});

describe("waitForHealth", () => {
  it("gives up after the timeout instead of polling forever", async () => {
    let calls = 0;
    const never = async () => { calls++; throw new Error("ECONNREFUSED"); };
    const ok = await waitForHealth(1, 300, never as unknown as typeof fetch);
    expect(ok).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });

  it("returns as soon as health answers", async () => {
    let calls = 0;
    const answer = async () => {
      calls++;
      return { ok: true } as Response;
    };
    expect(await waitForHealth(1, 5000, answer as unknown as typeof fetch)).toBe(true);
    expect(calls).toBe(1);
  });
});
