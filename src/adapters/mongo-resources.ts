import {
  collapseShards, describeFamily, humanBytes, page, splitUri,
  ResourceFault, type Family, type ResourceBody, type ResourceEntry, type ResourceProvider,
  type ResourceTemplate, type TableFact,
} from "./resources.js";

/**
 * MongoDB collections as MCP resources — the schema a client attaches with `@`, instead of spending a
 * tool call on it.
 *
 * Mongo is schemaless: there is no `CREATE TABLE` to read the way mysql/pg do, so a collection's
 * "schema" is not a fact the server holds. Two things ARE facts — its indexes and its $jsonSchema
 * validator (if any) — and those are cheap and exact. What fields actually live in the documents is
 * not, so it is *inferred* from a bounded sample (Mongo-Compass style): fetch up to SAMPLE_SIZE docs,
 * walk them in JS, and report each top-level field's dominant type and prevalence. That is a best
 * effort with a known ceiling, never a scan of the whole collection.
 *
 * As with the other adapters, nothing is cached and nothing is interpolated: a collection name reaches
 * the driver as a value (a command field, a `db.collection(name)` argument), never spliced into a
 * string, so — unlike SQL `SHOW CREATE TABLE` — it needs no identifier escaping.
 */

/** What the adapter tells the provider about one collection's catalog presence. */
export interface CollectionStat {
  name: string;
  /** "collection" | "view" | "timeseries" — straight from listCollections. */
  type: string;
  /** Estimated document count; 0 when the server has none (e.g. a view). */
  count: number;
  /** On-disk storage bytes; 0 when unknown. */
  bytes: number;
}

/** One index on a collection, from listIndexes. */
export interface IndexInfo {
  name: string;
  /** The indexed key spec, e.g. `{ email: 1 }`, `{ "a.b": -1, c: 1 }`, or `{ body: "text" }`. */
  keys: Record<string, number | string>;
  unique?: boolean;
  sparse?: boolean;
  /** Seconds, on a TTL index. */
  ttl?: number;
}

/** Everything `describe()` returns in one round — the certain metadata. */
export interface CollectionInfo {
  name: string;
  type: string;
  count: number;
  bytes: number;
  indexes: IndexInfo[];
  /** The collection's $jsonSchema validator, when one is set; undefined otherwise. */
  validator?: unknown;
}

/** Database-level totals for the overview. */
export interface DbStats {
  collections: number;
  dataSize: number;
  storageSize: number;
}

/**
 * The subset of a MongoClient the resource provider needs.
 *
 * Injected (like the SQL `query` fn and the redis `RedisLike`) so the provider is pure logic testable
 * with a fake. The adapter builds this over a real `mongodb` driver; each method is one or a few
 * commands, never a scan.
 */
export interface MongoLike {
  stats(): Promise<DbStats>;
  collections(): Promise<CollectionStat[]>;
  describe(name: string): Promise<CollectionInfo>;
  sample(name: string, size: number): Promise<Record<string, unknown>[]>;
}

/** Documents sampled to infer a schema. 100 keeps the read bounded yet representative. */
export const SAMPLE_SIZE = 100;
/** Top-level fields reported; the rest are dropped so a 1000-field sparse collection cannot flood. */
export const MAX_SCHEMA_FIELDS = 50;

export interface SchemaField {
  field: string;
  /** Dominant type across the sample ("null" excluded from dominance). */
  type: string;
  /** Percent of sampled documents that contain this field, 0–100. */
  prevalence: number;
  /** Present when null was seen alongside a real type. */
  nullable?: true;
}
export interface SampledSchema {
  sampled: number;
  fields: SchemaField[];
}

/** A Mongo/BSON-aware type name for one value, for schema inference. */
function fieldType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return "date";
  // The driver hands back class instances for BSON types the JSON primitives can't hold; ObjectId is
  // the common one, so name it rather than collapsing it into "object".
  const cn = (v as { constructor?: { name?: string } })?.constructor?.name;
  if (cn === "ObjectId") return "objectId";
  if (cn === "Long") return "long";
  if (cn === "Decimal128") return "decimal";
  if (cn === "Binary") return "binary";
  if (typeof v === "object") return "object";
  return typeof v;
}

/**
 * Infer a top-level field schema from a sample of documents.
 *
 * A field present in 98 of 100 docs reports prevalence 98 and its dominant type; if any sampled value
 * was null alongside a real type, it is flagged nullable. "null" never wins dominance, so a
 * string-or-null field reads as `string` with `nullable`, not as `null`. Nested object shapes are not
 * expanded (reported as type "object") — top-level fields are what a model needs to write a first query.
 */
