import type { Redis as RedisClient } from "ioredis";
import { DirectAdapter, Lazy, defBool } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import { log } from "../log.js";
import { redisResources } from "./redis-resources.js";
import type { ResourceProvider } from "./resources.js";

const KEY = { type: "string", description: "The Redis key." } as const;

/**
 * Four tools, not fourteen, and not one.
 *
 * A tool's schema is re-sent on every request, and one gateway often hosts several Redis endpoints —
 * so a broad tool set is paid for several times over, in every session, forever. A model already
 * knows Redis: `redis_get` earns its place only because reads dominate, and a wrapper like `redis_ttl`
 * earns nothing over `redis_command {command:"TTL"}`. What a generic tool alone cannot do is:
 *
 * - stop the catastrophic default — a busy instance can hold hundreds of thousands of keys, and
 *   `KEYS *` both blocks the server and returns megabytes, so SCAN has to be the obvious path;
 * - fix a return shape — `HGETALL` over the raw command channel arrives as a flat array, not an object;
 * - keep one call from breaking the endpoint — the adapter holds a SINGLE shared connection, so
 *   `SUBSCRIBE`/`MONITOR` leaves it in a mode it never exits and `BLPOP key 0` hangs forever.
 *
 * Everything else lives behind `redis_command`, whose description lists the common commands: one line
 * of prose is far cheaper than ten JSON schemas, and nothing is actually unreachable.
 */
const TOOLS: ToolDef[] = [
  {
    name: "redis_scan",
    description:
      "Incrementally list keys matching a glob pattern (cursor-based SCAN — safe on large instances, " +
      "unlike KEYS, which blocks the server and can return hundreds of thousands of keys). Returns " +
      "{ cursor, keys, done }; pass the returned cursor back to continue until done is true.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. `session:*`. Omit for all keys." },
        cursor: { type: "string", description: "Cursor from a previous call. Omit to start." },
        count: { type: "number", description: "Keys scanned per iteration (default 100)." },
      },
    },
  },
  { name: "redis_get", description: "Get the string value of a key.", inputSchema: { type: "object", properties: { key: KEY }, required: ["key"] } },
  {
    name: "redis_hgetall",
    description: "Get every field and value of a hash, as an object (the raw command returns a flat array).",
    inputSchema: { type: "object", properties: { key: KEY }, required: ["key"] },
  },
  {
    name: "redis_command",
    description:
      "Run any other Redis command: { command: \"SET\", args: [\"k\", \"v\", \"EX\", \"60\"] }. Covers " +
      "SET/DEL/EXISTS/TTL/TYPE/EXPIRE/INCR, HSET/HGET/HDEL, LPUSH/LRANGE/LLEN, SADD/SMEMBERS, " +
      "ZADD/ZRANGE, XADD/XRANGE, INFO/DBSIZE/CONFIG GET, and the rest. Bound your range reads " +
      "(`LRANGE key 0 99`) — output is capped either way. Rejected: KEYS (use redis_scan), Lua and " +
      "functions (EVAL/SCRIPT/FCALL), transactions (MULTI/EXEC/WATCH), anything that would break this " +
      "shared connection (SUBSCRIBE/MONITOR/BLPOP…) or the server (SHUTDOWN/DEBUG/CONFIG SET/ACL/" +
      "MODULE/SAVE…), and FLUSHALL/FLUSHDB unless this MCP permits them.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command name, e.g. SET / TTL / XRANGE / INFO." },
        args: { type: "array", items: { type: "string" }, description: "Command arguments, in order." },
      },
      required: ["command"],
    },
  },
];

