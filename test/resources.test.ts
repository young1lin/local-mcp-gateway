import { describe, it, expect } from "vitest";
import {
  collapseShards, describeFamily, humanBytes, page, splitUri, assertIdent, ResourceFault, SHARD_MIN,
} from "../src/adapters/resources.js";

describe("collapseShards", () => {
  it("collapses a real shard set into one entry, keeping the base table as its name", () => {
    const tables = [
      { name: "events", rows: 12_345_678, bytes: 3_000_000_000 },
      ...Array.from({ length: 1014 }, (_, i) => ({ name: `events_${i}`, rows: 1000, bytes: 100_000 })),
    ];
    const [family] = collapseShards(tables);
    expect(family.name).toBe("events");
    expect(family.representative).toBe("events");
    expect(family.members).toHaveLength(1015);
    expect(family.rows).toBe(12_345_678 + 1014 * 1000);
    expect(collapseShards(tables)).toHaveLength(1);
  });

  it("leaves incidental numeric suffixes alone — they are distinct tables, not shards", () => {
    const tables = [
      { name: "daily_stats_1" }, { name: "daily_stats_2" }, { name: "daily_stats_3" }, { name: "daily_stats_4" },
      { name: "logs_old_2" },
    ];
    expect(collapseShards(tables).map((f) => f.name).sort()).toEqual([
      "daily_stats_1", "daily_stats_2", "daily_stats_3", "daily_stats_4", "logs_old_2",
    ]);
  });

  it("collapses at exactly the threshold, and not one member below it", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `shard_${i}` }));
    expect(collapseShards(mk(SHARD_MIN))).toHaveLength(1);
    expect(collapseShards(mk(SHARD_MIN - 1))).toHaveLength(SHARD_MIN - 1);
  });

  it("names a base-less shard set with a star and reads DDL from its first member", () => {
    const [family] = collapseShards(Array.from({ length: 10 }, (_, i) => ({ name: `orders_${i}` })));
    expect(family.name).toBe("orders_*");
    expect(family.representative).toBe("orders_0");
  });

  it("groups date-suffixed shards too", () => {
    const months = Array.from({ length: 12 }, (_, i) => ({ name: `stats_2026${String(i + 1).padStart(2, "0")}` }));
    expect(collapseShards(months)).toHaveLength(1);
  });

  it("never produces an empty family name for an all-digit table name", () => {
    const out = collapseShards(Array.from({ length: 10 }, (_, i) => ({ name: String(1000 + i) })));
    for (const f of out) expect(f.name).not.toBe("");
    // Nothing to group by, so each stands alone rather than collapsing into "".
    expect(out).toHaveLength(10);
  });

  it("orders by size so the table that matters is on the first page", () => {
    const out = collapseShards([
      { name: "small", bytes: 10 },
      { name: "huge", bytes: 10_000_000 },
      { name: "medium", bytes: 5000 },
    ]);
    expect(out.map((f) => f.name)).toEqual(["huge", "medium", "small"]);
  });

  it("treats a missing row/byte estimate as zero rather than NaN", () => {
    const [f] = collapseShards([{ name: "fresh" }]);
    expect(f.rows).toBe(0);
    expect(f.bytes).toBe(0);
    expect(describeFamily(f)).toBe("");
  });
});

describe("describeFamily", () => {
  it("states rows, size and the shard range", () => {
    const [f] = collapseShards([
      { name: "events", rows: 12_345_678, bytes: 4_294_967_296 },
      ...Array.from({ length: 9 }, (_, i) => ({ name: `events_${i}`, rows: 1, bytes: 1 })),
    ]);
    const text = describeFamily(f);
    expect(text).toContain("~12,345,687 rows");
    expect(text).toContain("4.0 GB");
    expect(text).toContain("10 shards (events_0 … events_8)");
  });
});

describe("humanBytes", () => {
  it("scales and never reports a negative or fractional byte count", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(-5)).toBe("0 B");
    expect(humanBytes(812)).toBe("812 B");
    expect(humanBytes(12_700_000)).toBe("12.1 MB");
    expect(humanBytes(4_294_967_296)).toBe("4.0 GB");
  });
});

describe("page", () => {
  const items = Array.from({ length: 450 }, (_, i) => i);

  it("walks the list with the cursor and stops without one", () => {
    const p1 = page(items, undefined, 200);
    expect(p1.slice).toHaveLength(200);
    expect(p1.nextCursor).toBe("200");
    const p2 = page(items, p1.nextCursor, 200);
    expect(p2.slice[0]).toBe(200);
    const p3 = page(items, p2.nextCursor, 200);
    expect(p3.slice).toHaveLength(50);
    expect(p3.nextCursor).toBeUndefined();
  });

  it("rejects a cursor that is not a number, so a client cannot smuggle one in", () => {
    expect(() => page(items, "../etc/passwd")).toThrow(ResourceFault);
    expect(() => page(items, "-1")).toThrow(ResourceFault);
  });

  it("rejects a cursor past the end rather than silently returning nothing", () => {
    expect(() => page(items, "9999")).toThrow(ResourceFault);
    // Exactly at the end is a legitimate empty last page.
    expect(page(items, "450").slice).toEqual([]);
  });
});

describe("splitUri", () => {
  it("splits authority from path without lowercasing either", () => {
    expect(splitUri("mysql://Legacy_Db/Orders_Main", "mysql")).toEqual({
      authority: "Legacy_Db", rest: "Orders_Main",
    });
  });

  it("reports no path for a bare authority", () => {
    expect(splitUri("mysql://db", "mysql")).toEqual({ authority: "db", rest: undefined });
    expect(splitUri("mysql://db/", "mysql")).toEqual({ authority: "db", rest: undefined });
  });

  it("decodes percent-escapes in both halves", () => {
    expect(splitUri("pg://my%20db/public.a%2Fb", "pg")).toEqual({ authority: "my db", rest: "public.a/b" });
  });

  it("refuses another scheme, or a query string", () => {
    expect(() => splitUri("redis://db/x", "mysql")).toThrow(ResourceFault);
    expect(() => splitUri("mysql://db/x?y=1", "mysql")).toThrow(ResourceFault);
  });
});

describe("assertIdent", () => {
  it("passes real table names and refuses anything that could not be one", () => {
    expect(assertIdent("customers", "table name")).toBe("customers");
    expect(assertIdent("odd$name", "table name")).toBe("odd$name");
    for (const bad of ["a`b", "a b", "a;drop", "a.b", "", "x".repeat(65)]) {
      expect(() => assertIdent(bad, "table name")).toThrow(ResourceFault);
    }
  });
});
