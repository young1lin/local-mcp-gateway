import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Traffic from "../src/traffic.js";

/**
 * Durability of the traffic ring: entries append to one JSONL tail and the boot path (initTrafficLog)
 * restores the newest KEEP of them. The bug this file pins: the ring used to be memory-only, so every
 * gateway restart blanked the Traffic view while the on-disk call log kept its history — the operator
 * saw "calls but no traffic" and read it as data loss, because it was.
 *
 * Restart is simulated with vi.resetModules + a fresh dynamic import, pointing the new module
 * instance at the same scratch directory the previous one wrote. Every test arms the log explicitly
 * (initTrafficLog) — an unarmed module stays memory-only, which is what the rest of the suite
 * (adminapi/router tests recording traffic without a scratch dir) still depends on.
 */
beforeEach(() => {
  vi.resetModules();
});

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "lmg-traffic-"));
  const mod = await import("../src/traffic.js");
  return { mod: mod as typeof Traffic, dir };
}

describe("traffic durability", () => {
  it("appends recorded entries to the log, redacted, and restores them on restart", async () => {
    const { mod, dir } = await fresh();
    await mod.initTrafficLog(dir);
    mod.recordTraffic("m1", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "app-a", version: "2" } },
    }, "tokA", true, 3, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }));
    mod.recordTraffic("m1", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "t", arguments: { password: "hunter2", q: "find me" } },
    }, "tokA", true, 5);
    await mod.flushTraffic();

    const raw = await readFile(join(dir, "traffic.jsonl"), "utf8");
    expect(raw).toContain("find me");
    expect(raw).toContain("app-a");
    expect(raw).not.toContain("hunter2"); // the disk tail is redacted like the ring it mirrors

    // "Restart": a fresh module instance over the same directory.
    const second = await import("../src/traffic.js") as typeof Traffic;
    await second.initTrafficLog(dir);
    const page = second.readTraffic();
    expect(page.totalUnfiltered).toBe(2);
    expect(page.entries[0].method).toBe("tools/call"); // newest first, as before the restart
    const topBefore = page.entries[0].seq;

    // Sequence numbers continue past the restored tail; a clientInfo-less frame of a known token is
    // still attributed to the client that announced itself before the restart.
    second.recordTraffic("m1", { jsonrpc: "2.0", id: 3, method: "tools/list" }, "tokA", true, 1);
    const after = second.readTraffic();
    expect(after.entries[0].seq).toBeGreaterThan(topBefore);
    expect(after.entries[0].clientName).toBe("app-a");
    await second.flushTraffic();
  });

  it("folds entries recorded during the boot load in without seq collisions", async () => {
    const { mod, dir } = await fresh();
    await mod.initTrafficLog(dir);
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "t1", true, 1);
    await mod.flushTraffic();

    // Restart and record IMMEDIATELY — before the tail has been read back.
    const second = await import("../src/traffic.js") as typeof Traffic;
    const load = second.initTrafficLog(dir);
    second.recordTraffic("m", { jsonrpc: "2.0", id: 2, method: "tools/call" }, "t1", true, 2);
    await load;
    await second.flushTraffic();

    const page = second.readTraffic();
    expect(page.totalUnfiltered).toBe(2);
    const seqs = page.entries.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no entry shadowed another's seq
    expect(page.entries[0].method).toBe("tools/call"); // the boot-race frame is the newest

    const raw = await readFile(join(dir, "traffic.jsonl"), "utf8");
    const onDisk = raw.split("\n").filter((l) => l.length).map((l) => JSON.parse(l).seq as number);
    expect(new Set(onDisk).size).toBe(onDisk.length);
    expect(onDisk).toEqual([...onDisk].sort((a, b) => a - b)); // append order stays chronological
  });

  it("clear rewrites the tail: a restart cannot resurrect cleared rows", async () => {
    const { mod, dir } = await fresh();
    await mod.initTrafficLog(dir);
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t" } }, "clrA", true, 1);
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "t" } }, "clrB", true, 1);
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "t" } }, "clrA", true, 1);
    await mod.flushTraffic();

    // Clear ONE client: the survivor stays, the client's rows leave the file as well as the ring.
    mod.clearTraffic("t:clrA");
    await mod.flushTraffic();
    const raw = await readFile(join(dir, "traffic.jsonl"), "utf8");
    expect(raw).not.toContain("clrA");
    expect(raw).toContain("clrB");

    const second = await import("../src/traffic.js") as typeof Traffic;
    await second.initTrafficLog(dir);
    expect(second.readTraffic().totalUnfiltered).toBe(1);
    expect(second.readTraffic().entries[0].client).toBe("clrB");

    // Clear ALL: the file is emptied too.
    second.clearTraffic();
    await second.flushTraffic();
    const emptied = await readFile(join(dir, "traffic.jsonl"), "utf8");
    expect(emptied).toBe("");
    const third = await import("../src/traffic.js") as typeof Traffic;
    await third.initTrafficLog(dir);
    expect(third.readTraffic().totalUnfiltered).toBe(0);
  });

  // 30s: the test deliberately writes ~2.4 MB through the real 2 MB budget to see the trim, and
  // Windows Defender scans every append — well past the 5s default on a cold cache.
  it("trims the tail to its byte budget, keeping the newest entries", { timeout: 30000 }, async () => {
    const { mod, dir } = await fresh();
    await mod.initTrafficLog(dir);
    // Entries near the 8 KB body cap: ~16 KB per line, so ~140 of them blow past the 2 MB budget.
    const big = "x".repeat(8 * 1024);
    for (let i = 0; i < 150; i++) {
      mod.recordTraffic("m", {
        jsonrpc: "2.0", id: i, method: "tools/call",
        params: { name: "t", arguments: { blob: big } },
      }, "t1", true, 1, JSON.stringify({ jsonrpc: "2.0", id: i, result: { content: [{ type: "text", text: big }] } }));
    }
    await mod.flushTraffic();
    const size = (await stat(join(dir, "traffic.jsonl"))).size;
    expect(size).toBeLessThan(2 * 1024 * 1024); // the budget held it near 1 MB, not 2.4 MB

    const second = await import("../src/traffic.js") as typeof Traffic;
    await second.initTrafficLog(dir);
    const page = second.readTraffic();
    expect(page.totalUnfiltered).toBeGreaterThan(50); // the newest entries survived the trim
    expect(page.entries[0].params).toContain("blob"); // and they are the real, recent ones
  });

  it("skips torn lines instead of failing the restore", async () => {
    const { mod, dir } = await fresh();
    await mod.initTrafficLog(dir);
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "t1", true, 1);
    await mod.flushTraffic();
    // Simulate a kill mid-append: a trailing half line (no newline terminator, invalid JSON).
    await writeFile(join(dir, "traffic.jsonl"), '{"seq":99,"mcp":"m","method":"to', { flag: "a" });

    const second = await import("../src/traffic.js") as typeof Traffic;
    await expect(second.initTrafficLog(dir)).resolves.toBeUndefined();
    expect(second.readTraffic().totalUnfiltered).toBe(1);
  });

  it("stays memory-only until armed: nothing is written without initTrafficLog", async () => {
    const { mod, dir } = await fresh();
    mod.recordTraffic("m", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "t1", true, 1);
    expect(mod.readTraffic().totalUnfiltered).toBe(1);
    await mod.flushTraffic();
    await expect(stat(join(dir, "traffic.jsonl"))).rejects.toThrow(); // no file was created
  });
});