export function inferSchema(docs: Record<string, unknown>[], maxFields = MAX_SCHEMA_FIELDS): SampledSchema {
  const sampled = docs.length;
  if (!sampled) return { sampled: 0, fields: [] };

  const types = new Map<string, Map<string, number>>(); // field -> type -> count
  const present = new Map<string, number>(); // field -> docs where present

  for (const doc of docs) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    for (const [field, value] of Object.entries(doc)) {
      present.set(field, (present.get(field) ?? 0) + 1);
      const t = fieldType(value);
      let tm = types.get(field);
      if (!tm) { tm = new Map(); types.set(field, tm); }
      tm.set(t, (tm.get(t) ?? 0) + 1);
    }
  }

  const fields: SchemaField[] = [];
  for (const [field, count] of present) {
    const tm = types.get(field)!;
    const nullable = (tm.get("null") ?? 0) > 0;
    let best = "null";
    let bestN = -1;
    for (const [t, n] of tm) {
      if (t !== "null" && n > bestN) { best = t; bestN = n; }
    }
    fields.push({
      field,
      type: best,
      prevalence: Math.round((count / sampled) * 100),
      ...(nullable && best !== "null" ? { nullable: true } : {}),
    });
  }

  fields.sort((a, b) => b.prevalence - a.prevalence || a.field.localeCompare(b.field));
  return { sampled, fields: fields.slice(0, maxFields) };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Collections collapsed into logical families (sharded/time-series suffixes folded), largest first. */
export async function collectionFamilies(like: MongoLike): Promise<Family[]> {
  const stats = await like.collections();
  const facts: TableFact[] = stats.map((s) => ({ name: s.name, rows: num(s.count), bytes: num(s.bytes) }));
  return collapseShards(facts);
}

/** The overview body (returned for `mongo://<db>`), shared by the resource read. */
export async function overviewBody(like: MongoLike, database: string): Promise<unknown> {
  const [fams, st] = await Promise.all([collectionFamilies(like), like.stats()]);
  const collapsed = fams.filter((f) => f.members.length > 1);
  return {
    database,
    collections: fams.length,
    physicalCollections: fams.reduce((a, f) => a + f.members.length, 0),
    dataSize: humanBytes(st.dataSize),
    storageSize: humanBytes(st.storageSize),
    largest: fams.slice(0, 30).map((f) => ({
      collection: f.name,
      docs: f.rows || undefined,
      size: f.bytes ? humanBytes(f.bytes) : undefined,
    })),
    collapsedShardSets: collapsed.map((f) => ({ collection: f.name, shards: f.members.length })),
    notes: [
      `Read mongo://${database}/<collection> for indexes, the $jsonSchema validator and a sampled field schema.`,
      "Collection names reach the driver as values, never interpolated, so no identifier escaping is needed.",
    ],
  };
}

/** One collection's body (returned for `mongo://<db>/<collection>`), shared by resource read and tool. */
export async function describeCollection(like: MongoLike, database: string, name: string): Promise<unknown> {
  const [info, docs] = await Promise.all([like.describe(name), like.sample(name, SAMPLE_SIZE)]);
  return {
    database,
    collection: name,
    type: info.type,
    count: info.count || undefined,
    size: humanBytes(info.bytes),
    indexes: info.indexes,
    validator: info.validator,
    sampledSchema: inferSchema(docs),
    notes: [
      `Schema is inferred from up to ${SAMPLE_SIZE} sampled documents; Mongo collections are schemaless, so absent fields may still occur and types may vary per document.`,
      "Only top-level fields are listed; nested object shapes are not expanded.",
    ],
  };
}

/**
 * MongoDB as resources. Mirrors the SQL adapters: one overview plus one entry per logical collection,
 * sharded suffixes collapsed, paginated. The scheme is `mongo://<db>/<collection>`.
 */
export function mongoResources(database: string, like: MongoLike): ResourceProvider {
  const overviewUri = `mongo://${database}`;

  return {
    async list(cursor?: string) {
      const fams = await collectionFamilies(like);
      const { slice, nextCursor } = page(fams, cursor);
      const resources: ResourceEntry[] = [];
      if (!cursor) {
        resources.push({
          uri: overviewUri,
          name: database,
          description: `Collection overview: ${fams.length} collections, live from the catalog`,
          mimeType: "application/json",
        });
      }
      for (const f of slice) {
        resources.push({
          uri: `${overviewUri}/${f.name}`,
          name: f.name,
          description: describeFamily(f) || undefined,
          mimeType: "application/json",
        });
      }
      return { resources, nextCursor };
    },

    templates(): ResourceTemplate[] {
      return [
        {
          uriTemplate: `mongo://${database}/{collection}`,
          name: `${database} collection schema`,
          description: "Indexes, $jsonSchema validator and a sampled field schema of any collection.",
          mimeType: "application/json",
        },
      ];
    },

    async read(uri: string): Promise<ResourceBody[]> {
      const { authority, rest } = splitUri(uri, "mongo");
      if (authority !== database) {
        throw new ResourceFault(`this MCP is connected to ${database}, not ${authority}`);
      }
      if (!rest) {
        return [{ uri, mimeType: "application/json", text: JSON.stringify(await overviewBody(like, database), null, 2) }];
      }
      return [{ uri, mimeType: "application/json", text: JSON.stringify(await describeCollection(like, database, rest), null, 2) }];
    },
  };
}
