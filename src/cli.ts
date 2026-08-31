import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  daemonStatus,
  exportState,
  importState,
  isNpxCachePath,
  readCreds,
  readGatewayToken,
  resolvePort,
  serverEntry,
  startDaemon,
  stopDaemon,
  urlFor,
  persistListenPort,
  type StartOptions,
  type StartResult,
  type StatusResult,
  type StopOptions,
  type StopResult,
} from "./daemon.js";
import { logFilePath } from "./pidfile.js";
import { asListenPort } from "./port.js";
import { installSkill } from "./skill-install.js";

/**
 * The `lmg` command line.
 *
 * Deliberately free of the server's module graph: this file and everything it imports must stay on
 * node builtins, so `lmg status` does not load ioredis/mysql2/mongodb just to print a line. The
 * server is reached as a subprocess (start) or over loopback HTTP (everything else).
 */

const COMMANDS = ["start", "stop", "restart", "status", "logs", "token", "creds", "open", "export", "import", "skill"] as const;

export interface Parsed {
  cmd: string;
  /** Subcommand for `skill` — only `install` exists today. */
  skillSub?: string;
  /** The positional file argument for 'import'. */
  file?: string;
  port?: number;
  /** A --port that was given but is not a usable port. Refused before anything is acted on. */
  badPort: boolean;
  /** A --lines that was given but is not a positive integer — same refusal as badPort. */
  badLines: boolean;
  foreground: boolean;
  follow: boolean;
  force: boolean;
  json: boolean;
  noOpen: boolean;
  lines?: number;
  help: boolean;
  version: boolean;
  unknown: string[];
}

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

/** Everything `run` does to the outside world, so the dispatch logic is testable on its own. */
export interface Ops {
  port(): number;
  start(opts?: StartOptions): Promise<StartResult>;
  stop(opts?: StopOptions): Promise<StopResult>;
  status(opts?: { port?: number }): Promise<StatusResult>;
  logs(port: number, lines: number, follow: boolean, io: Io): Promise<void>;
  open(url: string): void;
  token(): string | undefined;
  creds(): { url: string; token?: string };
  /** Decrypt every state file into one bundle ('lmg export'). */
  exportState(): unknown;
  /** Re-seal a bundle onto this machine ('lmg import'); returns the restored file names. */
  importState(bundle: unknown): string[];
  foreground(opts?: { port?: number }): Promise<void>;
  /** Copy the shipped skill into the user-level skill dirs; returns the paths written. */
  skillInstall(): string[];
}

const USAGE = `local MCP gateway — one local endpoint in front of your databases and remote MCPs

usage: lmg <command> [options]

  start            start the gateway in the background and open the panel
  stop             ask it to shut down, then force it if it will not
  restart          stop, then start
  status           whether it is running, its MCPs, and what it costs in memory
  logs             show what the background gateway has been printing
  token            print the token clients authenticate with
  creds            print the panel url and the gateway token (for asking an AI)
  open             open the panel in a browser
  export           dump every state file as plaintext JSON to stdout — the recovery /
                   move-to-another-machine path; redirect to a file and protect it
  import <file>    restore an export on THIS machine (every file re-sealed to this machine)
  skill install    copy the shipped AI skill to ~/.agents/skills, ~/.claude/skills, ~/.cursor/skills

options
  -p, --port <n>   listen on this port (saved as the new default)
                   other commands: which instance to act on
  -f               start: run in the foreground instead of detaching
                   logs:  follow the log as it grows
      --no-open    start: do not open the panel in a browser
  -n, --lines <n>  logs: how many lines to show first (default 200)
      --force      stop: kill a live pid even if it cannot be confirmed as this gateway
      --json       status: emit JSON
  -h, --help       this text
  -v, --version    print the version
`;

function toPort(raw: string): number | undefined {
  // asListenPort's exact semantics (trim first, then strict digits + range) so `--port " 8080"`
  // behaves like MCP_GATEWAY_PORT=" 8080 " instead of being refused while the env var works.
  return asListenPort(raw.trim());
}

