import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeAdapter } from "../src/adapters/factory.js";
import { MysqlAdapter, mysqlListTables, mysqlPoolOptions, mysqlSessionSql, pingOk, wireMysqlSession } from "../src/adapters/mysql.js";
import { bsonPlain } from "../src/adapters/mongo.js";
import { Long, ObjectId, Timestamp } from "mongodb";
import { RedisAdapter, typeAwareRead, readWindow, type RedisReadClient } from "../src/adapters/redis.js";
import { PgAdapter } from "../src/adapters/pg.js";
import { Lazy } from "../src/adapters/direct.js";
import { MongoAdapter, writesViaAggregate } from "../src/adapters/mongo.js";
import { ProcAdapter } from "../src/adapters/proc.js";
import { makeToolServer } from "../src/adapters/tool-server.js";
import { openSession } from "../src/introspect.js";
import { DEFAULT_TABLE_LIMIT } from "../src/adapters/sql.js";

/** Announcing a capability needs no DB: makeServer() reads the def and builds the Server, and the
 *  provider's query runs only on an actual list/read. So the resources toggle is testable offline. */
async function caps(server: ReturnType<MysqlAdapter["makeServer"]>) {
  const client = await openSession(server);
  const c = client.getServerCapabilities();
  await client.close();
  return c;
}

/** The tool names a client sees from tools/list — the filtered set. */
async function toolNames(server: ReturnType<MysqlAdapter["makeServer"]>) {
  const client = await openSession(server);
  const list = await client.listTools();
  await client.close();
  return list.tools.map((t) => t.name);
}

describe("makeAdapter routes by type", () => {
  it("creates the right adapter class per type", () => {
    expect(makeAdapter({ type: "mysql", host: "x" })).toBeInstanceOf(MysqlAdapter);
    expect(makeAdapter({ type: "redis", host: "x" })).toBeInstanceOf(RedisAdapter);
    expect(makeAdapter({ type: "pg", url: "x" })).toBeInstanceOf(PgAdapter);
    expect(makeAdapter({ type: "mongo", url: "x" })).toBeInstanceOf(MongoAdapter);
    expect(makeAdapter({ type: "proc", command: "npx -y x" })).toBeInstanceOf(ProcAdapter);
  });

  it("throws on an unknown type", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => makeAdapter({ type: "nope" } as any)).toThrow(/Unknown adapter type/);
  });
});

