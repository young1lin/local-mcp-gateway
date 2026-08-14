import {
  assertIdent, collapseShards, describeFamily, humanBytes, page, splitUri,
  ResourceFault, type Family, type ResourceBody, type ResourceEntry, type ResourceProvider,
  type ResourceTemplate, type TableFact,
} from "./resources.js";

/** Runs one statement and returns its rows. Injected so the provider is testable without a MySQL. */
export type SqlQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

/**
 * Every table in the current database with the two numbers that decide ordering.
 *
 * `data_length + index_length` rather than `data_length`: a table whose bulk is its indexes is still
 * a big table. Both, plus `table_rows`, come from the statistics snapshot that
 * `information_schema_stats_expiry` governs (86400s by default), so they can lag a day — which
 * affects only the ordering, never whether a table is listed or what its DDL says.
 */
const TABLES_SQL = `
  SELECT table_name AS name, table_type AS type, table_rows AS rows_est,
         COALESCE(data_length, 0) + COALESCE(index_length, 0) AS bytes
    FROM information_schema.tables
   WHERE table_schema = ?`;

const ONE_TABLE_SQL = `
  SELECT table_type AS type, table_rows AS rows_est,
         COALESCE(data_length, 0) + COALESCE(index_length, 0) AS bytes
    FROM information_schema.tables
   WHERE table_schema = ? AND table_name = ?`;

/** Siblings of a possible shard set, matched by prefix and filtered exactly in JS. */
const SIBLINGS_SQL = `
  SELECT table_name AS name
    FROM information_schema.tables
   WHERE table_schema = ? AND table_name LIKE CONCAT(?, '%') ESCAPE '!'`;

/** LIKE treats `_` and `%` as wildcards, and table names are full of underscores. */
function likePrefix(name: string): string {
  return name.replace(/[!%_]/g, (c) => `!${c}`);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * MySQL schema as resources: one overview of the database, one entry per logical table.
 *
 * The database is fixed to the one this MCP is connected to. The connection can see the instance's
 * other schemas (an instance can host thousands of tables across several databases), but a picker
 * holding all of them helps nobody — cross-database work is a `db.table` query away through
 * `mysql_query`.
 */
export function mysqlResources(database: string, query: SqlQuery): ResourceProvider {
  const overviewUri = `mysql://${database}`;
  const tableUri = (name: string) => `${overviewUri}/${name}`;

  async function families(): Promise<Family[]> {
    const rows = await query(TABLES_SQL, [database]);
    const facts: TableFact[] = rows.map((r) => ({
      name: String(r.name),
      rows: num(r.rows_est),
      bytes: num(r.bytes),
    }));
    return collapseShards(facts);
  }

  async function overview(): Promise<string> {
    const fams = await families();
    const shardSets = fams.filter((f) => f.members.length > 1);
    return JSON.stringify(
      {
        database,
        physicalTables: fams.reduce((a, f) => a + f.members.length, 0),
        logicalTables: fams.length,
        shardSets: shardSets.length,
        largest: fams.slice(0, 30).map((f) => ({
          table: f.name,
          rows: f.rows || undefined,
          size: f.bytes ? humanBytes(f.bytes) : undefined,
          shards: f.members.length > 1 ? f.members.length : undefined,
        })),
        collapsedShardSets: shardSets.map((f) => ({
          table: f.name,
          shards: f.members.length,
          range: `${f.members[0]} … ${f.members[f.members.length - 1]}`,
        })),
        notes: [
          `Read mysql://${database}/<table> for a table's CREATE statement.`,
          "Row counts and sizes come from MySQL's statistics snapshot and can lag up to a day; " +
            "the table list itself is read live from the data dictionary.",
          "Shard sets are collapsed into one entry — query any individual shard by its real name.",
        ],
      },
      null,
      2,
    );
  }

  async function tableBody(name: string): Promise<string> {
    assertIdent(name, "table name");
    const [meta, ddlRows, siblings] = await Promise.all([
      query(ONE_TABLE_SQL, [database, name]),
      query(`SHOW CREATE TABLE \`${database}\`.\`${name}\``).catch(() => [] as Array<Record<string, unknown>>),
      query(SIBLINGS_SQL, [database, likePrefix(name)]),
    ]);
    if (!meta.length) throw new ResourceFault(`no such table: ${database}.${name}`);

    const info = meta[0];
    // SHOW CREATE TABLE names its column after the object kind: `Create Table` or `Create View`.
    const ddl = ddlRows.length
      ? String(Object.entries(ddlRows[0]).find(([k]) => /^create /i.test(k))?.[1] ?? "")
      : "";

    const shardRe = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_?\\d{1,8}$`);
    const shards = siblings.map((r) => String(r.name)).filter((n) => shardRe.test(n)).sort();

    const header = [
      `-- ${database}.${name} (${String(info.type ?? "TABLE").toLowerCase()})`,
      num(info.rows_est) || num(info.bytes)
        ? `-- ~${num(info.rows_est)} rows · ${humanBytes(num(info.bytes))} (statistics snapshot, may lag a day)`
        : undefined,
      shards.length
        ? `-- sharded: ${shards.length} sibling tables ${shards[0]} … ${shards[shards.length - 1]}, same columns; ` +
          `query one directly by name`
        : undefined,
    ].filter(Boolean) as string[];

    if (!ddl) throw new ResourceFault(`no DDL available for ${database}.${name}`);
    return `${header.join("\n")}\n${ddl}`;
  }

  return {
    async list(cursor?: string) {
      const fams = await families();
      const { slice, nextCursor } = page(fams, cursor);
      const resources: ResourceEntry[] = [];
      // The overview belongs on the first page: it is the map for everything after it.
      if (!cursor) {
        resources.push({
          uri: overviewUri,
          name: database,
          description: `Schema overview: ${fams.length} logical tables, live from the data dictionary`,
          mimeType: "application/json",
        });
      }
      for (const f of slice) {
        resources.push({
          uri: tableUri(f.name),
          name: f.name,
          description: describeFamily(f) || undefined,
          mimeType: "text/plain",
        });
      }
      return { resources, nextCursor };
    },

    templates(): ResourceTemplate[] {
      return [
        {
          uriTemplate: `mysql://${database}/{table}`,
          name: `${database} table DDL`,
          description:
            "CREATE statement of any table in this database, including an individual shard of a " +
            "collapsed shard set.",
          mimeType: "text/plain",
        },
      ];
    },

    async read(uri: string): Promise<ResourceBody[]> {
      const { authority, rest } = splitUri(uri, "mysql");
      if (authority !== database) {
        throw new ResourceFault(`this MCP is connected to ${database}, not ${authority}`);
      }
      if (!rest) return [{ uri, mimeType: "application/json", text: await overview() }];
      return [{ uri, mimeType: "text/plain", text: await tableBody(rest) }];
    },
  };
}
