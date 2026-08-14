import { describe, it, expect } from "vitest";
import {
  mongoResources, inferSchema, collectionFamilies, describeCollection,
  type IndexInfo, type MongoLike,
} from "../src/adapters/mongo-resources.js";
import { ResourceFault } from "../src/adapters/resources.js";

/** A stand-in Mongo: two ordinary collections plus a 9-member time-series shard set the listing must fold. */
function fakeMongo(opts: { shardCount?: number; docs?: Record<string, unknown>[] } = {}): MongoLike {
  const shards = opts.shardCount ?? 9;
  return {
    async stats() {
      return { collections: 2 + shards, dataSize: 1_234_567, storageSize: 987_654 };
    },
    async collections() {
      const out = [
        { name: "orders", type: "collection", count: 12_000, bytes: 500_000 },
        { name: "users", type: "collection", count: 843, bytes: 40_000 },
        ...Array.from({ length: shards }, (_, i) => ({
          name: `metrics_${String(202401 + i).padStart(6, "0")}`,
          type: "timeseries",
          count: 1000,
          bytes: 12_000,
        })),
      ];
      return out;
    },
    async describe(name: string) {
      // Annotated so the object literals widen to IndexInfo, not a discriminated union whose
      // `email?: undefined` would break the index signature.
      const indexes: IndexInfo[] = [
        { name: "_id_", keys: { _id: 1 } },
        { name: "email_uniq", keys: { email: 1 }, unique: true },
      ];
      return {
        name,
        type: "collection",
        count: 843,
        bytes: 40_000,
        indexes,
        ...(name === "users" ? { validator: { $jsonSchema: { required: ["email"] } } } : {}),
      };
    },
    async sample(_name: string, _size: number) {
      return (
        opts.docs ?? [
          { _id: "x", email: "a@b", age: 30 },
          { _id: "y", email: "c@d" }, // age absent here
          { _id: "z", email: null, age: null }, // email null + age null
        ]
      );
    },
  };
}

describe("inferSchema", () => {
  it("reports dominant type, prevalence and nullability, sorted by prevalence", () => {
    const schema = inferSchema([
      { email: "a@b", age: 30 },
      { email: "c@d", age: 31 },
      { email: null }, // age absent
    ]);
    expect(schema.sampled).toBe(3);
    const byField = new Map(schema.fields.map((f) => [f.field, f]));
    expect(byField.get("email")).toMatchObject({ type: "string", prevalence: 100, nullable: true });
    expect(byField.get("age")).toMatchObject({ type: "number", prevalence: 67 });
    expect(byField.get("age")?.nullable).toBeUndefined(); // never null, just absent
    expect(schema.fields[0].field).toBe("email"); // 100% before 67%
  });

  it("names array/object/date/objectId types rather than collapsing to object", () => {
    const d = new Date("2024-01-01");
    const schema = inferSchema([{ a: [1], o: { x: 1 }, d, id: { constructor: { name: "ObjectId" } } as never }]);
    const byField = new Map(schema.fields.map((f) => [f.field, f.type]));
    expect(byField.get("a")).toBe("array");
    expect(byField.get("o")).toBe("object");
    expect(byField.get("d")).toBe("date");
    expect(byField.get("id")).toBe("objectId");
  });

  it("caps the field list so a wide sparse collection cannot flood", () => {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) doc[`f${i}`] = i;
    const schema = inferSchema([doc], 50);
    expect(schema.fields).toHaveLength(50);
  });

  it("returns an empty schema for an empty collection", () => {
    expect(inferSchema([])).toEqual({ sampled: 0, fields: [] });
  });
});

describe("collectionFamilies", () => {
  it("collapses the time-series shard set into one family, largest collection first", async () => {
    const fams = await collectionFamilies(fakeMongo());
    const names = fams.map((f) => f.name);
    expect(names[0]).toBe("orders"); // 500 KB beats everything
    // 'metrics' base is absent, so the family is named metrics_*; all 9 shards are its members.
    const metrics = fams.find((f) => f.name.startsWith("metrics"));
    expect(metrics?.members).toHaveLength(9);
    expect(metrics?.name).toBe("metrics_*");
  });
});