describe("RedisAdapter command guard", () => {
  const adapter = (def: Record<string, unknown> = {}) => new RedisAdapter({ type: "redis", host: "localhost", ...def });

  // The adapter holds ONE shared connection: SUBSCRIBE/MONITOR would leave it in a mode it never
  // exits, breaking every later call on that endpoint until restart, and BLPOP would hang forever.
  it("rejects commands that would break the shared connection", () => {
    for (const cmd of ["SUBSCRIBE", "psubscribe", "MONITOR", "RESET", "SELECT", "BLPOP", "BZPOPMIN", "WAIT", "XREAD"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/rejected/i);
    }
  });

  it("rejects commands that would disrupt the server", () => {
    for (const cmd of ["SHUTDOWN", "DEBUG", "REPLICAOF", "FAILOVER", "MIGRATE", "SWAPDB"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/rejected/i);
    }
  });

  it("gates FLUSHALL/FLUSHDB behind allowDestructive", () => {
    expect(() => adapter().assertCommandAllowed("FLUSHALL")).toThrow(/allowDestructive/);
    expect(() => adapter({ allowDestructive: true }).assertCommandAllowed("FLUSHALL")).not.toThrow();
  });

  it("allows ordinary commands, and only reads when readonly", () => {
    expect(() => adapter().assertCommandAllowed("XRANGE")).not.toThrow();
    expect(() => adapter().assertCommandAllowed("SETRANGE")).not.toThrow();
    expect(() => adapter({ readonly: true }).assertCommandAllowed("GET")).not.toThrow();
    expect(() => adapter({ readonly: true }).assertCommandAllowed("SETRANGE")).toThrow(/readonly/);
  });

  it("requires a command", () => {
    expect(() => adapter().assertCommandAllowed("  ")).toThrow(/required/);
  });

  // Scripting is the one family the guard cannot reason about: every other rule here inspects a
  // command name, and a script's contents are opaque to all of them. `EVAL "redis.call('FLUSHALL')"`
  // is a rejected command smuggled through an accepted one.
  it("rejects scripting, and says why, since no other rule can see inside a script", () => {
    for (const cmd of ["EVAL", "evalsha", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/cannot see inside/i);
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/allowEval/);
    }
  });

  it("runs scripts once allowEval is set — the escape hatch is a config decision, not a runtime one", () => {
    const ok = adapter({ allowEval: true });
    for (const cmd of ["EVAL", "EVALSHA", "FCALL"]) {
      expect(() => ok.assertCommandAllowed(cmd), cmd).not.toThrow();
    }
  });

  // A readonly MCP that can run arbitrary Lua is not readonly. Rather than silently letting the
  // stronger flag win, say the two contradict.
  it("still refuses a script when the MCP is readonly, even with allowEval", () => {
    expect(() => adapter({ allowEval: true, readonly: true }).assertCommandAllowed("EVAL")).toThrow(/contradict/i);
  });

  // SCRIPT KILL is the only cure for a runaway script, and it cannot work here: the shared
  // connection is already blocked waiting for the script that needs killing. So the management
  // surface stays shut even when scripts are allowed — a script comes in inline, or not at all.
  it("never exposes script management, allowEval or not", () => {
    for (const def of [{}, { allowEval: true }]) {
      for (const cmd of ["SCRIPT", "FUNCTION"]) {
        expect(() => adapter(def).assertCommandAllowed(cmd), cmd).toThrow(/redis-cli/);
      }
    }
  });

  it("rejects the commands that hand out or overwrite the server's own credentials and code", () => {
    expect(() => adapter().assertCommandAllowed("MODULE")).toThrow(/native code/);
    expect(() => adapter().assertCommandAllowed("ACL")).toThrow(/credentials/);
  });

  it("rejects replication commands, which never return on this connection", () => {
    for (const cmd of ["SYNC", "PSYNC", "REPLCONF"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/replication/i);
    }
  });

  it("rejects the disk-write commands, SAVE first — it blocks the whole server", () => {
    expect(() => adapter().assertCommandAllowed("SAVE")).toThrow(/blocks/);
    for (const cmd of ["BGSAVE", "BGREWRITEAOF"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/rejected/);
    }
  });

  // MULTI is subtle and worse than it looks: on a shared connection, one call's open transaction
  // queues every OTHER call's commands into it, and they all get QUEUED instead of an answer.
  it("rejects transaction commands — one call's MULTI would swallow every other call", () => {
    for (const cmd of ["MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH"]) {
      expect(() => adapter().assertCommandAllowed(cmd), cmd).toThrow(/rejected/);
    }
  });

  // KEYS was allowed because it is a read. Being a read is not the point: it walks the whole
  // keyspace in one blocking pass, and it is the single likeliest reflex when asked to find a key.
  it("rejects KEYS for everyone, not just readonly, and names the tool to use instead", () => {
    for (const def of [{}, { readonly: true }, { allowDestructive: true }]) {
      expect(() => adapter(def).assertCommandAllowed("KEYS")).toThrow(/redis_scan/);
    }
  });

  describe("container commands, where the subcommand decides", () => {
    it("permits CONFIG GET but not CONFIG SET — one reads, the other rewrites the server", () => {
      expect(() => adapter().assertCommandAllowed("CONFIG", ["GET", "maxmemory"])).not.toThrow();
      expect(() => adapter({ readonly: true }).assertCommandAllowed("CONFIG", ["get", "maxmemory"])).not.toThrow();
      expect(() => adapter().assertCommandAllowed("CONFIG", ["SET", "dir", "/tmp"])).toThrow(/CONFIG SET is rejected/);
      expect(() => adapter().assertCommandAllowed("CONFIG", ["REWRITE"])).toThrow(/rejected/);
    });

    it("permits the CLIENT reads but not the ones that cut off connections or freeze the server", () => {
      for (const sub of ["ID", "INFO", "LIST", "GETNAME"]) {
        expect(() => adapter().assertCommandAllowed("CLIENT", [sub]), sub).not.toThrow();
      }
      for (const sub of ["KILL", "PAUSE", "UNPAUSE", "REPLY", "NO-EVICT"]) {
        expect(() => adapter().assertCommandAllowed("CLIENT", [sub]), sub).toThrow(/rejected/);
      }
    });

    it("permits the CLUSTER reads but not the ones that dismantle the topology", () => {
      expect(() => adapter().assertCommandAllowed("CLUSTER", ["INFO"])).not.toThrow();
      expect(() => adapter().assertCommandAllowed("CLUSTER", ["NODES"])).not.toThrow();
      for (const sub of ["RESET", "FORGET", "FAILOVER", "SETSLOT", "FLUSHSLOTS"]) {
        expect(() => adapter().assertCommandAllowed("CLUSTER", [sub]), sub).toThrow(/rejected/);
      }
    });

    it("treats a container command's write subcommand as a write, so readonly blocks it", () => {
      expect(() => adapter().assertCommandAllowed("MEMORY", ["PURGE"])).not.toThrow();
      expect(() => adapter({ readonly: true }).assertCommandAllowed("MEMORY", ["PURGE"])).toThrow(/readonly/);
      expect(() => adapter({ readonly: true }).assertCommandAllowed("MEMORY", ["USAGE", "k"])).not.toThrow();
    });

    it("rejects a bare container command and lists what it will take", () => {
      expect(() => adapter().assertCommandAllowed("CONFIG")).toThrow(/subcommand/);
      expect(() => adapter().assertCommandAllowed("CONFIG")).toThrow(/GET/);
    });
  });
});

