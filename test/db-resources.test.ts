import { describe, it, expect } from "vitest";
import { mysqlResources } from "../src/adapters/mysql-resources.js";
import { pgResources } from "../src/adapters/pg-resources.js";
import { redisResources, keyShape, type RedisLike } from "../src/adapters/redis-resources.js";
import { ResourceFault } from "../src/adapters/resources.js";

// --- mysql ----------------------------------------------------------------------------------------

/** A stand-in MySQL: 1015 events shards, three ordinary tables, recording every statement it runs. */
function fakeMysql(tables?: string[]) {
  const names = tables ?? [
    "customers",
    "events",
    ...Array.from({ length: 1014 }, (_, i) => `events_${i}`),
    "events_x", // same prefix, not a shard — must not be counted as one
    "daily_stats_1", "daily_stats_2",
  ];
  const seen: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    seen.push({ sql, params });
    if (/FROM information_schema.tables\s+WHERE table_schema = \?$/.test(sql.trim())) {
      return names.map((name) => ({
        name,
        type: "BASE TABLE",
        rows_est: name === "events" ? 12_345_678 : 1000,
        bytes: name === "events" ? 4_294_967_296 : 4096,
      }));
    }
    if (sql.includes("table_name = ?")) {
      const want = String(params?.[1]);
      return names.includes(want) ? [{ type: "BASE TABLE", rows_est: 9843, bytes: 12_700_000 }] : [];
    }
    if (sql.includes("LIKE CONCAT")) {
      const prefix = String(params?.[1]).replace(/!(.)/g, "$1");
      return names.filter((n) => n.startsWith(prefix)).map((name) => ({ name }));
    }
    if (/^SHOW CREATE TABLE/.test(sql)) {
      return [{ Table: "x", "Create Table": "CREATE TABLE `x` (\n  `id` bigint NOT NULL\n)" }];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { query, seen };
}

describe("mysqlResources", () => {
  it("puts the overview first and collapses 1015 shards into one entry", async () => {
    const { query } = fakeMysql();
    const { resources, nextCursor } = await mysqlResources("shop", query).list();
    expect(resources[0]).toMatchObject({ uri: "mysql://shop", mimeType: "application/json" });
    const jour = resources.find((r) => r.uri === "mysql://shop/events");
    expect(jour?.description).toContain("1015 shards");
    // 1019 physical tables become 5 logical ones, so there is nothing to page.
    expect(resources.filter((r) => r.uri !== "mysql://shop")).toHaveLength(5);
    expect(nextCursor).toBeUndefined();
    expect(resources.some((r) => r.uri.endsWith("/events_500"))).toBe(false);
  });

  it("pages, and repeats the overview on no page but the first", async () => {
    const many = Array.from({ length: 450 }, (_, i) => `t_${String(i).padStart(3, "0")}_x`);
    const { query } = fakeMysql(many);
    const provider = mysqlResources("db", query);
    const p1 = await provider.list();
    expect(p1.resources).toHaveLength(201); // overview + 200
    expect(p1.nextCursor).toBe("200");
    const p2 = await provider.list(p1.nextCursor);
    expect(p2.resources).toHaveLength(200);
    expect(p2.resources.some((r) => r.uri === "mysql://db")).toBe(false);
    const p3 = await provider.list(p2.nextCursor);
    expect(p3.resources).toHaveLength(50);
    expect(p3.nextCursor).toBeUndefined();
  });

  it("reads the overview as JSON that names the collapsed shard sets", async () => {
    const { query } = fakeMysql();
    const [body] = await mysqlResources("shop", query).read("mysql://shop");
    const j = JSON.parse(body.text);
    expect(j.database).toBe("shop");
    expect(j.physicalTables).toBe(1019);
    expect(j.logicalTables).toBe(5);
    expect(j.collapsedShardSets[0]).toMatchObject({ table: "events", shards: 1015 });
    expect(j.largest[0].table).toBe("events");
  });

  it("reads a table as DDL with a header, and reports its shard siblings", async () => {
    const { query } = fakeMysql();
    const [body] = await mysqlResources("shop", query).read("mysql://shop/events");
    expect(body.mimeType).toBe("text/plain");
    expect(body.text).toContain("-- shop.events (base table)");
    expect(body.text).toContain("sharded: 1014 sibling tables events_0 … events_999");
    expect(body.text).toContain("CREATE TABLE `x`");
  });

  it("reads an individual shard directly, which the template promises", async () => {
    const { query } = fakeMysql();
    const [body] = await mysqlResources("shop", query).read("mysql://shop/events_7");
    expect(body.text).toContain("CREATE TABLE");
  });

  it("escapes LIKE wildcards in the sibling probe, so `_` is not a wildcard", async () => {
    const { query, seen } = fakeMysql();
    await mysqlResources("shop", query).read("mysql://shop/daily_stats_1");
    const like = seen.find((s) => s.sql.includes("LIKE CONCAT"));
    expect(like?.params?.[1]).toBe("daily!_stats!_1");
  });

  it("refuses a table that does not exist, another database, and an unusable identifier", async () => {
    const { query, seen } = fakeMysql();
    const provider = mysqlResources("shop", query);
    await expect(provider.read("mysql://shop/nope")).rejects.toThrow(ResourceFault);
    await expect(provider.read("mysql://other_db/customers")).rejects.toThrow(/connected to shop/);
    seen.length = 0;
    await expect(provider.read("mysql://shop/a`b")).rejects.toThrow(ResourceFault);
    expect(seen).toHaveLength(0); // rejected before any statement was sent
  });

  it("offers a template covering every table, including one shard", async () => {
    const { query } = fakeMysql();
    expect(mysqlResources("shop", query).templates()[0].uriTemplate).toBe("mysql://shop/{table}");
  });
});

// --- postgres -------------------------------------------------------------------------------------

function fakePg() {
  const seen: Array<{ sql: string; params?: unknown[] }> = [];
  const query = async (sql: string, params?: unknown[]) => {
    seen.push({ sql, params });
    if (sql.includes("GROUP BY 1")) return [{ schema: "public", tables: 2, bytes: 5000 }];
    if (sql.includes("$1") && sql.includes("json_agg")) {
      if (params?.[1] !== "channels") return [];
      return [{
        schema: params[0], name: "channels", type: "table", rows_est: 12, bytes: 4096, comment: null,
        columns: [{ column: "id", type: "character varying(26)", nullable: false, default: null }],
        primary_key: ["id"],
        indexes: ["CREATE UNIQUE INDEX channels_pkey ON public.channels USING btree (id)"],
      }];
    }
    return [
      { schema: "public", name: "channels", rows_est: 12, bytes: 4096 },
      { schema: "public", name: "posts", rows_est: 900, bytes: 90_000 },
    ];
  };
  return { query, seen };
}

describe("pgResources", () => {
  it("lists tables schema-qualified, largest first, with the overview ahead of them", async () => {
    const { resources } = await pgResources("chat", fakePg().query).list();
    expect(resources.map((r) => r.uri)).toEqual([
      "pg://chat", "pg://chat/public.posts", "pg://chat/public.channels",
    ]);
  });

  it("reads a table as JSON with columns, primary key and indexes", async () => {
    const [body] = await pgResources("chat", fakePg().query).read("pg://chat/public.channels");
    const j = JSON.parse(body.text);
    expect(j).toMatchObject({ database: "chat", schema: "public", table: "channels", primaryKey: ["id"] });
    expect(j.columns[0].column).toBe("id");
    expect(j.indexes[0]).toContain("channels_pkey");
    expect(j.size).toBe("4.0 KB");
  });

  it("defaults an unqualified name to the public schema", async () => {
    const { query, seen } = fakePg();
    await pgResources("chat", query).read("pg://chat/channels");
    const one = seen.find((s) => s.sql.includes("json_agg"));
    expect(one?.params).toEqual(["public", "channels"]);
  });

  it("passes identifiers as bound parameters, never interpolated", async () => {
    const { query, seen } = fakePg();
    await pgResources("chat", query).read("pg://chat/public.channels");
    for (const s of seen) expect(s.sql).not.toContain("channels'");
    expect(seen.some((s) => s.params?.includes("channels"))).toBe(true);
  });

  it("refuses an unknown table, a broken qualification, and the wrong database", async () => {
    const provider = pgResources("chat", fakePg().query);
    await expect(provider.read("pg://chat/public.nope")).rejects.toThrow(ResourceFault);
    await expect(provider.read("pg://chat/public.")).rejects.toThrow(ResourceFault);
    await expect(provider.read("pg://analytics/public.channels")).rejects.toThrow(/connected to chat/);
  });

  it("reads the overview with its schema breakdown", async () => {
    const [body] = await pgResources("chat", fakePg().query).read("pg://chat");
    const j = JSON.parse(body.text);
    expect(j.tables).toBe(2);
    expect(j.schemas[0]).toMatchObject({ schema: "public", tables: 2 });
  });
});

// --- redis ----------------------------------------------------------------------------------------

/** A Redis whose SCAN cursor NEVER returns 0 — the case that must still terminate. */
function fakeRedis(opts: { endless?: boolean; keys?: string[]; dbsize?: number } = {}): RedisLike & { rounds: number } {
  const keys = opts.keys ?? ["app:session:4711:token", "proxy:read:xyz", "job1760000000000"];
  const state = { rounds: 0 };
  return {
    rounds: 0,
    async scan(cursor, _m, _p, _c, count) {
      state.rounds++;
      (this as { rounds: number }).rounds = state.rounds;
      const batch = Array.from({ length: Math.min(count, 3) }, (_, i) => keys[i % keys.length]);
      return [opts.endless ? String(state.rounds + 1) : "0", batch];
    },
    async call(command: string) {
      if (command === "DBSIZE") return opts.dbsize ?? 100000;
      if (command === "INFO") return "# Server\r\nredis_version:6.2.20\r\n";
      if (command === "TYPE") return "string";
      return null;
    },
  };
}

describe("keyShape", () => {
  it("folds digits and truncates deep keys, so a big keyspace becomes a few buckets", () => {
    expect(keyShape("app:session:4711:token")).toBe("app:session:#:*");
    expect(keyShape("job1760000000000")).toBe("job#");
    expect(keyShape("cache:nodes:status")).toBe("cache:nodes:status");
    expect(keyShape("session:12345")).toBe("session:#");
  });
});

describe("redisResources", () => {
  it("exposes exactly one resource and no template — keys are not resources", async () => {
    const provider = redisResources("redis-b-6380", async () => fakeRedis());
    const { resources } = await provider.list();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe("redis://redis-b-6380/overview");
    expect(provider.templates()).toEqual([]);
  });

  it("reports key count, shapes and types from a live sample", async () => {
    const [body] = await redisResources("redis-b-6380", async () => fakeRedis({ dbsize: 36 })).read(
      "redis://redis-b-6380/overview",
    );
    const j = JSON.parse(body.text);
    expect(j.keys).toBe(36);
    expect(j.version).toBe("6.2.20");
    expect(j.sampleIsWholeKeyspace).toBe(true);
    expect(j.keyShapes.map((s: { shape: string }) => s.shape)).toContain("app:session:#:*");
    expect(j.types).toEqual({ string: 3 });
  });

  it("terminates on an endless SCAN cursor instead of looping forever", async () => {
    const client = fakeRedis({ endless: true });
    const [body] = await redisResources("r", async () => client).read("redis://r/overview");
    const j = JSON.parse(body.text);
    expect(client.rounds).toBe(20); // MAX_ROUNDS, not infinity
    expect(j.sampleIsWholeKeyspace).toBe(false);
    expect(j.notes.some((n: string) => n.includes("SCAN rounds"))).toBe(true);
    // Counts are extrapolated from the sample, and say so.
    expect(j.keyShapes[0].estimatedKeys).toBeGreaterThan(j.keyShapes[0].sampled);
  });

  it("refuses any URI but its own overview", async () => {
    const provider = redisResources("redis-b-6380", async () => fakeRedis());
    await expect(provider.read("redis://redis-b-6380/keys/foo")).rejects.toThrow(ResourceFault);
    await expect(provider.read("redis://other/overview")).rejects.toThrow(ResourceFault);
  });

  it("survives a server that refuses INFO or DBSIZE", async () => {
    const broken: RedisLike = {
      async scan() { return ["0", ["a"]]; },
      async call() { throw new Error("NOPERM"); },
    };
    const [body] = await redisResources("r", async () => broken).read("redis://r/overview");
    const j = JSON.parse(body.text);
    expect(j.keys).toBe(0);
    expect(j.version).toBeUndefined();
    expect(j.types).toEqual({ unknown: 1 });
  });
});
