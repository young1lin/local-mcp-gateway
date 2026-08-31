import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseArgv, run, type Io, type Ops } from "../src/cli.js";
import type { StartResult, StatusResult, StopResult } from "../src/daemon.js";

describe("package.json", () => {
  it("npm start is lmg start", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      bin: { lmg: string };
      scripts: { start: string };
    };
    expect(pkg.bin.lmg).toBe("dist/bin.js");
    expect(pkg.scripts.start).toBe("node dist/bin.js start");
  });
});

function io(): Io & { text: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

const RUNNING: StatusResult = {
  running: true,
  port: 19999,
  pid: 4242,
  entry: "C:\\pkg\\dist\\index.js",
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  uptimeMs: 3_600_000,
  url: "http://127.0.0.1:19999/",
  logFile: "C:\\home\\.mcp-gateway\\gateway-19999.log",
  health: {
    ok: true,
    paths: ["mysql", "redis"],
    health: [
      { name: "mysql", state: "up", latencyMs: 110 },
      { name: "redis", state: "unknown" },
    ],
  },
  memory: { gatewayMb: 82.7, childrenMb: 0, processCount: 1 },
};

const STOPPED: StatusResult = { running: false, port: 19999, logFile: "x.log" };

/**
 * Every op records the call and answers what the test asked for. The results are injected rather
 * than the functions, so a test that changes an answer cannot accidentally drop the recording.
 */
interface Over {
  start?: StartResult;
  stop?: StopResult;
  status?: StatusResult;
  token?: () => string | undefined;
}

function ops(over: Over = {}): Ops & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: () => 19999,
    start: async (o) => {
      calls.push(`start:${o?.port ?? "default"}`);
      return over.start ?? { status: "started", pid: 1, port: 19999, url: "http://127.0.0.1:19999/" };
    },
    stop: async (o) => {
      calls.push(`stop:${o?.port ?? "default"}${o?.force ? ":force" : ""}`);
      return over.stop ?? { status: "stopped", pid: 1, port: 19999 };
    },
    status: async () => {
      calls.push("status");
      return over.status ?? RUNNING;
    },
    logs: async (port, lines, follow) => {
      calls.push(`logs:${port}:${lines}:${follow}`);
    },
    open: (url) => {
      calls.push(`open:${url}`);
    },
    token: over.token ?? (() => "tok-123"),
    creds: () => ({
      url: "http://127.0.0.1:19999/",
      token: over.token ? over.token() : "tok-123",
    }),
    exportState: () => {
      calls.push("export");
      return { version: 1, exportedAt: "", config: { port: 19999 } };
    },
    importState: (bundle) => {
      calls.push("import");
      if (!bundle || (bundle as { version?: number }).version !== 1) throw new Error("bad bundle");
      return ["gateway.config.json", "env.json"];
    },
    skillInstall: () => {
      calls.push("skill:install");
      return ["~/.agents/skills/local-mcp-gateway", "~/.claude/skills/local-mcp-gateway"];
    },
    foreground: async (o) => {
      calls.push(o?.port !== undefined ? `foreground:${o.port}` : "foreground");
    },
  };
}

describe("parseArgv", () => {
  it("takes the command and leaves the flags off", () => {
    const p = parseArgv(["start"]);
    expect(p.cmd).toBe("start");
    expect(p.foreground).toBe(false);
    expect(p.port).toBeUndefined();
    expect(p.unknown).toEqual([]);
  });

  it("reads a port either way round", () => {
    expect(parseArgv(["stop", "--port", "8080"]).port).toBe(8080);
    expect(parseArgv(["stop", "--port=8080"]).port).toBe(8080);
    expect(parseArgv(["stop", "-p", "8080"]).port).toBe(8080);
  });

  it("rejects a port that is not a port", () => {
    for (const bad of ["0", "-1", "70000", "abc", ""]) {
      expect(parseArgv(["stop", "--port", bad]).badPort, bad).toBe(true);
    }
  });

  // -f means the conventional thing for each command: foreground for start, follow for logs.
  it("gives -f its per-command meaning", () => {
    expect(parseArgv(["start", "-f"]).foreground).toBe(true);
    expect(parseArgv(["logs", "-f"]).follow).toBe(true);
  });

  it("reads the remaining flags", () => {
    expect(parseArgv(["stop", "--force"]).force).toBe(true);
    expect(parseArgv(["status", "--json"]).json).toBe(true);
    expect(parseArgv(["logs", "-n", "50"]).lines).toBe(50);
    expect(parseArgv(["logs", "--lines=50"]).lines).toBe(50);
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["--version"]).version).toBe(true);
  });

  it("collects flags it does not know instead of ignoring them", () => {
    expect(parseArgv(["start", "--detach", "--wat"]).unknown).toEqual(["--detach", "--wat"]);
  });

  it("treats no arguments as no command", () => {
    expect(parseArgv([]).cmd).toBe("");
  });
});

