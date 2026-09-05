import type { Redis as RedisClient } from "ioredis";
import { DirectAdapter, Lazy, defBool } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import { log } from "../log.js";
import { redisResources } from "./redis-resources.js";
import type { RedisBrowser, RedisKeyInfo } from "../dbbrowser.js";
import type { ResourceProvider } from "./resources.js";

const KEY = { type: "string", description: "The Redis key." } as const;

/**
 * Three tools, not fourteen, and not one.
 *
 * A tool's schema is re-sent on every request, and one gateway often hosts several Redis endpoints —
 * so a broad tool set is paid for several times over, in every session, forever. A model already
 * knows Redis commands; what it cannot know is the shape of the keys in front of it. What a generic
 * tool alone cannot do is:
 *
 * - stop the catastrophic default — a busy instance can hold hundreds of thousands of keys, and
 *   `KEYS *` both blocks the server and returns megabytes, so SCAN has to be the obvious path;
 * - answer "what is this key, and what is in it?" in one call — GET on a hash is a WRONGTYPE
 *   dead-end, and over the raw command channel every collection arrives as a flat array, so all
 *   reads go through one type-aware reader (the official Redis MCP server exposes a `type` tool
 *   returning {key, type, ttl} for exactly this reason);
 * - keep one call from breaking the endpoint — the adapter holds a SINGLE shared connection, so
 *   `SUBSCRIBE`/`MONITOR` leaves it in a mode it never exits and `BLPOP key 0` hangs forever.
 *
 * Everything else lives behind `redis_command`, whose description states the return conventions:
 * one line of prose is far cheaper than ten JSON schemas, and nothing is actually unreachable.
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
        type: {
          type: "string",
          description: "Only keys of this type: string, hash, list, set, zset or stream.",
        },
      },
    },
  },
  {
    name: "redis_read",
    description:
      "Read one key of ANY type and get the value already shaped to it — no WRONGTYPE errors, no " +
      "guessing which command fits. Returns { key, type, ttl, length, truncated?, value }: string → " +
      "its text; hash → { field: value }; list → array; set → sorted array; zset → { member: score } " +
      "in rank order; stream → [{ id, fields }]; a missing key → type \"none\", value null. ttl is " +
      "in seconds (-1 = no expiry). offset/limit page the ordered types (list, zset, stream; default " +
      "0/100, max 1000); hash and set have no rank to page by, so they return at most 1000 entries " +
      "with truncated true when there were more.",
    inputSchema: {
      type: "object",
      properties: {
        key: KEY,
        offset: { type: "number", description: "First entry to return, by rank (list, zset, stream). Default 0." },
        limit: { type: "number", description: "Entries to return (list, zset, stream). Default 100, max 1000." },
      },
      required: ["key"],
    },
  },
  {
    name: "redis_command",
    description:
      "Run any other Redis command: { command: \"SET\", args: [\"k\", \"v\", \"EX\", \"60\"] }. Covers " +
      "SET/DEL/EXISTS/TTL/TYPE/EXPIRE/INCR, MGET, HSET/HGET/HDEL, LPUSH/LRANGE/LLEN, SADD/SMEMBERS, " +
      "ZADD/ZRANGE, XADD/XRANGE, INFO/DBSIZE/CONFIG GET, and the rest. Bound your range reads " +
      "(`LRANGE key 0 99`) — output is capped either way. Return conventions: status replies come " +
      "back as \"OK\"/\"PONG\", integer replies as numbers, a missing value as null, and collections " +
      "as FLAT arrays — `ZRANGE k 0 -1 WITHSCORES` is [member, score, member, score]; prefer " +
      "redis_read when you want the shaped version. Rejected: KEYS (use redis_scan), Lua and " +
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

/** TYPE values SCAN can filter by — validated before a socket is opened, so a typo costs nothing. */
const SCAN_TYPES = new Set(["string", "hash", "list", "set", "zset", "stream"]);

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

/** Read-only commands permitted through redis_command when the MCP is marked readonly. Both
 *  dedicated tools (redis_scan, redis_read) are pure reads, so this is the only place a write can
 *  enter. Container commands are absent on purpose: their own policy above decides, per subcommand. */