// The dispatch behind redis_read. A scripted ioredis stand-in — only the methods the reader
// touches — so every type's shape, cap and truncation flag is testable without a Redis.
describe("typeAwareRead (the dispatch behind redis_read)", () => {
  function fake(over: Partial<RedisReadClient> = {}): RedisReadClient {
    return {
      type: async () => "none",
      ttl: async () => -2,
      get: async () => null,
      llen: async () => 0,
      lrange: async () => [],
      hlen: async () => 0,
      scard: async () => 0,
      zcard: async () => 0,
      xlen: async () => 0,
      call: async () => [],
      ...over,
    };
  }
  const read = (client: RedisReadClient, key = "k", offset = 0, limit = 100) =>
    typeAwareRead(client, key, offset, limit);

  it("reads a string: value only, no length to report", async () => {
    const out = await read(fake({ type: async () => "string", ttl: async () => -1, get: async () => "hello" }));
    expect(out).toEqual({ key: "k", type: "string", ttl: -1, value: "hello" });
  });

  // The whole point of the tool: a missing key is a typed fact, not a null to interpret.
  it("answers a missing key with type none instead of an error", async () => {
    expect(await read(fake())).toEqual({ key: "k", type: "none", ttl: -2, value: null });
  });

  it("pairs a hash's flat HSCAN reply into an object", async () => {
    const out = await read(fake({
      type: async () => "hash",
      ttl: async () => 300,
      hlen: async () => 2,
      call: async () => ["0", ["a", "1", "b", "2"]],
    }));
    expect(out).toEqual({ key: "k", type: "hash", ttl: 300, length: 2, value: { a: "1", b: "2" } });
  });

  it("marks a hash truncated when the entry cap stops collection before the cursor runs out", async () => {
    let rounds = 0;
    const out = await read(fake({
      type: async () => "hash",
      ttl: async () => -1,
      hlen: async () => 5000,
      // Never reaches cursor 0 — every round returns a fresh cursor, so only the cap can end it.
      call: async () => [String(++rounds * 100), ["f" + rounds, "v" + rounds]],
    }));
    expect(rounds).toBeGreaterThanOrEqual(5); // it collected past one batch before stopping
    expect((out.value as Record<string, string>).f1).toBe("v1");
    expect(out.truncated).toBe(true);
    expect(out.length).toBe(5000);
    // A bare flag gives a model nothing to act on when the field it wants sits beyond the cap.
    expect(String(out.note)).toMatch(/HGET/);
  });

  it("points a truncated set at SISMEMBER for the one-member check", async () => {
    let rounds = 0;
    const out = await read(fake({
      type: async () => "set",
      ttl: async () => -1,
      scard: async () => 9000,
      call: async () => [String(++rounds * 100), ["member" + rounds]],
    }));
    expect(out.truncated).toBe(true);
    expect(String(out.note)).toMatch(/SISMEMBER/);
  });

  it("pages a list by offset/limit and flags what is left", async () => {
    const out = await read(fake({
      type: async () => "list",
      ttl: async () => -1,
      llen: async () => 250,
      lrange: async (_k, start, stop) => Array.from({ length: stop - start + 1 }, (_, i) => "item" + (start + i)),
    }), "k", 100, 50);
    expect((out.value as string[])[0]).toBe("item100");
    expect(out.value).toHaveLength(50);
    expect(out.truncated).toBe(true); // 100 + 50 < 250
  });

  it("omits truncated when the whole list fits the window", async () => {
    const out = await read(fake({
      type: async () => "list",
      ttl: async () => -1,
      llen: async () => 2,
      lrange: async () => ["a", "b"],
    }));
    expect(out).toEqual({ key: "k", type: "list", ttl: -1, length: 2, value: ["a", "b"] });
  });

  it("sorts and dedupes set members, so the same key reads the same twice", async () => {
    const out = await read(fake({
      type: async () => "set",
      ttl: async () => -1,
      scard: async () => 2,
      call: async () => ["0", ["pear", "apple", "pear"]],
    }));
    expect(out.value).toEqual(["apple", "pear"]);
    expect(out.truncated).toBeUndefined();
  });

  it("shapes a zset as member→score in rank order, scores as numbers", async () => {
    const out = await read(fake({
      type: async () => "zset",
      ttl: async () => -1,
      zcard: async () => 3,
      call: async () => ["winner", "9.5", "runner-up", "3", "third", "inf"],
    }));
    expect(out.value).toEqual({ winner: 9.5, "runner-up": 3, third: "inf" }); // inf has no JSON number
    expect(Object.keys(out.value as object)).toEqual(["winner", "runner-up", "third"]); // rank order kept
  });

  it("shapes stream entries as { id, fields } and honors offset", async () => {
    const out = await read(fake({
      type: async () => "stream",
      ttl: async () => -1,
      xlen: async () => 3,
      call: async () => [
        ["1-0", ["topic", "a", "n", "1"]],
        ["2-0", ["topic", "b", "n", "2"]],
        ["3-0", ["topic", "c", "n", "3"]],
      ],
    }), "k", 1, 1);
    expect(out.value).toEqual([{ id: "2-0", fields: { topic: "b", n: "2" } }]);
    expect(out.truncated).toBe(true); // 1 + 1 < 3
  });

  // A hash field named __proto__ must survive as data. In a plain object it would bend (or be
  // silently dropped by) the prototype — the reason pairFlat builds on Object.create(null).
  it("keeps a field literally named __proto__ as data, through JSON too", async () => {
    const out = await read(fake({
      type: async () => "hash",
      ttl: async () => -1,
      hlen: async () => 2,
      call: async () => ["0", ["__proto__", "x", "constructor", "y"]],
    }));
    const value = out.value as Record<string, string>;
    expect(Object.keys(value)).toEqual(["__proto__", "constructor"]);
    expect(value["__proto__"]).toBe("x");
    expect(JSON.parse(JSON.stringify(out)).value["__proto__"]).toBe("x"); // survives the wire
  });

  it("names the escape hatch for a module type instead of failing opaquely", async () => {
    const out = await read(fake({ type: async () => "ReJSON-RL", ttl: async () => -1 }));
    expect(out.type).toBe("ReJSON-RL");
    expect(String(out.note)).toMatch(/redis_command/);
  });

  it("readWindow: defaults 0/100, nonsense falls back, limit clamped to 1000, negatives zeroed", () => {
    expect(readWindow(undefined)).toEqual({ offset: 0, limit: 100 });
    expect(readWindow({ offset: -5, limit: 99999 })).toEqual({ offset: 0, limit: 1000 });
    expect(readWindow({ offset: "40", limit: "7" })).toEqual({ offset: 40, limit: 7 });
    expect(readWindow({ offset: Number.NaN, limit: Number.NaN })).toEqual({ offset: 0, limit: 100 });
  });
});

