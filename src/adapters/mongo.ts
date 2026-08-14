import type { Db, Document, Filter, FindOptions, MongoClient, UpdateFilter } from "mongodb";
import { DirectAdapter, Lazy } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import {
  clampRowLimit, dropNullColumns, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT,
} from "./sql.js";
import {
  describeCollection, mongoResources, type CollectionInfo, type CollectionStat, type MongoLike,
} from "./mongo-resources.js";
import { humanBytes } from "./resources.js";

const COLLECTION_ARG = {
  type: "string",
  description: "Collection name. Passed to the driver as a value, so it needs no escaping.",
} as const;

/**
 * The read + discovery tools, always present. Mirrors the pg trio's intent — find (the common lookup),
 * aggregate (the one Mongo needs that SQL does not: grouping, $lookup joins, $unwind), and the two
 * things a model cannot guess: what collections exist (with sizes) and what shape one has.
 *
 * No separate indexes/count/distinct tool — each is an aggregate the model can write itself, and every
 * tool schema is re-sent on every request across endpoints.
 */
const READ_TOOLS: ToolDef[] = [
  {
    name: "mongo_find",
    description:
      "Query a collection with a filter. Returns { documents }. Projection narrows the fields; sort and " +
      "skip page through results. A find with no `limit` is capped at " + DEFAULT_ROW_LIMIT + " documents and says " +
      "so in the reply — raise `limit` (max " + MAX_ROW_LIMIT + ") to read more. NULL/absent fields are dropped " +
      "from each document; run mongo_describe_collection for the full field picture.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_ARG,
        filter: { type: "object", description: "A MongoDB query document, e.g. { status: 'active', age: { $gte: 18 } }. Defaults to {}." },
        projection: { type: "object", description: "Fields to include/exclude, e.g. { email: 1, _id: 0 }." },
        sort: { type: "object", description: "Sort spec, e.g. { createdAt: -1 }." },
        limit: { type: "number", description: "Document cap (default " + DEFAULT_ROW_LIMIT + ", max " + MAX_ROW_LIMIT + ")." },
        skip: { type: "number", description: "Documents to skip (offset)." },
      },
      required: ["collection"],
    },
  },
  {
    name: "mongo_aggregate",
    description:
      "Run an aggregation pipeline — grouping, $lookup joins, $unwind, $project reshaping. Returns " +
      "{ result }. Output is capped at " + MAX_ROW_LIMIT + " rows and says so if it bit. When this MCP is " +
      "readonly, $out and $merge stages are refused (they write).",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_ARG,
        pipeline: { type: "array", description: "Pipeline stages, e.g. [{ $match: { ... } }, { $group: { _id: '$x', n: { $sum: 1 } } }]." },
      },
      required: ["collection", "pipeline"],
    },
  },
  {
    name: "mongo_list_collections",
    description:
      "List collections with their type, approximate document count and on-disk size — use this before " +
      "querying, to know what exists and what is big enough to need a limit.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mongo_describe_collection",
    description:
      "Shape of one collection: indexes, the $jsonSchema validator if any, and a field schema inferred " +
      "from a 100-document sample (field, dominant type, prevalence). Mongo is schemaless, so this is a " +
      "best-effort picture, not a constraint.",
    inputSchema: { type: "object", properties: { collection: COLLECTION_ARG }, required: ["collection"] },
  },
];

/** Write tools, present only when the MCP is not readonly (hidden from tools/list otherwise). */
const WRITE_TOOLS: ToolDef[] = [
  {
    name: "mongo_insert_many",
    description:
      "Insert documents into a collection. Returns { insertedCount, insertedIds }. At most 1000 documents " +
      "per call. An empty `documents` array is an error, not a no-op.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_ARG,
        documents: { type: "array", description: "Documents to insert.", items: {} },
        ordered: { type: "boolean", description: "Stop on first error (default true)." },
      },
      required: ["collection", "documents"],
    },
  },
  {
    name: "mongo_update_many",
    description:
      "Update every document matching `filter`. Returns { matchedCount, modifiedCount, upsertedId? }. An " +
      "empty filter updates the whole collection — state that explicitly when you mean it.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_ARG,
        filter: { type: "object", description: "Which documents to update." },
        update: { type: "object", description: "Update document or aggregation pipeline, e.g. { $set: { status: 'x' } }." },
        upsert: { type: "boolean", description: "Insert a document when none match (default false)." },
      },
      required: ["collection", "filter", "update"],
    },
  },
  {
    name: "mongo_delete_many",
    description:
      "Delete every document matching `filter`. Returns { deletedCount }. An empty filter deletes the " +
      "whole collection — state that explicitly when you mean it.",
    inputSchema: {
      type: "object",
      properties: {
        collection: COLLECTION_ARG,
        filter: { type: "object", description: "Which documents to delete." },
      },
      required: ["collection", "filter"],
    },
  },
];