describe("mongoResources", () => {
  it("lists the overview first, then collections with the shard set collapsed", async () => {
    const { resources, nextCursor } = await mongoResources("shop", fakeMongo()).list();
    expect(resources[0]).toMatchObject({ uri: "mongo://shop", mimeType: "application/json" });
    // orders, users, metrics_* — three logical entries, nothing to page.
    expect(resources.filter((r) => r.uri !== "mongo://shop")).toHaveLength(3);
    expect(resources.some((r) => r.uri.endsWith("/metrics_202401"))).toBe(false);
    expect(nextCursor).toBeUndefined();
  });

  it("pages, and repeats the overview on the first page only", async () => {
    // Names end in a non-digit so collapseShards leaves each distinct (a trailing-number suffix
    // would fold all 450 into one family, which is not what this pagination test is exercising).
    const many = Array.from({ length: 450 }, (_, i) => ({ name: `c${i}_x`, type: "collection", count: 1, bytes: 1 }));
    const like: MongoLike = {
      async stats() { return { collections: 450, dataSize: 0, storageSize: 0 }; },
      async collections() { return many; },
      async describe() { return { name: "x", type: "collection", count: 0, bytes: 0, indexes: [] }; },
      async sample() { return []; },
    };
    const provider = mongoResources("db", like);
    const p1 = await provider.list();
    expect(p1.resources).toHaveLength(201); // overview + 200
    expect(p1.nextCursor).toBe("200");
    const p2 = await provider.list(p1.nextCursor);
    expect(p2.resources.some((r) => r.uri === "mongo://db")).toBe(false);
    expect(p2.nextCursor).toBeDefined();
  });

  it("offers one template covering any collection", () => {
    expect(mongoResources("shop", fakeMongo()).templates()[0].uriTemplate).toBe("mongo://shop/{collection}");
  });

  it("reads the overview as JSON naming the collapsed shard set", async () => {
    const [body] = await mongoResources("shop", fakeMongo()).read("mongo://shop");
    const j = JSON.parse(body.text);
    expect(j.database).toBe("shop");
    expect(j.collections).toBe(3); // logical
    expect(j.physicalCollections).toBe(11); // 2 + 9 shards
    expect(j.collapsedShardSets[0]).toMatchObject({ collection: "metrics_*", shards: 9 });
    expect(j.largest[0].collection).toBe("orders");
  });

  it("reads a collection as JSON with indexes, validator and a sampled schema", async () => {
    const [body] = await mongoResources("shop", fakeMongo()).read("mongo://shop/users");
    const j = JSON.parse(body.text);
    expect(j).toMatchObject({ database: "shop", collection: "users" });
    expect(j.indexes.map((i: { name: string }) => i.name)).toEqual(["_id_", "email_uniq"]);
    expect(j.indexes[1]).toMatchObject({ unique: true });
    expect(j.validator).toMatchObject({ $jsonSchema: { required: ["email"] } });
    expect(j.sampledSchema.sampled).toBe(3);
    const email = j.sampledSchema.fields.find((f: SchemaFieldLike) => f.field === "email");
    expect(email).toMatchObject({ type: "string", prevalence: 100, nullable: true });
  });

  it("refuses another database and reports it clearly", async () => {
    await expect(mongoResources("shop", fakeMongo()).read("mongo://other/users")).rejects.toThrow(
      /connected to shop/,
    );
  });

  it("shares the describe body between resource read and the tool helper", async () => {
    const like = fakeMongo();
    const [body] = await mongoResources("shop", like).read("mongo://shop/users");
    const fromHelper = await describeCollection(like, "shop", "users");
    expect(JSON.parse(body.text)).toEqual(fromHelper);
  });
});

type SchemaFieldLike = { field: string; type: string; prevalence: number; nullable?: true };
