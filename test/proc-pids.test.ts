import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcPidFile, noteProcPid, dropProcPid, reapProcPids } from "../src/proc-pids.js";
import { treeKill } from "../src/process-tree.js";

const isAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proc-pids-"));
  file = join(dir, "proc-pids.json");
  setProcPidFile(file);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ledger(): number[] {
  return JSON.parse(readFileSync(file, "utf8")).pids;
}

describe("proc-pid ledger", () => {
  it("notes and drops PIDs (idempotent), persisted atomically", () => {
    noteProcPid(111);
    noteProcPid(222);
    noteProcPid(111); // idempotent — no duplicate
    expect(ledger()).toEqual([111, 222]);
    dropProcPid(111);
    expect(ledger()).toEqual([222]);
    dropProcPid(999); // unknown pid — no-op, file unchanged
    expect(ledger()).toEqual([222]);
  });

  // Raised timeout: spawns + kills real children; see the matching note in daemon.test.ts.
  it("clears the ledger on reap (a clean start repopulates it as MCPs come up)", { timeout: 20000 }, async () => {
    noteProcPid(999999); // not alive
    await reapProcPids(process.pid);
    expect(ledger()).toEqual([]);
  });

  it("does NOT reap a PID that is a descendant of this process (PID-reuse safety)", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "pipe" });
    await new Promise<void>((r) => child.once("spawn", r));
    try {
      noteProcPid(child.pid!);
      // The child IS our own descendant, so reap must skip it even though it is alive and recorded.
      const killed = await reapProcPids(process.pid);
      expect(killed).toEqual([]);
      expect(isAlive(child.pid)).toBe(true);
    } finally {
      await treeKill(child.pid!);
    }
  }, 15000);

  it("reaps a recorded PID that is NOT a descendant (an orphan from a dead instance)", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "pipe" });
    await new Promise<void>((r) => child.once("spawn", r));
    expect(isAlive(child.pid)).toBe(true);
    noteProcPid(child.pid!);
    // ownPid is a non-existent ancestor, so the descendant walk never reaches the child -> it is an orphan.
    const killed = await reapProcPids(999999);
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(killed).toEqual([child.pid]);
    expect(isAlive(child.pid)).toBe(false);
  }, 15000);
});