describe("redis_read as advertised on tools/list", () => {
  it("documents the paging params and the no-WRONGTYPE promise in its description", async () => {
    const r = new RedisAdapter({ type: "redis" }, "r");
    const client = await openSession(r.makeServer());
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "redis_read");
      expect(tool).toBeDefined();
      expect(tool!.description).toContain("WRONGTYPE");
      const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props).sort()).toEqual(["key", "limit", "offset"]);
      expect(tool!.inputSchema).toMatchObject({ required: ["key"] });
    } finally {
      await client.close();
    }
  });

  it("redis_scan advertises the optional type filter", async () => {
    const r = new RedisAdapter({ type: "redis" }, "r");
    const client = await openSession(r.makeServer());
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "redis_scan");
      const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.type).toBeDefined();
    } finally {
      await client.close();
    }
  });
});

describe("makeToolServer (shared by the direct adapters)", () => {
  it("lists tools and routes calls to the handler (no DB needed)", async () => {
    const server = makeToolServer(
      [{ name: "t", description: "d", inputSchema: { type: "object", properties: { x: { type: "string" } } } }],
      async (_name, args) => ({ echoed: args?.x }),
    );
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([client.connect(c), server.connect(s)]);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(["t"]);

    const res = await client.callTool({ name: "t", arguments: { x: "hi" } } as never);
    expect((res.content as Array<{ text: string }>)[0].text).toBe(JSON.stringify({ echoed: "hi" }, null, 2));
  }, 10000);
});