describe("run", () => {
  it("starts, and prints where to reach it", async () => {
    const o = io();
    const p = ops();
    expect(await run(["start"], o, p)).toBe(0);
    expect(p.calls).toContain("start:default");
    expect(p.calls).toContain("open:http://127.0.0.1:19999/");
    expect(o.text()).toContain("http://127.0.0.1:19999/");
  });

  it("says so when one is already running, and is not an error", async () => {
    const o = io();
    const p = ops({ start: { status: "already-running", pid: 7, port: 19999, url: "http://127.0.0.1:19999/" } });
    expect(await run(["start"], o, p)).toBe(0);
    expect(o.text()).toMatch(/already running/i);
    expect(p.calls).toContain("open:http://127.0.0.1:19999/");
  });

  // A failed start's only useful output is the daemon's own last words.
  it("surfaces the log tail when the start fails", async () => {
    const o = io();
    const p = ops({ start: { status: "failed", port: 19999, logTail: "Error: Missing token env var: X" } });
    expect(await run(["start"], o, p)).toBe(1);
    expect(o.errText()).toContain("Missing token env var");
    expect(p.calls.filter((c) => c.startsWith("open:"))).toEqual([]);
  });

  it("runs in the foreground instead of detaching when asked", async () => {
    const p = ops();
    expect(await run(["start", "-f"], io(), p)).toBe(0);
    expect(p.calls).toEqual(["foreground"]);
  });

  it("passes --port through to a foreground start", async () => {
    const p = ops();
    expect(await run(["start", "-f", "-p", "18000"], io(), p)).toBe(0);
    expect(p.calls).toEqual(["foreground:18000"]);
  });

  it("skips the browser on --no-open", async () => {
    const p = ops();
    expect(await run(["start", "--no-open"], io(), p)).toBe(0);
    expect(p.calls.filter((c) => c.startsWith("open:"))).toEqual([]);
  });

  it("reads --no-open", () => {
    expect(parseArgv(["start", "--no-open"]).noOpen).toBe(true);
    expect(parseArgv(["start"]).noOpen).toBe(false);
  });

  it("stops, and reports a forced kill differently from a clean one", async () => {
    const o = io();
    expect(await run(["stop"], o, ops())).toBe(0);
    expect(o.text()).toMatch(/stopped/i);

    const forced = io();
    expect(await run(["stop"], forced, ops({ stop: { status: "forced", pid: 1, port: 19999 } }))).toBe(0);
    expect(forced.text()).toMatch(/force/i);
  });

  it("exits 3 when there was nothing to stop, so a script can tell", async () => {
    const o = io();
    const code = await run(["stop"], o, ops({ stop: { status: "not-running", port: 19999 } }));
    expect(code).toBe(3);
  });

  it("passes --force through, and explains a refusal", async () => {
    const o = io();
    const p = ops({
      stop: { status: "refused", pid: 999, port: 19999, reason: "cannot be confirmed as this gateway" },
    });
    expect(await run(["stop", "--force"], o, p)).toBe(1);
    expect(p.calls).toContain("stop:19999:force");
    expect(o.errText()).toContain("cannot be confirmed");
  });

  it("restarts by stopping first, then starting", async () => {
    const p = ops({ stop: { status: "stopped", pid: 1, port: 19999 } });
    expect(await run(["restart"], io(), p)).toBe(0);
    expect(p.calls).toEqual(["stop:19999", "start:default", "open:http://127.0.0.1:19999/"]);
  });

  it("restarts even when nothing was running", async () => {
    const p = ops({ stop: { status: "not-running", port: 19999 } });
    expect(await run(["restart"], io(), p)).toBe(0);
    expect(p.calls).toEqual(["stop:19999", "start:default", "open:http://127.0.0.1:19999/"]);
  });

  it("reports status, including the per-MCP lines", async () => {
    const o = io();
    expect(await run(["status"], o, ops())).toBe(0);
    const text = o.text();
    expect(text).toContain("http://127.0.0.1:19999/");
    expect(text).toContain("4242");
    expect(text).toContain("mysql");
    expect(text).toContain("110");
    expect(text).toContain("82.7");
  });

  it("exits 3 from status when nothing is running", async () => {
    const o = io();
    expect(await run(["status"], o, ops({ status: STOPPED }))).toBe(3);
    expect(o.text()).toMatch(/not running/i);
  });

  it("emits machine-readable status on --json", async () => {
    const o = io();
    expect(await run(["status", "--json"], o, ops())).toBe(0);
    expect(JSON.parse(o.text()).pid).toBe(4242);
  });

  it("tails the log, with a default line count and follow off", async () => {
    const p = ops();
    expect(await run(["logs"], io(), p)).toBe(0);
    expect(p.calls).toEqual(["logs:19999:200:false"]);

    const f = ops();
    await run(["logs", "-f", "-n", "10"], io(), f);
    expect(f.calls).toEqual(["logs:19999:10:true"]);
  });

  it("prints the panel url and the token — no login exists to print", async () => {
    const o = io();
    expect(await run(["creds"], o, ops())).toBe(0);
    expect(o.text()).toContain("http://127.0.0.1:19999/");
    expect(o.text()).toContain("tok-123");
    expect(o.text()).toContain("(none");
  });

  it("prints the token, and fails when there is none", async () => {
    const o = io();
    expect(await run(["token"], o, ops())).toBe(0);
    expect(o.text()).toContain("tok-123");

    const none = io();
    expect(await run(["token"], none, ops({ token: () => undefined }))).toBe(1);
  });

  it("opens the panel in a browser", async () => {
    const p = ops();
    expect(await run(["open"], io(), p)).toBe(0);
    expect(p.calls).toContain("open:http://127.0.0.1:19999/");
  });

  it("prints usage listing every command, and exits 0 for --help", async () => {
    const o = io();
    expect(await run(["--help"], io(), ops())).toBe(0);
    await run([], o, ops());
    for (const cmd of ["start", "stop", "restart", "status", "logs", "token", "creds", "open"]) {
      expect(o.text() + o.errText()).toContain(cmd);
    }
  });

  it("refuses an unknown command or flag rather than doing something surprising", async () => {
    const o = io();
    expect(await run(["frobnicate"], o, ops())).toBe(1);
    expect(o.errText()).toMatch(/frobnicate/);

    const f = io();
    expect(await run(["start", "--detach"], f, ops())).toBe(1);
    expect(f.errText()).toMatch(/--detach/);
  });

  it("refuses a bad port before acting on it", async () => {
    const o = io();
    const p = ops();
    expect(await run(["stop", "--port", "abc"], o, p)).toBe(1);
    expect(p.calls).toEqual([]);
  });
});

describe("parseArgv --lines", () => {
  it("reads a plain line count and the = form", () => {
    expect(parseArgv(["logs", "-n", "50"]).lines).toBe(50);
    expect(parseArgv(["logs", "--lines=50"]).lines).toBe(50);
  });

  it("never eats a following flag as the value — the old bug dropped --json entirely", () => {
    const p = parseArgv(["logs", "-n", "--json"]);
    expect(p.badLines).toBe(true); // "--json" is not a line count
    expect(p.json).toBe(true); // and it still reads as the flag it always was
  });

  it("refuses non-decimal line counts instead of silently ignoring them", () => {
    for (const bad of ["0x10", "1e2", "-5", "0", "abc", ""] as const) {
      expect(parseArgv(["logs", "-n", bad]).badLines, bad).toBe(true);
    }
  });

  it("trims --port like MCP_GATEWAY_PORT is trimmed", () => {
    expect(parseArgv(["stop", "--port", " 8080 "]).port).toBe(8080);
  });
});
