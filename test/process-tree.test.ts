import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { treeKill } from "../src/process-tree.js";

const isAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("treeKill", () => {
  // Regression for the orphan leak: the SDK's StdioClientTransport.close() never killed the child
  // at all. treeKill must actually terminate the target (and on Windows, via `taskkill /T`, its
  // whole descendant tree).
  it("terminates the target process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "pipe" });
    await new Promise<void>((r) => child.once("spawn", r));
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);

    await treeKill(pid);
    // Give taskkill / the OS a moment to reap it.
    await new Promise<void>((r) => setTimeout(r, 400));

    expect(isAlive(pid)).toBe(false);
  }, 10000);

  // Raised timeout: treeKill shells out to taskkill.exe on Windows, which can exceed the 5s default
  // when the whole suite runs in parallel — same family as the notes in daemon.test.ts / proc-pids.test.ts.
  it("resolves even when the pid is already gone (no throw)", async () => {
    await expect(treeKill(999999)).resolves.toBeUndefined();
    await expect(treeKill(0)).resolves.toBeUndefined();
  }, 15000);
});