/** Commands that put the shared connection into a mode it never leaves, or block it indefinitely. */
const CONNECTION_BREAKING = new Set([
  "SUBSCRIBE", "UNSUBSCRIBE", "PSUBSCRIBE", "PUNSUBSCRIBE", "SSUBSCRIBE", "SUNSUBSCRIBE",
  "MONITOR", "RESET", "SELECT",
  "BLPOP", "BRPOP", "BLMOVE", "BLMPOP", "BRPOPLPUSH", "BZPOPMIN", "BZPOPMAX", "BZMPOP",
  "WAIT", "WAITAOF", "XREAD", "XREADGROUP",
]);
/** Commands that damage the server itself, not just this connection. */
const SERVER_BREAKING = new Set(["SHUTDOWN", "DEBUG", "SLAVEOF", "REPLICAOF", "FAILOVER", "MIGRATE", "SWAPDB"]);
/** Destructive but legitimate on a dev instance — allowed only with `allowDestructive: true`. */
const DESTRUCTIVE = new Set(["FLUSHALL", "FLUSHDB"]);

/**
 * Lua and functions — the one family every other rule in this file is blind to. `EVAL` takes its
 * program as an argument, so `EVAL "redis.call('FLUSHALL')" 0` is a rejected command wearing an
 * accepted command's name, and the same trick reaches SHUTDOWN, CONFIG SET, or an endless loop.
 * Rejecting what cannot be inspected is the whole reason this set is separate from the ones above:
 * those name a specific harm, this one names an unbounded one. Opt in per MCP with `allowEval`.
 */
const SCRIPTING = new Set(["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO"]);
/** Script/function management, which stays shut even when scripts are allowed — see the message. */
const SCRIPT_ADMIN = new Set(["SCRIPT", "FUNCTION"]);

/**
 * Commands rejected outright, each with the reason the model sees. A rejection has to say what to do
 * instead, or the model simply tries the next bad idea: an unexplained "rejected" turns `KEYS *` into
 * `SCAN` plus five retries, while naming `redis_scan` ends it in one.
 *
 * A Map rather than an object so a command named `constructor` cannot match through the prototype.
 */
const REJECTED = new Map<string, string>(
  (
    [
      [["MODULE"], "MODULE LOAD runs native code inside the Redis server."],
      [["ACL"], "it reads and rewrites this server's credentials — one SETUSER can lock this gateway out of it."],
      [
        ["SYNC", "PSYNC", "REPLCONF"],
        "it turns this connection into a replication stream, which never returns and delivers the whole dataset.",
      ],
      [["SAVE"], "it blocks the entire server until the dataset is written to disk."],
      [
        ["BGSAVE", "BGREWRITEAOF"],
        "it starts a full disk write on the server; that is an operator's decision, not a debugging step.",
      ],
      [
        ["MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH"],
        "this adapter shares one connection, so a transaction opened by one call would swallow every " +
          "other call's commands until EXEC, and they would receive QUEUED instead of an answer. Send " +
          "the commands individually.",
      ],
      [
        ["KEYS"],
        "it walks the entire keyspace in one blocking pass, which stalls the server on a large " +
          "instance. Use redis_scan instead — it is cursor-based and reaches the same keys.",
      ],
    ] as [string[], string][]
  ).flatMap(([commands, why]) => commands.map((c) => [c, why] as [string, string])),
);

/**
 * Commands whose first argument decides, because one name covers both a harmless read and real
 * damage: `CONFIG GET` reports, `CONFIG SET dir` is the first half of the classic Redis takeover;
 * `CLIENT LIST` reports, `CLIENT KILL` can cut off this very gateway and `CLIENT PAUSE` freezes the
 * server. `read` subcommands survive readonly, `write` ones do not, and anything unlisted is refused
 * — a new Redis release cannot quietly add a subcommand that slips through.
 */
const CONTAINERS = new Map<string, { read: string[]; write?: string[] }>([
  ["CONFIG", { read: ["GET"] }],
  ["CLIENT", { read: ["ID", "INFO", "LIST", "GETNAME"], write: ["SETNAME", "SETINFO"] }],
  [
    "CLUSTER",
    { read: ["INFO", "MYID", "NODES", "SHARDS", "SLOTS", "LINKS", "KEYSLOT", "COUNTKEYSINSLOT", "REPLICAS", "SLAVES"] },
  ],
  ["MEMORY", { read: ["USAGE", "STATS", "DOCTOR", "MALLOC-STATS"], write: ["PURGE"] }],
]);

/** Read-only commands permitted through redis_command when the MCP is marked readonly. The three
 *  dedicated tools are all reads, so this is the only place a write can enter. Container commands
 *  are absent on purpose: their own policy above decides, per subcommand. */
