import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALLS_PAGE_SIZE, clearCalls, contentText, currentCallSource, flushCalls, logged, readCall, readCalls,
  forgetCallAlias, readToolHistory, recordCall, renameCalls, setCallLogDir, startCallRetention,
  sweepCallLogs, withCallSource,
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

  it("redacts apiKey/authorization args — the wordlist the traffic ring always had", async () => {
    // This copy once lacked authorization|api[_-]?key: the same request was redacted in the traffic
    // view yet written PLAINTEXT here — and this file is the one that persists to disk.
    recordCall(MCP, { tool: "t", args: { apiKey: "sk-live-1", Authorization: "Bearer jt", passphrase: "pp", note: "keep" }, ok: true, ms: 1, output: "" });
    const [entry] = await entries();
    expect(entry.args).not.toContain("sk-live-1");
    expect(entry.args).not.toContain("jt");
    expect(entry.args).not.toContain("pp");
    expect(entry.args).toContain("keep");
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
    // The alias is the whole point of renameCalls, but it is process-global: left in place, every
    // LATER recordCall(MCP) in this file would silently file under "renamed-mcp" instead. The name is
    // free again now, exactly as when the registry registers a new MCP under it.
    forgetCallAlias(MCP);
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

  describe("readToolHistory (the Run tab's refill dropdown)", () => {
    it("lists one tool's newest runs first, skipping other tools, with a one-line args preview", async () => {
      recordCall(MCP, { tool: "pg_query", args: { sql: "SELECT 1" }, ok: true, ms: 2, output: "a" });
      recordCall(MCP, { tool: "other", args: {}, ok: true, ms: 1, output: "b" });
      recordCall(MCP, { tool: "pg_query", args: { sql: "SELECT\n  2\nFROM t" }, ok: false, ms: 4, output: "boom" });

      const hist = await readToolHistory(MCP, "pg_query");
      expect(hist.map((h) => h.seq)).toEqual([3, 1]); // newest first; the other tool never appears
      expect(hist[0]).toMatchObject({ via: "mcp", ok: false, ms: 4 });
      // JSON.stringify escapes the newlines, so they stay as \n escapes; the REAL whitespace around
      // them (the two-space indent) is what oneLine folds — a label is one line, spaces collapsed.
      expect(hist[0].args).toBe('{"sql":"SELECT\\n 2\\nFROM t"}');
      expect(hist[1].args).toBe('{"sql":"SELECT 1"}');
    });

    it("cuts a long args preview off, so one huge argument set cannot bloat the dropdown", async () => {
      recordCall(MCP, { tool: "wide", args: { q: "x".repeat(500) }, ok: true, ms: 1, output: "" });
      const [entry] = await readToolHistory(MCP, "wide");
      expect(entry.args.length).toBeLessThanOrEqual(97); // 96 chars + the ellipsis
      expect(entry.args).toContain("…");
    });

    it("collapses repeated runs of the same arguments into one entry, keeping the newest", async () => {
      recordCall(MCP, { tool: "t", args: { sql: "SELECT 1" }, ok: true, ms: 1, output: "" });
      recordCall(MCP, { tool: "t", args: { sql: "SELECT 2" }, ok: true, ms: 1, output: "" });
      recordCall(MCP, { tool: "t", args: { sql: "SELECT 1" }, ok: true, ms: 1, output: "" }); // repeat
      recordCall(MCP, { tool: "t", args: { sql: "SELECT 1" }, ok: true, ms: 1, output: "" }); // repeat

      const hist = await readToolHistory(MCP, "t");
      // Newest first: the repeated SELECT 1 is represented by its newest run (seq 4), then SELECT 2.
      expect(hist.map((h) => h.args)).toEqual(['{"sql":"SELECT 1"}', '{"sql":"SELECT 2"}']);
      expect(hist[0].seq).toBe(4); // the newest occurrence of the repeated arguments, not the first
    });

    it("keeps two long argument sets apart that merely share a clipped preview prefix", async () => {
      // Both previews clip to the same 96 chars, but the stored arguments differ — distinct is
      // decided on the full string, so both must appear.
      const base = "x".repeat(120);
      recordCall(MCP, { tool: "t", args: { q: base + "A" }, ok: true, ms: 1, output: "" });
      recordCall(MCP, { tool: "t", args: { q: base + "B" }, ok: true, ms: 1, output: "" });
      const hist = await readToolHistory(MCP, "t");
      expect(hist).toHaveLength(2);
      expect(hist[0].args).toBe(hist[1].args); // identical previews…
      expect(hist[0].seq).not.toBe(hist[1].seq); // …yet two entries, because the runs differ
    });

    it("filters by a case-insensitive substring of the FULL arguments, past the preview's clip", async () => {
      // The needle sits 200 chars in — far past the 96-char label — so only a match on the stored
      // arguments in full can find it. That is the dropdown's search box doing its one job.
      const pad = "y".repeat(200);
      recordCall(MCP, { tool: "f", args: { sql: pad + " ORDER BY rare_needle" }, ok: true, ms: 1, output: "" });
      recordCall(MCP, { tool: "f", args: { sql: "SELECT 1" }, ok: true, ms: 1, output: "" });
      recordCall(MCP, { tool: "f", args: { sql: pad + " ORDER BY other" }, ok: true, ms: 1, output: "" });

      const hit = await readToolHistory(MCP, "f", undefined, "rare_needle");
      expect(hit).toHaveLength(1);
      expect(hit[0].args).not.toContain("rare_needle"); // the label is clipped; the match was not

      expect((await readToolHistory(MCP, "f", undefined, "RARE_NEEDLE"))).toHaveLength(1); // case-blind

      expect((await readToolHistory(MCP, "f", undefined, "no-such-text"))).toHaveLength(0);

      const all = await readToolHistory(MCP, "f", undefined, "   "); // blank query = no filter
      expect(all).toHaveLength(3);
    });

    it("honours a smaller limit and never exceeds 300, however it is asked for", async () => {
      // Distinct arguments each call — the limit counts DISTINCT entries now, so the calls must vary.
      for (let i = 1; i <= 305; i++) recordCall(MCP, { tool: "t", args: { i }, ok: true, ms: 0, output: "" });
      expect((await readToolHistory(MCP, "t", 3)).map((h) => h.seq)).toEqual([305, 304, 303]);
      const capped = await readToolHistory(MCP, "t", 99_999);
      expect(capped).toHaveLength(300);
      expect(capped[0].seq).toBe(305); // the newest 300, not the oldest
    });

    it("answers an empty list for a tool that was never called", async () => {
      recordCall(MCP, { tool: "here", ok: true, ms: 0, output: "" });
      expect(await readToolHistory(MCP, "never")).toEqual([]);
    });
  });

describe("stored body pruning", () => {
  it("prunes stored body files by directory listing, not by sequence arithmetic", async () => {
    // 55 oversized replies → body files at seqs 1..55. Real logs are sparser (only a reply over
    // the 2 KB preview is stored at all); the arithmetic rm(seq - 50) missed the gaps and left
    // genuinely old payloads on disk forever. The newest BODY_KEEP(50) must stay readable in full.
    const big = "x".repeat(3 * 1024);
    for (let i = 0; i < 55; i++) {
      recordCall(MCP, { tool: "t", args: undefined, ok: true, ms: 1, output: big });
      await flushCalls(MCP);
    }
    expect((await readCall(MCP, 1))?.bodyGone).toBe(true); // past the keep window
    expect((await readCall(MCP, 5))?.bodyGone).toBe(true);
    expect((await readCall(MCP, 6))?.bodyGone).toBe(false); // the 50 newest stay whole
    const newest = await readCall(MCP, 55);
    expect(newest?.output.length).toBe(3 * 1024);
  });
});