const READ_COMMANDS = new Set([
  "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TTL", "PTTL", "TYPE", "SCAN", "RANDOMKEY",
  "HGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HMGET", "HEXISTS", "HSCAN",
  "LRANGE", "LLEN", "LINDEX", "SMEMBERS", "SCARD", "SISMEMBER", "SSCAN", "SRANDMEMBER",
  "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "ZCOUNT", "ZSCAN", "ZRANK",
  "XRANGE", "XREVRANGE", "XLEN", "XINFO", "GETBIT", "BITCOUNT", "OBJECT",
  "INFO", "DBSIZE", "PING", "TIME", "LOLWUT", "COMMAND", "LASTSAVE", "DUMP",
]);

/** Ceiling for the ordered reads' window — mirrors the output budget's per-reply item cap. */
const READ_WINDOW_MAX = 1000;
/** Entries hash/set reads collect before stopping: these types have no rank to page by. */
const UNORDERED_CAP = 1000;
/** Fields/members per HSCAN/SSCAN round — small batches, so collection stops soon after the cap. */
const SCAN_BATCH = 200;

/**
 * The slice of ioredis the type-aware reader needs, injected so the dispatch is testable without a
 * Redis. Signatures are spelled out rather than rest-args, so a real ioredis client satisfies this
 * structurally — the same trick as RedisLike in redis-resources.ts.
 */
export interface RedisReadClient {
  type(key: string): Promise<string>;
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  hlen(key: string): Promise<number>;
  scard(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
  xlen(key: string): Promise<number>;
  call(command: string, ...args: string[]): Promise<unknown>;
}

/**
 * Pair a flat [field, value, field, value] reply into an object. Null-prototype on purpose: a hash
 * with a field literally named `__proto__` must land as a plain entry, not vanish into (or bend) the
 * prototype — the same reason REJECTED above is a Map.
 */
export function pairFlat(flat: unknown[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
}

/**
 * Scores arrive as strings and become numbers, except inf/-inf/nan which have no JSON number —
 * those stay strings so the value survives the round trip intact.
 */
function toScore(raw: string): number | string {
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/** An XRANGE reply is [id, [field, value, …]] entries; each becomes { id, fields }. */
function streamEntries(reply: unknown[]): Array<{ id: string; fields: Record<string, string> }> {
  return reply.map((entry) => {
    const [id, flat] = Array.isArray(entry) ? entry : [entry, []];
    return { id: String(id), fields: pairFlat(Array.isArray(flat) ? flat : []) };
  });
}

/** Clamp the paging args every ordered read shares; absent or nonsensical values fall back to 0/100. */
export function readWindow(args: Record<string, unknown> | undefined): { offset: number; limit: number } {
  const offset = Math.max(0, Math.floor(Number(args?.offset ?? 0)) || 0);
  const limit = Math.min(Math.max(Math.floor(Number(args?.limit ?? 100)) || 100, 1), READ_WINDOW_MAX);
  return { offset, limit };
}

/** One HSCAN/SSCAN round through the raw channel, whose reply is already [cursor, flatArray]. */
async function scanRound(
  client: RedisReadClient,
  command: "HSCAN" | "SSCAN",
  key: string,
  cursor: string,
): Promise<[string, unknown[]]> {
  const reply = await client.call(command, key, cursor, "COUNT", String(SCAN_BATCH));
  if (Array.isArray(reply) && Array.isArray(reply[1])) return [String(reply[0]), reply[1]];
  return ["0", []];
}

/**
 * The dispatch behind redis_read: TYPE and TTL first — one round trip that answers "what is this
 * key" — then the read shaped to what the key actually is. Exported for tests; the adapter calls it
 * with the shared ioredis connection.
 */
export async function typeAwareRead(
  client: RedisReadClient,
  key: string,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)]);
  const base = { key, type, ttl };