describe("resources toggle", () => {
  it("announces resources.listChanged by default when the adapter has something to expose", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "shop" }, "mysql");
    expect((await caps(a.makeServer()))?.resources).toEqual({ listChanged: true });
  });

  // "Off" keeps the capability (so notifications/resources/list_changed stays valid) but empties the
  // list — symmetric with a hidden tool staying in the tools capability but dropping from its content.
  it("keeps the capability but returns an empty list when toggled off", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "shop" }, "mysql");
    a.resourceToggle.on = false;
    const client = await openSession(a.makeServer());
    expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: true });
    const list = await client.listResources();
    expect(list.resources).toEqual([]);
    await client.close();
  });

  it("honors exposeResources:false from the def as the default, until toggled live", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "shop", exposeResources: false }, "mysql");
    expect(a.resourceToggle.on).toBe(false);
    const boolStr = new MysqlAdapter({ type: "mysql", database: "d", exposeResources: "false" }, "m");
    expect(boolStr.resourceToggle.on).toBe(false);
  });

  it("announces nothing when there is no database to scope a listing to", async () => {
    const a = new MysqlAdapter({ type: "mysql" }, "mysql");
    expect((await caps(a.makeServer()))?.resources).toBeUndefined();
  });

  it("is live — flip resourceToggle.on and the next list reflects it", async () => {
    const a = new RedisAdapter({ type: "redis" }, "r");
    a.resourceToggle.on = false;
    let client = await openSession(a.makeServer());
    expect((await client.listResources()).resources).toEqual([]);
    await client.close();
    a.resourceToggle.on = true;
    client = await openSession(a.makeServer());
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    await client.close();
  });

  it("gates the redis and pg adapters the same way", async () => {
    expect((await caps(new RedisAdapter({ type: "redis" }, "r").makeServer()))?.resources).toEqual({ listChanged: true });
    expect((await caps(new PgAdapter({ type: "pg", url: "postgresql://u:p@h/db" }, "p").makeServer()))?.resources).toEqual({ listChanged: true });
  });
});

describe("tool toggle (disabledTools)", () => {
  it("announces tools.listChanged so a client knows to listen for the notification", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "db" }, "mysql");
    expect((await caps(a.makeServer()))?.tools).toEqual({ listChanged: true });
  });

  it("lists every tool when nothing is disabled", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "db" }, "mysql");
    expect(await toolNames(a.makeServer())).toEqual(["mysql_query", "mysql_list_tables"]);
    const r = new RedisAdapter({ type: "redis" }, "r");
    expect(await toolNames(r.makeServer())).toEqual(["redis_scan", "redis_read", "redis_command"]);
  });

  it("hides a disabled tool from tools/list — it simply disappears, there is no other mechanism", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: ["redis_command"] }, "r");
    expect(await toolNames(r.makeServer())).toEqual(["redis_scan", "redis_read"]);
  });

  it("hides several, and is live — mutate the shared toggle, the next makeServer already reflects it", async () => {
    const def = { type: "redis" };
    const r = new RedisAdapter(def, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(3);
    r.toolToggle.disabled = new Set(["redis_scan", "redis_read"]);
    expect(await toolNames(r.makeServer())).toEqual(["redis_command"]);
    r.toolToggle.disabled = new Set();
    expect(await toolNames(r.makeServer())).toHaveLength(3);
  });

  it("ignores a disabledTools entry that names no real tool, rather than erroring", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: ["no_such_tool"] }, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(3);
  });

  it("treats a non-array disabledTools as empty (defensive against bad config)", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: "redis_command" }, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(3);
  });
});