const ALL_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Stage operators that write to a collection, so an aggregate can write even though it looks like a read. */
const WRITE_STAGES = new Set(["$out", "$merge"]);

/** True if an aggregation pipeline contains a writing stage. Pure, so it is unit-testable without a DB. */
export function writesViaAggregate(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some((stage) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) return false;
    return Object.keys(stage as Record<string, unknown>).some((k) => WRITE_STAGES.has(k));
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * In-process MongoDB adapter: a single `mongodb` MongoClient behind find/aggregate tools and discovery
 * tools. The driver is imported on first use, so a gateway with no Mongo MCP never loads `mongodb`.
 *
 * Read-only is enforced by tool presence (the three write tools drop out of tools/list) plus a
 * pipeline guard that refuses `$out`/`$merge` — Mongo has no equivalent of Postgres'
 * `default_transaction_read_only`, so unlike SQL there is no session-level boundary to lean on.
 */
export class MongoAdapter extends DirectAdapter {
  readonly type = "mongo";

  /** Read tools always; write tools only when the MCP is writable — live with `readonly` on the def. */
  protected get tools(): ToolDef[] {
    return this.readonly ? READ_TOOLS : ALL_TOOLS;
  }

  private readonly conn = new Lazy<MongoClient>(() => this.createClient());

  /** The database this endpoint talks to: an explicit `database` on the def, else the URI's path. */
  private get database(): string {
    if (this.def.database) return String(this.def.database);
    try {
      return decodeURIComponent(new URL(String(this.def.url ?? "")).pathname.replace(/^\//, ""));
    } catch {
      return "";
    }
  }

  /** Where this endpoint points — "app @ localhost:27017". Shown to clients; never a password. */
  protected get target(): string {
    try {
      const u = new URL(String(this.def.url ?? ""));
      return `${this.database || "mongo"} @ ${u.hostname}:${u.port || 27017}`;
    } catch {
      return "mongo";
    }
  }

  protected resources() {
    const database = this.database;
    if (!database) return undefined;
    return mongoResources(database, this.like());
  }

  protected open(): Promise<unknown> {
    return this.conn.get();
  }

  private async db(): Promise<Db> {
    const client = await this.conn.get();
    return client.db(this.database || undefined);
  }

  private async createClient(): Promise<MongoClient> {
    const { default: mongodb } = await import("mongodb");
    const client = new mongodb.MongoClient(String(this.def.url ?? ""), {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    return client;
  }

  /** Build the MongoLike the resource provider reads from, over the shared client + database. */
  private like(): MongoLike {
    const getDb = () => this.db();
    return {
      async stats() {
        const db = await getDb();
        try {
          const s = await db.command({ dbStats: 1 });
          return { collections: num(s.collections), dataSize: num(s.dataSize), storageSize: num(s.storageSize) };
        } catch {
          // dbStats can be refused on some hosted clusters; the overview degrades to zeros.
          return { collections: 0, dataSize: 0, storageSize: 0 };
        }
      },
      async collections(): Promise<CollectionStat[]> {
        const db = await getDb();
        const list = await db.listCollections({}, { nameOnly: false }).toArray();
        return Promise.all(
          list.map(async (c): Promise<CollectionStat> => {
            const name = String(c.name);
            let count = 0;
            let bytes = 0;
            try {
              const st = await db.command({ collStats: name });
              count = num(st.count);
              bytes = num(st.storageSize ?? st.size);
            } catch {
              // Views and some time-series shapes refuse collStats; report them with no size.
            }
            return { name, type: String(c.type ?? "collection"), count, bytes };
          }),
        );
      },
      async describe(name: string): Promise<CollectionInfo> {
        const db = await getDb();
        const [meta, stats, idx] = await Promise.all([
          db.listCollections({ name }, { nameOnly: false }).toArray(),
          db.command({ collStats: name }).catch(() => ({})),
          db.collection(name).listIndexes().toArray().catch(() => []),
        ]);
        const c = meta[0] as { type?: string; options?: { validator?: unknown } } | undefined;
        const s = stats as { count?: number; storageSize?: number; size?: number };
        return {
          name,
          type: String(c?.type ?? "collection"),
          count: num(s.count),
          bytes: num(s.storageSize ?? s.size),
          indexes: (idx as Array<Record<string, unknown>>).map((i) => ({
            name: String(i.name),
            keys: (i.key as Record<string, number | string>) ?? {},
            ...(i.unique ? { unique: true } : {}),
            ...(i.sparse ? { sparse: true } : {}),
            ...(i.expireAfterSeconds != null ? { ttl: Number(i.expireAfterSeconds) } : {}),
          })),
          ...(c?.options?.validator ? { validator: c.options.validator } : {}),
        };
      },
      async sample(name: string, size: number) {
        const db = await getDb();
        return db.collection(name).aggregate([{ $sample: { size } }]).toArray() as Promise<Record<string, unknown>[]>;
      },
    };
  }

  protected async call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const db = await this.db();
    switch (tool) {
      case "mongo_find": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        const requested = args?.limit;
        const limit = clampRowLimit(requested, this.maxRows);
        const options = {
          limit,
          ...(args?.projection != null ? { projection: args.projection } : {}),
          ...(args?.sort != null ? { sort: args.sort } : {}),
          ...(args?.skip != null ? { skip: Number(args.skip) } : {}),
        } as FindOptions;
        const rows = await db
          .collection(collection)
          .find((args?.filter ?? {}) as Filter<Document>, options)
          .toArray();
        const documents = dropNullColumns(rows);
        if (requested == null && rows.length >= limit) {
          return { documents, note: `no limit requested, so a default limit of ${limit} was applied — there may be more documents.` };
        }
        return { documents };
      }
      case "mongo_aggregate": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        const pipeline = args?.pipeline;
        if (!Array.isArray(pipeline)) throw new Error("pipeline must be an array of stages");
        if (this.readonly && writesViaAggregate(pipeline)) {
          throw new Error("refused: this mongo MCP is readonly and the pipeline writes ($out/$merge)");
        }
        const rows = await db.collection(collection).aggregate(pipeline).toArray();
        if (rows.length > MAX_ROW_LIMIT) {
          return { result: rows.slice(0, MAX_ROW_LIMIT), note: `result capped at ${MAX_ROW_LIMIT} rows — there may be more.` };
        }
        return { result: rows };
      }
      case "mongo_list_collections": {
        const like = this.like();
        const stats = await like.collections();
        return stats
          .slice()
          .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
          .map((s) => ({ name: s.name, type: s.type, count: s.count || undefined, size: s.bytes ? humanBytes(s.bytes) : undefined }));
      }
      case "mongo_describe_collection": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        return describeCollection(this.like(), this.database, collection);
      }
      case "mongo_insert_many": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        const documents = args?.documents;
        if (!Array.isArray(documents)) throw new Error("documents must be an array");
        if (documents.length === 0) throw new Error("documents must not be empty");
        if (documents.length > 1000) throw new Error("documents must be at most 1000 per call");
        const res = await db.collection(collection).insertMany(documents, {
          ...(args?.ordered === false ? { ordered: false } : {}),
        });
        return { insertedCount: res.insertedCount, insertedIds: Object.values(res.insertedIds) };
      }
      case "mongo_update_many": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        const res = await db
          .collection(collection)
          .updateMany((args?.filter ?? {}) as Filter<Document>, args?.update as UpdateFilter<Document>, {
            ...(args?.upsert ? { upsert: true } : {}),
          });
        const out: Record<string, unknown> = { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
        if (res.upsertedId != null) out.upsertedId = res.upsertedId;
        return out;
      }
      case "mongo_delete_many": {
        const collection = String(args?.collection ?? "");
        if (!collection) throw new Error("collection is required");
        const res = await db.collection(collection).deleteMany((args?.filter ?? {}) as Filter<Document>);
        return { deletedCount: res.deletedCount };
      }
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  async ping(): Promise<void> {
    const db = await this.db();
    const res = await db.command({ ping: 1 });
    if (res?.ok !== 1) throw new Error("mongo ping did not return ok");
  }

  async close(): Promise<void> {
    await this.conn.take()?.close();
  }
}