  switch (type) {
    case "none": // Redis' own answer for a missing key — a fact to report, not an error to invent.
      return { ...base, value: null };
    case "string":
      return { ...base, value: await client.get(key) };
    case "hash": {
      // HSCAN, not HGETALL: collection stops at the cap, so a hash with a hundred thousand fields
      // never materializes in one reply.
      const length = await client.hlen(key);
      const value = Object.create(null) as Record<string, string>;
      let cursor = "0";
      do {
        const [next, flat] = await scanRound(client, "HSCAN", key, cursor);
        Object.assign(value, pairFlat(flat));
        cursor = next;
      } while (cursor !== "0" && Object.keys(value).length < UNORDERED_CAP);
      const got = Object.keys(value).length;
      return {
        ...base,
        length,
        ...(got < length
          ? { truncated: true, note: `showing ${got} of ${length} fields — read one field with redis_command {command:"HGET"}` }
          : {}),
        value,
      };
    }
    case "list": {
      const [length, value] = await Promise.all([
        client.llen(key),
        client.lrange(key, offset, offset + limit - 1),
      ]);
      return { ...base, length, ...(offset + value.length < length ? { truncated: true } : {}), value };
    }
    case "set": {
      const length = await client.scard(key);
      const found: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await scanRound(client, "SSCAN", key, cursor);
        found.push(...batch.map(String));
        cursor = next;
      } while (cursor !== "0" && found.length < UNORDERED_CAP);
      // SCAN order is the server's internal ordering; sort so the same key reads the same twice.
      const value = [...new Set(found)].slice(0, UNORDERED_CAP).sort();
      return {
        ...base,
        length,
        ...(value.length < length
          ? { truncated: true, note: `showing ${value.length} of ${length} members — check one with redis_command {command:"SISMEMBER"}` }
          : {}),
        value,
      };
    }
    case "zset": {
      const [length, reply] = await Promise.all([
        client.zcard(key),
        client.call("ZRANGE", key, String(offset), String(offset + limit - 1), "WITHSCORES"),
      ]);
      const flat = pairFlat(Array.isArray(reply) ? reply : []);
      const value = Object.create(null) as Record<string, number | string>;
      for (const [member, score] of Object.entries(flat)) value[member] = toScore(score);
      const got = Object.keys(value).length;
      return { ...base, length, ...(offset + got < length ? { truncated: true } : {}), value };
    }
    case "stream": {
      // XRANGE has no offset, so the window is fetched and then skipped — one bounded overshoot.
      const [length, reply] = await Promise.all([
        client.xlen(key),
        client.call("XRANGE", key, "-", "+", "COUNT", String(offset + limit)),
      ]);
      const value = streamEntries(Array.isArray(reply) ? reply : []).slice(offset, offset + limit);
      return { ...base, length, ...(offset + value.length < length ? { truncated: true } : {}), value };
    }
    default:
      // Module types (ReJSON-RL, TSDB-TYPE, …): name the way out rather than failing opaquely.
      return {
        ...base,
        value: null,
        note: `a ${type} value needs its module's own commands — use redis_command (e.g. JSON.GET / TS.RANGE)`,
      };
  }
}

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

  /** Redis MCPs advertise the same tools; without this, the path is the only clue which
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
        const type = args?.type ? String(args.type).trim().toLowerCase() : "";
        if (type && !SCAN_TYPES.has(type)) {
          throw new Error(`type must be one of ${[...SCAN_TYPES].join(", ")} — got "${type}"`);
        }
        // Through call() rather than the named scan(): the TYPE filter only exists as an option
        // token, and SCAN's raw reply is already [cursor, keys] — the shape the named method returns.
        const reply = await client.call(
          "SCAN", cursor, "MATCH", pattern, "COUNT", String(count), ...(type ? ["TYPE", type] : []),
        );
        const pair = Array.isArray(reply) ? (reply as [unknown, unknown[]]) : (["0", []] as [unknown, unknown[]]);
        const next = String(pair[0]);
        return { cursor: next, keys: pair[1].map(String), done: next === "0" };
      }
      case "redis_read": {
        const { offset, limit } = readWindow(args);
        return typeAwareRead(client, key(), offset, limit);
      }
      case "redis_command":
        // Already validated above, before the connection was opened.
        return client.call(command, ...rest);
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  // --- admin panel Data view (redis flavour) ------------------------------------------------------

  /**
   * The Data view's redis browser: SCAN-paged keys with type/TTL beside each, and type-aware
   * single-key reads through the same typeAwareRead the redis_read tool uses. Read-only by
   * design — editing goes through redis_command on the MCP side, deliberately not the panel.
   */
  redisBrowser(): RedisBrowser {
    return {
      readonly: this.readonly,
      label: this.target,
      listKeys: async (o) => {
        const client = await this.conn.get();
        const cursor = String(o.cursor ?? "0");
        const count = Math.min(Math.max(Number(o.count ?? 200) || 200, 1), 1000);
        const pattern = o.pattern ? String(o.pattern) : "*";
        const type = o.type ? String(o.type).trim().toLowerCase() : "";
        if (type && !SCAN_TYPES.has(type)) {
          throw new Error(`type must be one of ${[...SCAN_TYPES].join(", ")} — got "${type}"`);
        }
        const reply = await client.call(
          "SCAN", cursor, "MATCH", pattern, "COUNT", String(count), ...(type ? ["TYPE", type] : []),
        );
        const pair = Array.isArray(reply) ? (reply as [unknown, unknown[]]) : (null as unknown as [unknown, unknown[]]);
        const rawKeys = pair ? pair[1] : [];
        const next = pair ? String(pair[0]) : "0";
        // Type and TTL per key, sent through ONE pipeline per chunk: the commands ride a single
        // network round trip instead of 2×keys serialized ones (measured: a 200-key page fell
        // from ~880 ms to tens of ms). Chunked at 200 pairs so one pipeline is never unbounded.
        const infos: RedisKeyInfo[] = [];
        const keys = rawKeys.map(String);
        const PIPE_CHUNK = 200;
        // DBSIZE rides the FIRST pipeline chunk too — it is independent of the per-key commands,
        // so the whole page costs two sequential round trips: SCAN, then one packed pipeline.
        let total: number | undefined;
        for (let i = 0; i < keys.length || (i === 0 && !keys.length); i += PIPE_CHUNK) {
          const chunk = keys.slice(i, i + PIPE_CHUNK);
          const pl = client.pipeline();
          for (const k of chunk) {
            pl.type(k);
            pl.ttl(k);
          }
          if (i === 0) pl.dbsize();
          const results = await pl.exec();
          if (!results) continue;
          for (let j = 0; j < chunk.length; j++) {
            const typeRes = results[j * 2];
            const ttlRes = results[j * 2 + 1];
            infos.push({
              key: chunk[j],
              type: String(typeRes && !typeRes[0] ? typeRes[1] : "none"),
              ttl: ttlRes && !ttlRes[0] ? Number(ttlRes[1]) : -2,
            });
          }
          if (i === 0) {
            const dbsizeRes = results[chunk.length * 2];
            if (dbsizeRes && !dbsizeRes[0]) total = Number(dbsizeRes[1]);
          }
        }
        return { keys: infos, cursor: next, done: next === "0", total };
      },
      readKey: async (key) => {
        const client = await this.conn.get();
        return typeAwareRead(client, String(key), 0, 1000);
      },
      runCommand: async (line) => {
        const REPLY_CAP = 1000;
        const client = await this.conn.get();
        // Split on whitespace (quoted args not offered — redis args are rarely spaced; the MCP
        // redis_command tool remains the full-featured path). The adapter's own guard rejects
        // writes, KEYS, blocking and server-breaking commands before anything reaches the socket.
        const parts = String(line).trim().split(/\s+/).filter(Boolean);
        if (!parts.length) throw new Error("type a command, e.g. GET mykey");
        const command = parts[0];
        const args = parts.slice(1);
        this.assertCommandAllowed(command, args);
        let reply = await client.call(command, ...args);
        // A console "LRANGE key 0 -1" on a million-element list must not ship a million strings
        // to the browser: cap array replies and say so.
        if (Array.isArray(reply) && reply.length > REPLY_CAP) {
          reply = { truncated: true, note: `showing first ${REPLY_CAP} of ${reply.length}`, items: reply.slice(0, REPLY_CAP) };
        }
        return reply;
      },
    };
  }

  async ping(): Promise<void> {
    const client = await this.conn.get();
    const res = await client.ping();
    if (res !== "PONG") throw new Error(`redis PING returned ${res}`);
  }

  async close(): Promise<void> {
    await this.conn.dispose((client) => {
      client.removeAllListeners();
      client.disconnect();
    });
  }
}
