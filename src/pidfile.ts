import { readdirSync, readFileSync, rmSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-json.js";
import { dataDir, dataPath } from "./datadir.js";

/**
 * What `lmg start` records about the daemon it detached, so that a later `lmg stop` / `lmg status`
 * — run from any directory, possibly after a reboot — can find it and be sure it is still ours.
 *
 * `entry` and `node` are not decoration: a detached daemon outlives the CLI that started it, so by
 * the time anyone reads this file the PID may have been recycled by the OS into an unrelated
 * process. Killing it blind is how a supervisor takes down someone else's work, so `stop` confirms
 * identity (see daemon.ts) before it signals anything.
 */
export interface PidRecord {
  pid: number;
  /** The port it was told to listen on — how `stop`/`status` reach its /health endpoint. */
  port: number;
  /** Absolute path of the server entry it was started from. */
  entry: string;
  /** The node binary that runs it. */
  node: string;
  startedAt: string;
}

/** `gateway-<port>.pid`, so two instances on different ports never collide. */
const PID_FILE_RE = /^gateway-(\d{1,5})\.pid$/;

/**
 * Both files live in the data dir rather than beside the config, because they answer a
 * machine-level question: "is a gateway running here, and where do I read its output?" `lmg status`
 * has to answer that from any cwd, without first resolving which config a daemon was started with.
 */
export function pidFilePath(port: number): string {
  return dataPath(`gateway-${port}.pid`);
}

export function logFilePath(port: number): string {
  return dataPath(`gateway-${port}.log`);
}

function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Validate a parsed pid file. Returns a NEW record holding only the known fields — unknown keys are
 * dropped rather than rejected, so a file written by another version stays readable.
 *
 * A partial record is refused outright instead of being filled with defaults: every field here is
 * used to decide whether to kill a process, and a guessed default is exactly the wrong input to
 * that decision.
 */
export function parsePidRecord(raw: unknown): PidRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!posInt(r.pid) || !posInt(r.port)) return undefined;
  if (!nonEmpty(r.entry) || !nonEmpty(r.node) || !nonEmpty(r.startedAt)) return undefined;
  return { pid: r.pid, port: r.port, entry: r.entry, node: r.node, startedAt: r.startedAt };
}

/**
 * The record for a port, or undefined when there is none to be had. Missing, empty and torn files
 * are all "no daemon": this file's whole purpose is to be read after an unclean kill, so a parse
 * failure has to report "not running" rather than throw out of `lmg status`.
 */
export function readPidFile(port: number): PidRecord | undefined {
  try {
    return parsePidRecord(JSON.parse(readFileSync(pidFilePath(port), "utf8")));
  } catch {
    return undefined;
  }
}

/** Written atomically: being killed mid-write must not leave a torn file that hides a live daemon. */
export function writePidFile(rec: PidRecord): void {
  writeJsonAtomic(pidFilePath(rec.port), rec);
}

/** Idempotent — `stop` calls it on paths that may already be gone. */
export function removePidFile(port: number): void {
  rmSync(pidFilePath(port), { force: true });
}

/** Every port with a pid file, ascending. What `lmg status` lists and what `lmg stop` uses to
 *  decide whether it can act without being told a port. */
export function listDaemonPorts(): number[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir());
  } catch {
    return []; // no data dir yet — nothing has ever run
  }
  const ports: number[] = [];
  for (const name of entries) {
    const m = PID_FILE_RE.exec(name);
    if (m) ports.push(Number(m[1]));
  }
  return ports.sort((a, b) => a - b);
}

/** Whether a pid names a live process. Signal 0 tests for existence without delivering anything. */
export function pidAlive(pid: number): boolean {
  if (!posInt(pid)) return false; // pid 0 would signal the whole process group
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
