import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { log } from "../log.js";

/**
 * Local-port occupancy, and who is occupying it.
 *
 * This is the only module here that spawns anything, and it deliberately uses netstat/tasklist
 * (~4 MB, ~40 ms) rather than a `powershell.exe` Get-NetTCPConnection (~65 MB, ~350 ms). src/mem.ts
 * records the same lesson: a diagnostic must not cost more than the thing it is diagnosing.
 */

/** True when nothing holds the port, tested by actually binding it. */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    // `exclusive` so the probe reports the truth on Windows rather than sharing an existing bind.
    probe.once("error", () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Wait until a port can be bound again, up to `budgetMs`.
 *
 * A rule that stops and immediately restarts otherwise races its own release: the listener is closed
 * but the OS has not finished tearing down its accepted sockets, and the retry fails with EADDRINUSE
 * against nothing. index.ts already carries a comment about that exact race for the gateway's own
 * listener; this is the same problem one layer down.
 */
export async function waitForRelease(port: number, host = "127.0.0.1", budgetMs = 2000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await probePort(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs).unref());
  }
}

export interface PortOwner {
  pid: number;
  name: string;
}

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? "" : String(stdout ?? ""));
    });
  });
}

/** The pid listening on `port`, from `netstat -ano`. */
async function listenerPid(port: number): Promise<number | null> {
  const out = await run("netstat.exe", ["-ano", "-p", "TCP"]);
  if (!out) return null;
  for (const line of out.split(/\r?\n/)) {
    // "  TCP    127.0.0.1:6380   0.0.0.0:0   LISTENING   1072"
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    // Match on the port only after the last colon, so ::1:6380 and 127.0.0.1:6380 both work and
    // 16380 never matches 6380.
    const local = parts[1];
    const colon = local.lastIndexOf(":");
    if (colon < 0 || Number(local.slice(colon + 1)) !== port) continue;
    const pid = Number(parts[4]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

/** The image name of a pid, from `tasklist`. */
async function processName(pid: number): Promise<string> {
  const out = await run("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const first = out.split(/\r?\n/).find((l) => l.trim().startsWith('"'));
  return first ? (first.split('","')[0] ?? "").replace(/^"/, "") : "";
}

/**
 * Who holds `port`, so a start failure can say "held by pid 1072 (forward-port.exe)" instead of
 * "EADDRINUSE". Returns null off win32, or when the holder cannot be identified.
 */
export async function portOwner(port: number): Promise<PortOwner | null> {
  if (process.platform !== "win32") return null;
  try {
    const pid = await listenerPid(port);
    if (!pid) return null;
    return { pid, name: (await processName(pid)) || `pid ${pid}` };
  } catch (err) {
    log("warn", "port owner lookup failed", { port, err: (err as Error).message });
    return null;
  }
}

/**
 * Force-release a port by killing its holder. Only ever called after an explicit confirmation in the
 * panel — this can kill a process that is doing real work, so it is never automatic.
 */
export function forceFree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!pid || pid === process.pid) return reject(new Error("refusing to kill the gateway itself"));
    if (process.platform !== "win32") {
      try { process.kill(pid, "SIGKILL"); resolve(); } catch (err) { reject(err as Error); }
      return;
    }
    execFile("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 10000 }, (err, _out, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      log("warn", "force-freed a port holder", { pid });
      resolve();
    });
  });
}