const READ_COMMANDS = new Set([
  "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TTL", "PTTL", "TYPE", "SCAN", "RANDOMKEY",
  "HGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HMGET", "HEXISTS", "HSCAN",
  "LRANGE", "LLEN", "LINDEX", "SMEMBERS", "SCARD", "SISMEMBER", "SSCAN", "SRANDMEMBER",
  "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "ZCOUNT", "ZSCAN", "ZRANK",
  "XRANGE", "XREVRANGE", "XLEN", "XINFO", "GETBIT", "BITCOUNT", "OBJECT",
  "INFO", "DBSIZE", "PING", "TIME", "LOLWUT", "COMMAND", "LASTSAVE", "DUMP",
]);

/**
 * In-process Redis adapter: a single ioredis connection (which multiplexes async requests) behind a
 * purposeful tool set. `ioredis` costs ~17.6 MB of RSS (measured, the priciest dependency here), so it
 * is imported on first use rather than at boot.
 */
export class RedisAdapter extends DirectAdapter {
  readonly type = "redis";
  protected readonly tools = TOOLS;
  private readonly conn = new Lazy<RedisClient>(() => this.createClient());
  private lastErrorLog = 0;

  private get allowDestructive(): boolean {
    return defBool(this.def, "allowDestructive");
  }

  /** Opt in to Lua/functions on this instance, accepting that the guard cannot inspect them. */
  private get allowEval(): boolean {
    return defBool(this.def, "allowEval");
  }

  /** Three Redis MCPs advertise the same four tools; without this, the path is the only clue which
   *  instance is behind one. */
  protected get target(): string {
    return `${this.def.host ?? "localhost"}:${this.def.port ?? 6379} db ${this.def.db ?? 0}`;
  }

  protected open(): Promise<RedisClient> {
    return this.conn.get();
  }

  /**
   * One resource: the shape of this keyspace. Labelled with the MCP name rather than host:port, since
   * that is what a client shows beside the URI and what stays stable if the tunnel's port moves.
   */
  protected resources(): ResourceProvider | undefined {
    const label = this.mcpName || `${this.def.host ?? "localhost"}:${this.def.port ?? 6379}`;
    return redisResources(label, () => this.conn.get());
  }

  private async createClient(): Promise<RedisClient> {
    const { default: Redis } = await import("ioredis");
    const client = new Redis({
      host: String(this.def.host ?? "localhost"),
      port: Number(this.def.port ?? 6379),
      password: String(this.def.password ?? "") || undefined,
      db: Number(this.def.db ?? 0),
      connectTimeout: 5000,
      // Bound how long a command may wait, which also bounds the offline queue: with
      // enableOfflineQueue left ON (commands issued before the socket is ready must wait, or the
      // health probe fires the instant the client is constructed and always fails), these two are
      // what stop a down server from accumulating work — each queued command gives up quickly
      // instead of sitting there.
      commandTimeout: 10000,
      maxRetriesPerRequest: 1, // fail a request fast if the server is unreachable
      // Keep reconnecting (so the MCP heals on its own when redis comes back) but cap the delay,
      // rather than the default ramp that produced endless reconnect churn.
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    });
    // ioredis emits 'error' on every failed reconnect; unhandled it would crash the gateway, and
    // logged verbatim it produced pages of blank "Redis connection error:" lines. Throttle it.
    client.on("error", (err: Error) => {
      const now = Date.now();
      if (now - this.lastErrorLog < 30000) return;
      this.lastErrorLog = now;
      log("warn", "redis connection error", { host: this.def.host, port: this.def.port, err: err.message || String(err) });
    });
    return client;
  }