describe("list_tables tools (the optional grep name filter)", () => {
  /** The inputSchema of one tool off a live tools/list, without needing any database. */
  async function schemaOf(adapter: MysqlAdapter | PgAdapter, tool: string): Promise<Record<string, unknown>> {
    const client = await openSession(adapter.makeServer());
    try {
      const list = await client.listTools();
      const found = list.tools.find((t) => t.name === tool);
      expect(found, tool).toBeTruthy();
      return (found!.inputSchema as { properties: Record<string, unknown> }).properties;
    } finally {
      await client.close();
    }
  }

  it("pg_list_tables advertises optional grep, limit and page", async () => {
    const props = await schemaOf(new PgAdapter({ type: "pg", url: "postgresql://u:p@h/db" }, "p"), "pg_list_tables");
    expect(props.grep).toBeDefined();
    expect(props.schema).toBeDefined(); // the filter is additive, not a replacement
    expect(props.limit).toBeDefined();
    expect(props.page).toBeDefined();
  });

  it("mysql_list_tables exists and carries the same grep/limit/page", async () => {
    const a = new MysqlAdapter({ type: "mysql", database: "shop" }, "m");
    const props = await schemaOf(a, "mysql_list_tables");
    expect(props.grep).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.page).toBeDefined();
    expect(props.sql).toBeUndefined(); // a listing tool, not a second query tool
  });
});

describe("mysqlListTables (the SQL behind mysql_list_tables)", () => {
  it("queries the one database, with no LIKE clause when grep is absent", () => {
    const { list, count } = mysqlListTables("shop");
    expect(list.sql).toContain("FROM information_schema.tables");
    expect(list.sql).toContain("LIMIT ? OFFSET ?");
    expect(list.sql).not.toContain("LIKE");
    expect(list.params).toEqual(["shop", DEFAULT_TABLE_LIMIT, 0]);
    expect(count.sql).toContain("COUNT(*)");
    expect(count.params).toEqual(["shop"]);
  });

  it("filters server-side with an escaped substring pattern when grep is given", () => {
    const { list, count } = mysqlListTables("shop", "users");
    expect(list.sql).toContain("table_name LIKE ? ESCAPE '!'");
    expect(list.params).toEqual(["shop", "%users%", DEFAULT_TABLE_LIMIT, 0]);
    expect(count.params).toEqual(["shop", "%users%"]); // the count shares the filter
    // Underscores in the filter stay literal — the escape keeps _ from matching any character.
    const tricky = mysqlListTables("shop", "p_users");
    expect(tricky.list.params[1]).toBe("%p!_users%");
  });

  it("carries a page request into the LIMIT/OFFSET pair", () => {
    const { list } = mysqlListTables("shop", undefined, { page: 3, limit: 50, offset: 150 });
    expect(list.params).toEqual(["shop", 50, 150]);
  });
});

describe("mysqlPoolOptions (what createPool hands mysql2)", () => {
  it("asks for BIGINT as exact strings — an 18-digit id cannot ride a JS double", () => {
    const opts = mysqlPoolOptions({ type: "mysql", host: "db", user: "u", password: "p", database: "d" });
    // Without these two flags mysql2 funnels BIGINT through Number(): a snowflake id like
    // 734023681584275456 arrives as 734023681584275500 — silently, on every row, grid cell,
    // export and model reply. Strings are exact end to end, and MySQL coerces them back on bind.
    expect(opts.supportBigNumbers).toBe(true);
    expect(opts.bigNumberStrings).toBe(true);
  });

  it("maps the def's connection fields and keeps the pool's own bounds", () => {
    const opts = mysqlPoolOptions({ type: "mysql", host: "db1", port: 3307, user: "u", password: "p", database: "shop", timezone: "+08:00" });
    expect(opts.host).toBe("db1");
    expect(opts.port).toBe(3307);
    expect(opts.database).toBe("shop");
    expect(opts.timezone).toBe("+08:00");
    expect(opts.dateStrings).toBe(true);
    expect(opts.connectionLimit).toBe(5);
  });
});

describe("pingOk (the health probe's SELECT 1 verdict)", () => {
  it("accepts both spellings of 1 — a bare literal is typed LONGLONG, so bigNumberStrings returns \"1\"", () => {
    // The regression: with bigNumberStrings on, `SELECT 1 AS ok` came back as { ok: "1" } and the
    // old inline `ok !== 1` failed on every probe — the panel said down while queries worked.
    expect(pingOk([{ ok: 1 }])).toBe(true);
    expect(pingOk([{ ok: "1" }])).toBe(true);
  });

  it("refuses a wrong answer, an empty result and no result at all", () => {
    expect(pingOk([{ ok: 0 }])).toBe(false);
    expect(pingOk([{ ok: "0" }])).toBe(false);
    expect(pingOk([])).toBe(false);
    expect(pingOk(undefined)).toBe(false);
    expect(pingOk({})).toBe(false);
  });
});

