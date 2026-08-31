import { describe, it, expect, vi, beforeEach } from "vitest";

/** Stand-in for the powershell spawn, so the caching and de-duplication logic can be exercised
 *  without a real process-tree walk. */
const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => execFile(...args) }));

const { getMemoryInfo, invalidateMemoryCache } = await import("../src/mem.js");

/** Answer the next spawn with `stdout`, or with an error when `err` is set. */
function reply(stdout: string | null, err: Error | null = null) {
  execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    setTimeout(() => cb(err, stdout ?? "", ""), 5);
  });
}

beforeEach(() => {
  execFile.mockReset();
  invalidateMemoryCache();
});

describe("getMemoryInfo", () => {
  it("reports the gateway without spawning anything when there are no children", async () => {
    const info = await getMemoryInfo([], true);
    expect(info.childrenMb).toBe(0);
    expect(info.gatewayMb).toBeGreaterThan(0);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not walk the tree unless asked", async () => {
    const info = await getMemoryInfo([1234], false);
    expect(info.childrenPending).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports children as unmeasured when the walk fails, rather than as zero", async () => {
    reply(null, new Error("timeout"));
    const info = await getMemoryInfo([1234], true);
    // "0 MB across 0 processes" is indistinguishable from "no children", and a slow WMI query under
    // load is exactly when an operator most needs to know the number is missing, not wrong.
    expect(info.childrenMb).toBeUndefined();
    expect(info.childrenPending).toBe(true);
  });

  it("does not cache a failed walk", async () => {
    reply(null, new Error("timeout"));
    await getMemoryInfo([1234], true);
    reply("52428800|2");
    const info = await getMemoryInfo([1234], true);
    expect(info.childrenMb).toBe(50);
    expect(info.processCount).toBe(3);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("shares one walk between concurrent callers", async () => {
    reply("52428800|2");
    const [a, b] = await Promise.all([getMemoryInfo([1234], true), getMemoryInfo([1234], true)]);
    // Two clicks on the memory chip must not each spawn a ~65 MB powershell — the very cost this
    // module exists to avoid.
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(a.childrenMb).toBe(50);
    expect(b.childrenMb).toBe(50);
  });

  it("reuses a successful walk for a while", async () => {
    reply("52428800|2");
    await getMemoryInfo([1234], true);
    const again = await getMemoryInfo([1234], true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(again.childrenMb).toBe(50);
  });
});
