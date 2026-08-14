import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALLS_PAGE_SIZE, clearCalls, contentText, currentCallSource, flushCalls, logged, readCall, readCalls,
  forgetCallAlias, recordCall, renameCalls, setCallLogDir, startCallRetention, sweepCallLogs, withCallSource,
} from "../src/calls.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-calls-"));
setCallLogDir(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MCP = "call-log-test";

beforeEach(() => clearCalls(MCP));

/** Every read flushes pending appends, so a helper that just reads is enough to see a fresh call. */
async function entries(page = 0) {
  return (await readCalls(MCP, page)).calls;
}

describe("call log", () => {
  it("records the arguments and the reply, newest first", async () => {
    recordCall(MCP, { tool: "a", args: { sql: "SELECT 1" }, ok: true, ms: 3, output: "one" });
    recordCall(MCP, { tool: "b", args: undefined, ok: false, ms: 9, output: "boom" });

    const list = await entries();
    expect(list.map((e) => e.tool)).toEqual(["b", "a"]);
    expect(list[1].args).toBe('{"sql":"SELECT 1"}');
    expect(list[1].output).toBe("one");
    expect(list[0].ok).toBe(false);
    expect(list[0].args).toBe(""); // no arguments is not the string "undefined"
    expect(list[0].seq).toBe(2);
  });

  it("redacts secret-looking argument values", async () => {
    recordCall(MCP, { tool: "t", args: { user: "deploy", password: "hunter2", nested: { apiToken: "abc" } }, ok: true, ms: 1, output: "" });
    const [entry] = await entries();
    expect(entry.args).toContain("deploy");
    expect(entry.args).not.toContain("hunter2");
    expect(entry.args).not.toContain("abc");
  });

  it("survives a restart: a fresh reader sees the history and keeps counting", async () => {
    recordCall(MCP, { tool: "before", ok: true, ms: 1, output: "kept" });
    await flushCalls(MCP);

    // Same on-disk log, all in-memory state dropped — what a gateway restart looks like.
    setCallLogDir(dir);
    expect((await entries())[0]).toMatchObject({ tool: "before", output: "kept", seq: 1 });

    recordCall(MCP, { tool: "after", ok: true, ms: 1, output: "" });
    expect((await entries())[0].seq).toBe(2); // sequence continued, not restarted
  });

  it("pages, newest first, and reports whether older entries exist", async () => {
    for (let i = 1; i <= CALLS_PAGE_SIZE + 5; i++) recordCall(MCP, { tool: `t${i}`, ok: true, ms: 0, output: "x" });

    const first = await readCalls(MCP, 0);
    expect(first.calls.length).toBe(CALLS_PAGE_SIZE);
    expect(first.calls[0].tool).toBe(`t${CALLS_PAGE_SIZE + 5}`);
    expect(first.more).toBe(true);

    const second = await readCalls(MCP, 1);
    expect(second.calls.length).toBe(5);
    expect(second.calls[0].tool).toBe("t5");
    expect(second.more).toBe(false);
  });

  it("previews a long reply in a page and serves it whole by seq", async () => {
    // Bigger than any DB result the gateway will render (renderResult caps those at 256 KB).
    const big = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "y".repeat(60) })) });
    expect(big.length).toBeGreaterThan(262000);
    recordCall(MCP, { tool: "wide", ok: true, ms: 2, output: big });

    const [entry] = await entries();
    expect(entry.preview).toBe(true);
    expect(entry.body).toBe(true);
    expect(entry.output.length).toBe(2048); // the index line stays small, so paging stays cheap
    expect(entry.chars).toBe(big.length); // the reported size is the real one

    const full = await readCall(MCP, entry.seq);
    expect(full?.output).toBe(big); // whole, and therefore still valid JSON
    expect(full?.preview).toBeUndefined();
    expect(JSON.parse(full!.output).rows.length).toBe(4000);
  });

  it("keeps a short reply inline, with no payload file", async () => {
    recordCall(MCP, { tool: "small", ok: true, ms: 1, output: "PONG" });
    const [entry] = await entries();
    expect(entry.preview).toBeUndefined();
    expect(entry.body).toBeUndefined();
    expect((await readCall(MCP, entry.seq))?.output).toBe("PONG");
  });

  it("reports a pruned payload instead of returning a short result as whole", async () => {
    const big = "z".repeat(5000);
    recordCall(MCP, { tool: "wide", ok: true, ms: 1, output: big });
    await flushCalls(MCP);
    const [entry] = await entries();
    rmSync(join(dir, "bodies", MCP, `${entry.seq}.txt`)); // what pruning eventually does

    const full = await readCall(MCP, entry.seq);
    expect(full?.bodyGone).toBe(true);
    expect(full?.chars).toBe(5000);
  });

  it("tags the source of a call and defaults to mcp", async () => {
    expect(currentCallSource()).toBe("mcp");
    await withCallSource("panel", async () => {
      recordCall(MCP, { tool: "t", ok: true, ms: 1, output: "" });
      expect(currentCallSource()).toBe("panel");
    });
    expect((await entries())[0].via).toBe("panel");
    recordCall(MCP, { tool: "t2", ok: true, ms: 1, output: "" });
    expect((await entries())[0].via).toBe("mcp");
  });

  it("logs a thrown handler as a failed call and rethrows", async () => {
    await expect(
      logged(MCP, "explode", { a: 1 }, async () => { throw new Error("no such table: nope"); }, () => ({ ok: true, output: "" })),
    ).rejects.toThrow("no such table");
    const [entry] = await entries();
    expect(entry.ok).toBe(false);
    expect(entry.output).toBe("no such table: nope");
  });

  it("logs an in-band isError result as a failure", async () => {
    const result = { isError: true, content: [{ type: "text", text: "refused" }] };
    await logged(MCP, "t", undefined, async () => result, (r) => ({ ok: !r.isError, output: contentText(r) }));
    expect((await entries())[0]).toMatchObject({ ok: false, output: "refused" });
  });

  it("follows a rename and drops the log on clear", async () => {
    recordCall(MCP, { tool: "t", ok: true, ms: 1, output: "" });
    await renameCalls(MCP, "renamed-mcp");
    expect(await entries()).toEqual([]);
    expect((await readCalls("renamed-mcp")).calls.length).toBe(1);
    await clearCalls("renamed-mcp");
    expect((await readCalls("renamed-mcp")).calls).toEqual([]);
  });

  it("ignores a call with no MCP name (an adapter built without one)", async () => {
    recordCall(undefined, { tool: "t", ok: true, ms: 1, output: "" });
    expect((await readCalls("")).calls).toEqual([]);
  });

  it("flattens non-text content blocks", () => {
    expect(contentText({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a\n[image content]");
    expect(contentText({})).toBe("");
  });
});

describe("rename while a call is in flight", () => {
  it("files a call issued under the old name into the renamed log", async () => {
    await clearCalls("ren-a"); await clearCalls("ren-b");
    recordCall("ren-a", { tool: "t", args: {}, ok: true, ms: 1, output: "first" });
    await renameCalls("ren-a", "ren-b");
    // logged() captured the old name before the rename began; the append lands after it finished.
    recordCall("ren-a", { tool: "t", args: {}, ok: true, ms: 1, output: "second" });
    const page = await readCalls("ren-b");
    expect(page.calls.map((c) => c.output)).toEqual(["second", "first"]);
    expect((await readCalls("ren-a")).calls).toHaveLength(0);
    await clearCalls("ren-b");
  });

  it("stops redirecting once the old name is in use again", async () => {
    await clearCalls("ren-c"); await clearCalls("ren-d");
    await renameCalls("ren-c", "ren-d");
    forgetCallAlias("ren-c"); // a brand-new MCP registered under the freed name
    recordCall("ren-c", { tool: "t", args: {}, ok: true, ms: 1, output: "fresh" });
    expect((await readCalls("ren-d")).calls).toHaveLength(0);
    expect((await readCalls("ren-c")).calls.map((c) => c.output)).toEqual(["fresh"]);
    await clearCalls("ren-c"); await clearCalls("ren-d");
  });
});

describe("call log retention", () => {
    const AGED = "aged-mcp";
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

    /** Write an index directly, so entries can carry dates the clock cannot reach. */
    async function seed(mcp: string, rows: Array<{ seq: number; at: string; body?: boolean }>) {
      await clearCalls(mcp);
      const lines = rows.map((r) => JSON.stringify({
        seq: r.seq, at: r.at, tool: "t", via: "mcp", ok: true, ms: 1,
        args: "", output: "x", chars: 1, ...(r.body ? { preview: true, body: true } : {}),
      }));
      await writeFile(join(dir, `${mcp}.jsonl`), lines.join("\n") + "\n", "utf8");
      if (rows.some((r) => r.body)) {
        await mkdir(join(dir, "bodies", mcp), { recursive: true });
        for (const r of rows.filter((x) => x.body)) {
          await writeFile(join(dir, "bodies", mcp, `${r.seq}.txt`), "payload", "utf8");
        }
      }
    }

    it("drops entries past the half-year cutoff and keeps everything inside it", async () => {
      await seed(AGED, [
        { seq: 1, at: days(400) },
        { seq: 2, at: days(200) },
        { seq: 3, at: days(179) },  // just inside
        { seq: 4, at: days(1) },
      ]);
      await sweepCallLogs();
      await flushCalls(AGED);
      expect((await readCalls(AGED)).calls.map((c) => c.seq)).toEqual([4, 3]);
    });

    it("deletes the payload files of entries that aged out, and keeps the rest", async () => {
      await seed(AGED, [
        { seq: 1, at: days(400), body: true },
        { seq: 2, at: days(10), body: true },
      ]);
      await sweepCallLogs();
      await flushCalls(AGED);
      expect(existsSync(join(dir, "bodies", AGED, "1.txt"))).toBe(false);
      expect(existsSync(join(dir, "bodies", AGED, "2.txt"))).toBe(true);
    });

    it("sweeps a log whose MCP is never called again", async () => {
      // The point of the boot sweep: recordCall's own check only ever fires for a live MCP, so a log
      // nobody appends to is exactly the one that would keep year-old arguments forever.
      await seed("retired-mcp", [{ seq: 1, at: days(365) }, { seq: 2, at: days(300) }]);
      await sweepCallLogs();
      await flushCalls("retired-mcp");
      expect((await readCalls("retired-mcp")).calls).toHaveLength(0);
      await clearCalls("retired-mcp");
    });

    it("leaves a log alone when nothing in it has expired", async () => {
      await seed(AGED, [{ seq: 1, at: days(5) }, { seq: 2, at: days(2) }]);
      const before = await readFile(join(dir, `${AGED}.jsonl`), "utf8");
      await sweepCallLogs();
      await flushCalls(AGED);
      expect(await readFile(join(dir, `${AGED}.jsonl`), "utf8")).toBe(before); // not rewritten
    });

    it("keeps appending correctly after a sweep", async () => {
      await seed(AGED, [{ seq: 1, at: days(400) }, { seq: 7, at: days(3) }]);
      await sweepCallLogs();
      await flushCalls(AGED);
      recordCall(AGED, { tool: "after", args: {}, ok: true, ms: 1, output: "ok" });
      const list = (await readCalls(AGED)).calls;
      expect(list.map((c) => c.seq)).toEqual([8, 7]); // seq continues from the surviving tail
      expect(list[0].tool).toBe("after");
    });
  });