describe("wireMysqlSession (the statements every pooled connection runs)", () => {
  it("sends them over the promise API — the callback one returned undefined and never ran them", async () => {
    const ran: string[] = [];
    const conn = { promise: () => ({ query: (sql: string) => { ran.push(sql); return Promise.resolve([{}]); } }) };
    const handlers: Array<(c: typeof conn) => void> = [];
    wireMysqlSession({ on: (_ev, fn) => handlers.push(fn) }, true);
    expect(handlers.length).toBe(1);
    for (const h of handlers) h(conn); // the pool fired 'connection'
    await new Promise((r) => setTimeout(r, 0)); // the statements go out as microtask-free promises
    expect(ran).toEqual(mysqlSessionSql(true));
  });

  it("adds the read-only session guard only when the MCP is readonly", () => {
    expect(mysqlSessionSql(false)).toEqual(["SET SESSION max_execution_time = 15000"]);
    expect(mysqlSessionSql(true)).toEqual([
      "SET SESSION max_execution_time = 15000",
      "SET SESSION TRANSACTION READ ONLY",
    ]);
  });
});

// The live path needs a REAL reachable database. Gated like mcp-test.test.ts: a dedicated opt-in var,
// because PG_URL in the developer's .env names a database that may not be running.
describe("pg_list_tables against a live database", () => {
  it.skipIf(!process.env.LMG_TEST_LIVE_PG_URL)(
    "grep narrows the listing to names containing it",
    async () => {
      const a = new PgAdapter({ type: "pg", url: process.env.LMG_TEST_LIVE_PG_URL! }, "pglive");
      const client = await openSession(a.makeServer());
      const call = async (args: Record<string, unknown>) => {
        const out = (await client.callTool({ name: "pg_list_tables", arguments: args } as never)) as {
          content: Array<{ text: string }>;
        };
        return JSON.parse(out.content[0].text) as {
          tables: Array<{ name: string }>; total: number; page: number; limit: number; more: boolean;
        };
      };
      try {
        const p1 = await call({ limit: 2 });
        expect(p1.tables).toHaveLength(2); // the limit is honored server-side
        expect(p1.total).toBeGreaterThanOrEqual(2);
        if (p1.more) {
          const p2 = await call({ limit: 2, page: 1 });
          expect(p2.page).toBe(1);
          expect(p2.tables[0].name).not.toBe(p1.tables[0].name); // page 1 continues, not repeats
        }
        const frag = p1.tables[0].name.slice(0, Math.max(1, Math.floor(p1.tables[0].name.length / 2)));
        const filtered = await call({ grep: frag });
        expect(filtered.tables.length).toBeGreaterThan(0);
        expect(filtered.tables.length).toBeLessThanOrEqual(filtered.total);
        expect(filtered.tables.every((r) => r.name.toLowerCase().includes(frag.toLowerCase()))).toBe(true);
      } finally {
        await client.close();
        await a.close();
      }
    },
    20000,
  );
});

describe("MongoAdapter", () => {
  const READ = ["mongo_find", "mongo_aggregate", "mongo_list_collections", "mongo_describe_collection"];
  const WRITE = ["mongo_insert_many", "mongo_update_many", "mongo_delete_many"];

  it("exposes all seven tools when writable, and hides the three write tools when readonly", async () => {
    const rw = new MongoAdapter({ type: "mongo", url: "mongodb://u:p@h:27017/shop" }, "m");
    expect(await toolNames(rw.makeServer())).toEqual([...READ, ...WRITE]);

    const ro = new MongoAdapter({ type: "mongo", url: "mongodb://u:p@h:27017/shop", readonly: true }, "m");
    const roTools = await toolNames(ro.makeServer());
    expect(roTools).toEqual(READ);
    expect(roTools.some((t) => WRITE.includes(t))).toBe(false);
  });

  it("announces resources when the URI carries a database, and nothing when it does not", async () => {
    const withDb = new MongoAdapter({ type: "mongo", url: "mongodb://u:p@h:27017/shop" }, "m");
    expect((await caps(withDb.makeServer()))?.resources).toEqual({ listChanged: true });
    const noDb = new MongoAdapter({ type: "mongo", url: "mongodb://u:p@h:27017" }, "m");
    expect((await caps(noDb.makeServer()))?.resources).toBeUndefined();
  });

  it("honors an explicit database on the def over the URI path", () => {
    const a = new MongoAdapter({ type: "mongo", url: "mongodb://u:p@h:27017/ignored", database: "real" }, "m");
    expect((a as unknown as { database: string }).database).toBe("real");
  });
});