  /**
   * Reject a command that would damage the shared connection, the server, or the data — before any
   * connection is opened, so a bad call costs nothing and the rule is testable without a Redis.
   *
   * `args` are the command's own arguments, needed only because a container command's first argument
   * is the one that decides (CONFIG GET vs CONFIG SET).
   */
  assertCommandAllowed(command: string, args: string[] = []): void {
    const upper = command.trim().toUpperCase();
    if (!upper) throw new Error("command is required");
    if (SCRIPT_ADMIN.has(upper)) {
      throw new Error(
        `${upper} is rejected: script management is never exposed. Pass the script inline with EVAL — and note ` +
          `that a runaway script has to be killed with redis-cli, since this shared connection would already be ` +
          `blocked waiting for it.`,
      );
    }
    if (SCRIPTING.has(upper)) {
      if (!this.allowEval) {
        throw new Error(
          `${upper} is rejected: the gateway cannot see inside a script, so none of its other rules apply to one — ` +
            `a single line of Lua can flush the keyspace, block the server in a loop, or run any command this MCP ` +
            `refuses. Set "allowEval": true on this MCP if you accept that.`,
        );
      }
      if (this.readonly) {
        throw new Error(
          `${upper} is rejected: "allowEval" and "readonly" contradict each other on this MCP — a script the ` +
            `gateway cannot read cannot be held to readonly. Clear one of the two.`,
        );
      }
    }
    const why = REJECTED.get(upper);
    if (why) throw new Error(`${upper} is rejected: ${why}`);
    if (CONNECTION_BREAKING.has(upper)) {
      throw new Error(
        `${upper} is rejected: this adapter shares one connection across all requests, and ${upper} would ` +
          `leave it unusable for every later call. Use redis_scan / the dedicated tools instead.`,
      );
    }
    if (SERVER_BREAKING.has(upper)) throw new Error(`${upper} is rejected: it would disrupt the Redis server itself`);
    if (DESTRUCTIVE.has(upper) && !this.allowDestructive) {
      throw new Error(`${upper} is rejected: set "allowDestructive": true on this MCP to permit it`);
    }
    const container = CONTAINERS.get(upper);
    if (container) {
      const sub = (args[0] ?? "").trim().toUpperCase();
      const permitted = [...container.read, ...(container.write ?? [])];
      if (!sub) throw new Error(`${upper} requires a subcommand, one of: ${permitted.join(", ")}`);
      if (container.read.includes(sub)) return; // a read, so readonly does not apply
      if (container.write?.includes(sub)) {
        if (this.readonly) throw new Error(`${upper} ${sub} is rejected: this Redis MCP is configured readonly`);
        return;
      }
      throw new Error(`${upper} ${sub} is rejected: only these subcommands are permitted: ${permitted.join(", ")}`);
    }
    if (this.readonly && !READ_COMMANDS.has(upper)) {
      throw new Error(`${upper} is rejected: this Redis MCP is configured readonly`);
    }
  }

  protected async call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    // Parsed up front because the guard needs the arguments too — a container command's first
    // argument is what decides whether it is a read or a rewrite of the server.
    const command = String(args?.command ?? "").trim();
    const rest = Array.isArray(args?.args) ? (args.args as unknown[]).map(String) : [];
    // Validate before connecting: a refused call should never open a socket.
    if (tool === "redis_command") this.assertCommandAllowed(command, rest);
    const client = await this.conn.get();
    const key = () => {
      const k = String(args?.key ?? "");
      if (!k) throw new Error("key is required");
      return k;
    };

    switch (tool) {
      case "redis_scan": {
        const cursor = String(args?.cursor ?? "0");
        const count = Math.min(Math.max(Number(args?.count ?? 100) || 100, 1), 10000);
        const pattern = args?.pattern ? String(args.pattern) : "*";
        const [next, found] = await client.scan(cursor, "MATCH", pattern, "COUNT", count);
        return { cursor: next, keys: found, done: next === "0" };
      }
      case "redis_get":
        return client.get(key());
      case "redis_hgetall":
        return client.hgetall(key());
      case "redis_command":
        // Already validated above, before the connection was opened.
        return client.call(command, ...rest);
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  async ping(): Promise<void> {
    const client = await this.conn.get();
    const res = await client.ping();
    if (res !== "PONG") throw new Error(`redis PING returned ${res}`);
  }

  async close(): Promise<void> {
    const client = this.conn.take();
    client?.removeAllListeners();
    client?.disconnect();
  }
}
