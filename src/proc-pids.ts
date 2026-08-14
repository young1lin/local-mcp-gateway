import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-json.js";
import { treeKill, descendantPidsOf } from "./process-tree.js";
import { log } from "./log.js";

/**
 * A persisted ledger of the child-process PIDs this gateway instance has spawned for proc MCPs.
 *
 * Why: a proc MCP child (cmd -> npx -> server) is only torn down by `ProcAdapter.close()`, which runs
 * on a GRACEFUL shutdown. When the gateway is hard-killed (the watchdog's `taskkill /F`, a crash), no
 * close() runs and the whole subtree survives as orphans — and a fresh instance has no way to know
 * those PIDs by command alone (an arbitrary proc command isn't on any fixed match list). So each
 * successful build() records its wrapper PID here; on the next boot, before any proc MCP starts, we
 * tree-kill every recorded PID that is still alive and not a descendant of THIS instance.
 *
 * The descendant guard (`descendantPidsOf`) is the PID-reuse safety: a stale ledger entry whose PID
 * the OS has since reused for one of our own freshly-spawned children is left alone.
 *
 * The ledger is written atomically (temp+rename): being killed mid-write (exactly the scenario this
 * exists for) must not leave it torn, or the next boot would reap the wrong set.
 */
let file: string | undefined;

/** Where the ledger lives (a gitignored runtime file). Set once at boot (see index.ts). */
export function setProcPidFile(path: string): void {
  file = path;
}

function readLedger(): number[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.pids)) {
      return parsed.pids.filter((n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
    }
  } catch {
    /* missing or torn (a half-written pre-atomic file) — treat as empty; note() rewrites it whole */
  }
  return [];
}

function writeLedger(pids: number[]): void {
  if (!file) return;
  try {
    writeJsonAtomic(file, { pids });
  } catch (err) {
    log("warn", "proc-pid ledger save failed", { err: (err as Error).message });
  }
}

/** Record a proc child PID once build() succeeds, so a future boot can reap it if this one dies
 *  before close() runs. Idempotent. No-op until setProcPidFile() has pointed at a file. */
export function noteProcPid(pid: number): void {
  if (!file || !pid) return;
  const pids = readLedger();
  if (pids.includes(pid)) return;
  pids.push(pid);
  writeLedger(pids);
}

/** Drop a PID once its child closed cleanly, so it is no longer a candidate for orphan reaping. */
export function dropProcPid(pid: number): void {
  if (!file || !pid) return;
  const pids = readLedger();
  if (!pids.includes(pid)) return;
  writeLedger(pids.filter((p) => p !== pid));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reap proc children a PREVIOUS instance orphaned. Reads the ledger, clears it (this instance
 * rebuilds it as proc MCPs come up), then tree-kills every recorded PID that is still alive AND not a
 * descendant of THIS instance. Call once at boot, before any proc MCP starts.
 *
 * Returns the PIDs it killed (empty when the ledger was empty — in which case the PowerShell
 * descendant walk is skipped entirely, so the common no-proc boot stays cheap).
 */
export async function reapProcPids(ownPid: number): Promise<number[]> {
  const pids = readLedger();
  writeLedger([]); // clear first: a clean start repopulates it; never carry stale entries forward
  if (!pids.length) return []; // nothing recorded -> nothing to reap, and no need for the descendant walk
  const mine = await descendantPidsOf(ownPid);
  const killed: number[] = [];
  for (const pid of pids) {
    if (mine.has(pid)) continue; // belongs to THIS instance now — never touch it (PID-reuse guard)
    if (!alive(pid)) continue; // already gone — closed cleanly last run, or the OS reaped it
    log("warn", "reaping orphaned proc child from a previous gateway instance", { pid });
    await treeKill(pid);
    killed.push(pid);
  }
  if (killed.length) log("info", "proc-pid reap complete", { killed: killed.length });
  return killed;
}
