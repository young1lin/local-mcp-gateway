import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";

/**
 * A Windows real-time scanner can hold a just-written .tmp file long enough for its rename to fail
 * ONCE with EPERM — measured on the machine this project is developed on, and the reason a retention
 * sweep could silently no-op between two otherwise-identical full-suite runs (the expired entry
 * survived; the error was swallowed by the write queue's rate-limited catch). The mock makes that
 * exact single failure happen on demand, so the sweep's retry is tested against the failure it
 * exists for rather than by luck of machine load.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  let failNextRenames = 0;
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failNextRenames > 0) {
        failNextRenames--;
        const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.rename(from, to);
    },
    __failNextRenames: (n: number) => { failNextRenames = n; },
  };
});

import { setCallLogDir, sweepCallLogs, flushCalls, readCalls, clearCalls } from "../src/calls.js";

const failNextRenames = (n: number): void => {
  (fsp as typeof fsp & { __failNextRenames?: (n: number) => void }).__failNextRenames?.(n);
};

const dir = mkdtempSync(join(tmpdir(), "calls-atomic-"));

describe("call log sweep survives a transient rename failure", () => {
  beforeAll(() => setCallLogDir(dir));

  it("absorbs one EPERM on the tmp rename and still drops the expired entry", async () => {
    const mcp = "av-mcp";
    await clearCalls(mcp);
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    // Seed the index directly, so entries can carry dates the clock cannot reach (calls.test.ts's trick).
    const line = (seq: number, at: string) =>
      JSON.stringify({ seq, at, tool: "t", via: "mcp", ok: true, ms: 1, args: "", output: "x", chars: 1 });
    await fsp.writeFile(join(dir, `${mcp}.jsonl`), [line(1, days(400)), line(7, days(3))].join("\n") + "\n", "utf8");

    failNextRenames(1); // the scanner holds the .tmp exactly once
    await sweepCallLogs();
    await flushCalls(mcp);

    // With no retry, the swallowed EPERM left the whole sweep a no-op and seq 1 survived.
    expect((await readCalls(mcp)).calls.map((c) => c.seq)).toEqual([7]);
  });
});