describe("writesViaAggregate", () => {
  it("flags $out and $merge anywhere in the pipeline, but not as a field value", () => {
    expect(writesViaAggregate([{ $out: "backup" }])).toBe(true);
    expect(writesViaAggregate([{ $merge: { into: "backup" } }])).toBe(true);
    expect(writesViaAggregate([{ $match: {} }, { $out: "backup" }])).toBe(true);
    expect(writesViaAggregate([{ $match: {} }, { $group: { _id: "$x" } }])).toBe(false);
    // $out as a field name inside $project is a value, not a stage — must not trip the guard.
    expect(writesViaAggregate([{ $project: { out: "$out" } }])).toBe(false);
    expect(writesViaAggregate([])).toBe(false);
    expect(writesViaAggregate(undefined)).toBe(false);
    expect(writesViaAggregate({ $out: "x" } as never)).toBe(false);
  });
});

describe("bsonPlain (mongo int64 must survive the wire as exact strings)", () => {
  it("renders Long/Timestamp as decimal strings, at any depth", () => {
    const doc = {
      id: Long.fromString("734023681584275456"),
      nested: { arr: [Long.fromString("-9007199254740993"), "plain"] },
      ts: Timestamp.fromNumber(1712345678000),
    };
    expect(bsonPlain(doc)).toEqual({
      id: "734023681584275456",
      nested: { arr: ["-9007199254740993", "plain"] },
      ts: "1712345678000",
    });
    // What JSON.stringify would have emitted without this: {low, high, unsigned} — number gone.
    expect(JSON.stringify(Long.fromString("734023681584275456"))).toContain("low");
  });

  it("leaves bson classes with their own toJSON untouched", () => {
    const oid = new ObjectId();
    const out = bsonPlain({ _id: oid, at: new Date(0) }) as { _id: ObjectId; at: Date };
    expect(out._id).toBe(oid); // same instance — serialized later via its own toJSON
    expect(JSON.parse(JSON.stringify(out))._id).toBe(String(oid));
  });
});

describe("echo adapter rename", () => {
  it("follows a rename so calls keep logging under the current name", async () => {
    const { makeEchoAdapter } = await import("../src/adapters/echo.js");
    const a = makeEchoAdapter("old");
    expect(typeof a.rename).toBe("function");
    a.rename!("new");
    const client = await openSession(a.makeServer!());
    try {
      // The server built AFTER the rename captures the new name in its logged() closure — the
      // tool itself only echoes the message, so the sanity check is that the fresh server serves.
      const res = (await client.callTool({ name: "echo", arguments: { msg: "hello" } } as never)) as { content: Array<{ text?: string }> };
      expect(res.content[0].text).toBe("hello");
    } finally {
      await client.close();
    }
  });
});

describe("Lazy.dispose", () => {
  it("closes a connection that finished opening after dispose was called", async () => {
    // Stopping an MCP while its first connection is still being established used to drop the
    // in-flight promise: the driver connected into a handle nothing referenced, and the pool it
    // opened stayed open for the life of the process.
    const closed: number[] = [];
    let resolveOpen: ((v: { id: number }) => void) | undefined;
    const lazy = new Lazy<{ id: number }>(() => new Promise((res) => { resolveOpen = res; }));
    void lazy.get();
    const disposed = lazy.dispose((v) => { closed.push(v.id); });
    resolveOpen!({ id: 1 }); // the driver connects, after the stop began
    await disposed;
    expect(closed).toEqual([1]);
  });

  it("closes an already-open connection, exactly once", async () => {
    const closed: number[] = [];
    const lazy = new Lazy(async () => ({ id: 7 }));
    await lazy.get();
    await lazy.dispose((v) => { closed.push(v.id); });
    await lazy.dispose((v) => { closed.push(v.id); }); // a second stop has nothing left to close
    expect(closed).toEqual([7]);
  });

  it("has nothing to close when the connection never came up", async () => {
    const closed: unknown[] = [];
    const lazy = new Lazy(async () => { throw new Error("no route to host"); });
    await expect(lazy.get()).rejects.toThrow();
    await expect(lazy.dispose((v) => { closed.push(v); })).resolves.toBeUndefined();
    expect(closed).toEqual([]);
  });
});
