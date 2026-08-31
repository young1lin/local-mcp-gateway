import { splitUri, ResourceFault, type ResourceBody, type ResourceProvider, type ResourceTemplate } from "./resources.js";

/**
 * The slice of ioredis this provider needs, injected so it is testable without a Redis.
 *
 * `scan` is spelled out positionally rather than with rest args so an `ioredis` client satisfies it
 * directly — its `scan` is a set of overloads, and a rest-arg signature is not assignable to those.
 */
export interface RedisLike {
  scan(
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
  call(command: string, ...args: string[]): Promise<unknown>;
}

/**
 * Sampling bounds. A busy instance can hold hundreds of thousands of keys, so "describe this
 * database" must never mean "enumerate it": the sample is capped in both keys and round trips, and
 * the round-trip cap is what guarantees termination when SCAN's cursor keeps coming back non-zero.
 */
const MAX_KEYS = 2000;
const MAX_ROUNDS = 20;
const SCAN_COUNT = 500;
/** Keys whose type is probed. Issued concurrently, so ioredis pipelines them into ~one round trip. */
const TYPE_SAMPLE = 30;

/**
 * Collapse a key into its shape, so a huge keyspace of opaque keys becomes a handful of legible
 * buckets.
 *
 * `app:session:4711:token`   → `app:session:#:*`
 * `job1760000000000`         → `job#`
 *
 * Digit runs become `#` because the variable part of a key is usually numeric — a timestamp, a
 * snowflake id, a shard number — and without folding them each key is its own bucket.
 */
export function keyShape(key: string): string {
  const parts = key.split(":");
  const head = parts.slice(0, 3).join(":");
  const shape = head.replace(/\d+/g, "#");
  return parts.length > 3 ? `${shape}:*` : shape;
}

/** Pull `redis_version:6.2.20` style fields out of an INFO reply. */
function infoField(info: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:(.*)$`, "m").exec(info);
  return m ? m[1].trim() : undefined;
}

/**
 * One resource per Redis MCP: an overview.
 *
 * No per-key resources and no key template, deliberately. A resource list is something a person reads
 * in a picker, and neither hundreds of thousands of entries nor a template over opaque session ids is readable; key
 * discovery stays with `redis_scan`, which is built for exactly that. What a picker *can* usefully
 * hold is the shape of the database, which is what this returns.
 */
export function redisResources(label: string, open: () => Promise<RedisLike>): ResourceProvider {
  const uri = `redis://${label}/overview`;

  async function sample(client: RedisLike): Promise<{ keys: string[]; rounds: number; complete: boolean }> {
    const keys: string[] = [];
    let cursor = "0";
    let rounds = 0;
    do {
      const [next, found] = await client.scan(cursor, "MATCH", "*", "COUNT", SCAN_COUNT);
      keys.push(...found);
      cursor = next;
      rounds++;
    } while (cursor !== "0" && rounds < MAX_ROUNDS && keys.length < MAX_KEYS);
    return { keys: keys.slice(0, MAX_KEYS), rounds, complete: cursor === "0" };
  }

  async function overview(): Promise<string> {
    const client = await open();
    const [dbsize, info, sampled] = await Promise.all([
      client.call("DBSIZE").then((v) => Number(v) || 0).catch(() => 0),
      client.call("INFO", "server").then((v) => String(v ?? "")).catch(() => ""),
      sample(client),
    ]);

    const shapes = new Map<string, number>();
    for (const k of sampled.keys) shapes.set(keyShape(k), (shapes.get(keyShape(k)) ?? 0) + 1);
    const ranked = [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 20);

    const probe = sampled.keys.slice(0, TYPE_SAMPLE);
    const types = new Map<string, number>();
    const answers = await Promise.all(
      probe.map((k) => client.call("TYPE", k).then((v) => String(v)).catch(() => "unknown")),
    );
    for (const t of answers) types.set(t, (types.get(t) ?? 0) + 1);

    const scale = sampled.keys.length && dbsize ? dbsize / sampled.keys.length : 1;
    return JSON.stringify(
      {
        redis: label,
        version: infoField(info, "redis_version"),
        keys: dbsize,
        sampled: sampled.keys.length,
        sampleIsWholeKeyspace: sampled.complete,
        keyShapes: ranked.map(([shape, n]) => ({
          shape,
          sampled: n,
          estimatedKeys: sampled.complete ? n : Math.round(n * scale),
        })),
        types: Object.fromEntries(types),
        notes: [
          "Digit runs in a key shape are folded to `#`; a trailing `:*` means the key has more segments.",
          sampled.complete
            ? "The sample covered the whole keyspace, so these counts are exact."
            : `Sampled ${sampled.keys.length} of ${dbsize} keys over ${sampled.rounds} SCAN rounds; ` +
              "estimatedKeys is extrapolated and approximate.",
          "Use redis_scan with a pattern to list real keys — they are not exposed as resources.",
        ],
      },
      null,
      2,
    );
  }

  return {
    async list() {
      return {
        resources: [
          {
            uri,
            name: `${label} overview`,
            description: "Key count, key-shape histogram and value types, sampled live",
            mimeType: "application/json",
          },
        ],
      };
    },

    templates(): ResourceTemplate[] {
      return [];
    },

    async read(requested: string): Promise<ResourceBody[]> {
      const { authority, rest } = splitUri(requested, "redis");
      if (authority !== label || rest !== "overview") throw new ResourceFault(`no such resource: ${requested}`);
      return [{ uri, mimeType: "application/json", text: await overview() }];
    },
  };
}
