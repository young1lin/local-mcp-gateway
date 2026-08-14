import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { makeAdapter } from "../src/adapters/factory.js";
import { MysqlAdapter } from "../src/adapters/mysql.js";
import { RedisAdapter } from "../src/adapters/redis.js";
import { PgAdapter } from "../src/adapters/pg.js";
import { MongoAdapter, writesViaAggregate } from "../src/adapters/mongo.js";
import { ProcAdapter } from "../src/adapters/proc.js";
import { makeToolServer } from "../src/adapters/tool-server.js";
import { openSession } from "../src/introspect.js";

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
    expect(await toolNames(a.makeServer())).toEqual(["mysql_query"]);
    const r = new RedisAdapter({ type: "redis" }, "r");
    expect(await toolNames(r.makeServer())).toEqual(["redis_scan", "redis_get", "redis_hgetall", "redis_command"]);
  });

  it("hides a disabled tool from tools/list — it simply disappears, there is no other mechanism", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: ["redis_command"] }, "r");
    expect(await toolNames(r.makeServer())).toEqual(["redis_scan", "redis_get", "redis_hgetall"]);
  });

  it("hides several, and is live — mutate the shared toggle, the next makeServer already reflects it", async () => {
    const def = { type: "redis" };
    const r = new RedisAdapter(def, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(4);
    r.toolToggle.disabled = new Set(["redis_scan", "redis_get"]);
    expect(await toolNames(r.makeServer())).toEqual(["redis_hgetall", "redis_command"]);
    r.toolToggle.disabled = new Set();
    expect(await toolNames(r.makeServer())).toHaveLength(4);
  });

  it("ignores a disabledTools entry that names no real tool, rather than erroring", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: ["no_such_tool"] }, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(4);
  });

  it("treats a non-array disabledTools as empty (defensive against bad config)", async () => {
    const r = new RedisAdapter({ type: "redis", disabledTools: "redis_command" }, "r");
    expect(await toolNames(r.makeServer())).toHaveLength(4);
  });
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