/**
 * Parse argv without a dependency. Unknown flags are collected rather than ignored: silently
 * dropping `--detach` on a command whose whole point is detaching would be the worst answer.
 */
export function parseArgv(argv: string[]): Parsed {
  const p: Parsed = {
    cmd: "",
    badPort: false,
    badLines: false,
    foreground: false,
    follow: false,
    force: false,
    json: false,
    noOpen: false,
    help: false,
    version: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      if (!p.cmd) p.cmd = arg;
      else if (p.cmd === "skill" && !p.skillSub) p.skillSub = arg;
      else if (!p.file) p.file = arg;
      continue;
    }
    // --key=value and "--key value" are the same thing.
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    // Consume the next argv as this flag's value — but never a following FLAG: `logs -n --json`
    // used to eat --json as -n's value and silently drop it (Number("--json") is NaN, ignored).
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return "";
      i++;
      return next;
    };

    switch (flag) {
      case "-p":
      case "--port": {
        const port = toPort(value());
        if (port === undefined) p.badPort = true;
        else p.port = port;
        break;
      }
      case "-n":
      case "--lines": {
        // Strict digits, like toPort: 0x10 and 1e2 are refusals, not 16 and 100.
        const raw = value();
        if (!/^\d+$/.test(raw) || Number(raw) <= 0) p.badLines = true;
        else p.lines = Number(raw);
        break;
      }
      // One letter, two conventional meanings — each the expected one for its command.
      case "-f":
        p.foreground = true;
        p.follow = true;
        break;
      case "--foreground":
        p.foreground = true;
        break;
      case "--follow":
        p.follow = true;
        break;
      case "--force":
        p.force = true;
        break;
      case "--json":
        p.json = true;
        break;
      case "--no-open":
        p.noOpen = true;
        break;
      case "-h":
      case "--help":
        p.help = true;
        break;
      case "-v":
      case "--version":
        p.version = true;
        break;
      default:
        p.unknown.push(flag);
    }
  }
  return p;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(9)}${value}`;
}

function renderStatus(st: StatusResult): string {
  const lines = ["gateway running", row("url", st.url ?? urlFor(st.port))];
  if (st.pid !== undefined) {
    lines.push(row("pid", `${st.pid}${st.uptimeMs === undefined ? "" : `   (up ${fmtDuration(st.uptimeMs)})`}`));
  }
  if (st.memory?.gatewayMb !== undefined) {
    const kids = st.memory.childrenMb ?? 0;
    const procs = st.memory.processCount ?? 1;
    lines.push(row("memory", `${st.memory.gatewayMb} MB gateway + ${kids} MB children (${procs} proc)`));
  }
  lines.push(row("log", st.logFile));

  const entries = (st.health?.health ?? []) as { name?: string; state?: string; latencyMs?: number }[];
  if (entries.length) {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.state ?? "?", (counts.get(e.state ?? "?") ?? 0) + 1);
    lines.push(row("mcps", [...counts].map(([state, n]) => `${n} ${state}`).join(", ")));
    const width = Math.max(...entries.map((e) => (e.name ?? "").length));
    for (const e of entries) {
      const latency = e.latencyMs === undefined ? "" : `${e.latencyMs} ms`;
      lines.push(`    ${(e.name ?? "").padEnd(width)}  ${(e.state ?? "?").padEnd(8)}${latency}`);
    }
  }
  return lines.join("\n");
}

/**
 * Decide and report. Returns the process exit code: 0 done, 1 refused or failed, 3 nothing running —
 * the third one so `lmg status` is usable in a script without parsing text.
 */
export async function run(argv: string[], io: Io, ops: Ops): Promise<number> {
  const p = parseArgv(argv);

  if (p.help) {
    io.out(USAGE);
    return 0;
  }
  if (p.version) {
    io.out(readVersion());
    return 0;
  }
  if (p.unknown.length) {
    io.err(`unknown option: ${p.unknown.join(", ")}`);
    io.err(USAGE);
    return 1;
  }
  if (p.badPort) {
    io.err("--port takes a number between 1 and 65535");
    return 1;
  }
  if (p.badLines) {
    io.err("--lines takes a positive whole number of lines");
    return 1;
  }
  if (!p.cmd) {
    io.out(USAGE);
    return 1;
  }
  if (!(COMMANDS as readonly string[]).includes(p.cmd)) {
    io.err(`unknown command: ${p.cmd}`);
    io.err(USAGE);
    return 1;
  }

  // start lets the daemon resolve its own port from the config it is about to serve; every other
  // command needs a concrete port up front, because it has to find the pid file to act on.
  const port = p.port ?? ops.port();

  switch (p.cmd) {
    case "start": {
      if (p.foreground) {
        await ops.foreground({ port: p.port });
        return 0;
      }
      const r = await ops.start({ port: p.port });
      const code = reportStart(r, io);
      if ((r.status === "started" || r.status === "already-running") && !p.noOpen) ops.open(r.url);
      return code;
    }
    case "stop":
      return reportStop(await ops.stop({ port, force: p.force }), io);
    case "restart": {
      // A restart must work whether or not anything was running, so "not-running" is not a failure
      // here — only a refusal is, and that means we would be leaving a process behind.
      const stopped = await ops.stop({ port, force: p.force });
      if (stopped.status === "refused") return reportStop(stopped, io);
      const r = await ops.start({ port: p.port });
      const code = reportStart(r, io);
      if ((r.status === "started" || r.status === "already-running") && !p.noOpen) ops.open(r.url);
      return code;
    }
    case "status": {
      const st = await ops.status({ port });
      if (p.json) {
        io.out(JSON.stringify(st, null, 2));
        return st.running ? 0 : 3;
      }
      if (!st.running) {
        io.out(`gateway not running (nothing answering on port ${st.port})`);
        io.out(row("log", st.logFile));
        return 3;
      }
      io.out(renderStatus(st));
      return 0;
    }
    case "logs":
      await ops.logs(port, p.lines ?? 200, p.follow, io);
      return 0;
    case "token": {
      const token = ops.token();
      if (!token) {
        io.err("no token found — start the gateway once and it will generate one");
        return 1;
      }
      io.out(token);
      return 0;
    }
    case "creds": {
      const c = ops.creds();
      io.out(row("url", c.url));
      io.out(row("login", "(none — the panel is loopback-only)"));
      if (c.token) {
        io.out(row("token", c.token));
        return 0;
      }
      io.out(row("token", "(none — start the gateway once)"));
      return 1;
    }
    case "open":
      ops.open(urlFor(port));
      return 0;
    case "export": {
      io.err("warning: everything below is plaintext secrets — redirect to a file, protect it, delete it when done");
      io.out(JSON.stringify(ops.exportState(), null, 2));
      return 0;
    }
    case "import": {
      if (!p.file) {
        io.err("usage: lmg import <file written by lmg export>");
        return 1;
      }
      let bundle: unknown;
      try {
        bundle = JSON.parse(readFileSync(p.file, "utf8"));
      } catch (err) {
        io.err("cannot read " + p.file + ": " + (err as Error).message);
        return 1;
      }
      try {
        const restored = ops.importState(bundle);
        io.out("restored (sealed to this machine): " + (restored.join(", ") || "nothing"));
        return 0;
      } catch (err) {
        io.err((err as Error).message);
        return 1;
      }
    }
    case "skill": {
      if (p.skillSub !== "install") {
        io.err(p.skillSub ? `unknown skill subcommand: ${p.skillSub}` : "usage: lmg skill install");
        return 1;
      }
      const targets = ops.skillInstall();
      io.out("skill installed:");
      for (const t of targets) io.out(`  ${t}`);
      return 0;
    }
  }
  return 1;
}

function reportStart(r: StartResult, io: Io): number {
  if (r.status === "already-running") {
    io.out(`gateway already running (pid ${r.pid})`);
    io.out(row("url", r.url));
    return 0;
  }
  if (r.status === "started") {
    io.out("gateway started");
    io.out(row("url", r.url));
    io.out(row("pid", String(r.pid)));
    io.out(row("log", logFilePath(r.port)));
    return 0;
  }
  io.err(`gateway failed to start on port ${r.port}`);
  if (r.logTail.trim()) {
    io.err("");
    io.err(r.logTail.trimEnd());
  }
  io.err("");
  io.err(`full log: ${logFilePath(r.port)}`);
  return 1;
}

function reportStop(r: StopResult, io: Io): number {
  switch (r.status) {
    case "stopped":
      io.out(`gateway stopped (pid ${r.pid})`);
      return 0;
    case "forced":
      io.out(`gateway did not shut down in time — forced (pid ${r.pid} and its child processes)`);
      return 0;
    case "not-running":
      io.out(`gateway not running on port ${r.port}`);
      return 3;
    case "refused":
      io.err(r.reason);
      return 1;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Show the background gateway's output. Polls rather than watching: fs.watch does not reliably fire
 * for appends on Windows, and a poll is what `--follow` costs anyway.
 */
async function tailLog(port: number, lines: number, follow: boolean, io: Io): Promise<void> {
  const file = logFilePath(port);
  let offset = 0;
  try {
    const text = readFileSync(file, "utf8");
    const all = text.split(/\r?\n/);
    io.out(all.slice(Math.max(0, all.length - lines)).join("\n").trimEnd());
    offset = Buffer.byteLength(text, "utf8");
  } catch {
    // No file yet. Without --follow that is the whole answer; WITH it, the common case is
    // "lmg start just fired and the child has not written its first line" — wait for the file
    // instead of quitting, or the follow promise is broken exactly when it is most wanted.
    if (!follow) {
      io.err(`no log yet at ${file}`);
      return;
    }
    io.err(`waiting for ${file} …`);
  }
  while (follow) {
    await sleep(300);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue; // mid-rotation
    }
    if (size < offset) offset = 0; // rotated out from under us
    if (size === offset) continue;
    const buf = readFileSync(file);
    io.out(buf.subarray(offset, size).toString("utf8").trimEnd());
    offset = size;
  }
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Wire the real implementations and run. Called only from bin.ts, so importing this module for a
 *  test has no side effects. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const io: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
  const ops: Ops = {
    port: resolvePort,
    async start(opts) {
      const entry = serverEntry();
      // A daemon started out of the npx cache stops being restartable as soon as that cache turns
      // over, which is exactly the failure you do not want from something you expect to be running.
      if (isNpxCachePath(entry)) {
        io.err(`warning: running from npm's npx cache (${entry}).`);
        io.err("         That directory is version-keyed and cleared on update, so this daemon will");
        io.err("         not survive it. Install it properly instead: npm i -g <package>");
        io.err("");
      }
      return startDaemon({ ...opts, entry });
    },
    stop: stopDaemon,
    status: daemonStatus,
    logs: tailLog,
    open: openInBrowser,
    token: readGatewayToken,
    creds: readCreds,
    exportState,
    importState,
    skillInstall: installSkill,
    async foreground(opts) {
      // Run the server in this process: no detach, output on this terminal. What a Scheduled Task or
      // a systemd unit should invoke, since those supply their own supervision. Those also must not
      // pop a browser, so the CLI never auto-opens in the foreground.
      if (opts?.port !== undefined) {
        process.env.MCP_GATEWAY_PORT = String(opts.port);
        persistListenPort(opts.port);
      }
      await import(pathToFileURL(serverEntry()).href);
    },
  };
  process.exitCode = await run(argv, io, ops);
}
