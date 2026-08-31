import {
  collapseShards, describeFamily, humanBytes, page, splitUri,
  ResourceFault, type Family, type ResourceBody, type ResourceEntry, type ResourceProvider,
  type ResourceTemplate, type TableFact,
} from "./resources.js";

/** Runs one parameterized statement and returns its rows. Injected so this is testable without a DB. */
export type PgQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const RELKINDS = "('r','v','m','p','f')";
const KIND_CASE = `CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                        WHEN 'p' THEN 'partitioned table' WHEN 'f' THEN 'foreign table' END`;

const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS name,
         -- reltuples is -1 before the first ANALYZE; that is "unknown", not "minus one row".
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows_est,
         pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ${RELKINDS}
     AND n.nspname NOT IN ('pg_catalog','information_schema')`;

/**
 * Everything one table's resource says, in a single round trip.
 *
 * Deliberately not assembled from `pg_describe_table`'s three queries: a resource read is one
 * user-visible action, so it should be one 75 ms trip rather than three. Primary-key columns come out
 * in table order; `indexes` carries the definitions, which is where a composite key's real column
 * order is visible.
 */
const ONE_TABLE_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, ${KIND_CASE} AS type,
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows_est,
         pg_total_relation_size(c.oid) AS bytes,
         obj_description(c.oid, 'pg_class') AS comment,
         (SELECT json_agg(json_build_object(
                   'column', a.attname,
                   'type', format_type(a.atttypid, a.atttypmod),
                   'nullable', NOT a.attnotnull,
                   'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
         (SELECT json_agg(a.attname ORDER BY a.attnum)
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
           WHERE i.indrelid = c.oid AND i.indisprimary) AS primary_key,
         (SELECT json_agg(indexdef ORDER BY indexname)
            FROM pg_indexes WHERE schemaname = n.nspname AND tablename = c.relname) AS indexes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${RELKINDS}`;

const SCHEMAS_SQL = `
  SELECT n.nspname AS schema, count(*) AS tables, sum(pg_total_relation_size(c.oid)) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ${RELKINDS}
     AND n.nspname NOT IN ('pg_catalog','information_schema')
   GROUP BY 1 ORDER BY 3 DESC`;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `public.channels` → `{schema:"public", table:"channels"}`; a bare name defaults to `public`. */
function splitQualified(rest: string): { schema: string; table: string } {
  const dot = rest.indexOf(".");
  if (dot < 0) return { schema: "public", table: rest };
  const schema = rest.slice(0, dot);
  const table = rest.slice(dot + 1);
  if (!schema || !table) throw new ResourceFault(`not a schema-qualified table: ${rest}`);
  return { schema, table };
}

/**
 * Postgres schema as resources. A typical database is small (tens to a couple of hundred tables),
 * so the listing is flat — shard collapsing still runs, and simply finds nothing to collapse.
 *
 * Identifiers are always bound parameters, never interpolated, so no identifier escaping is needed.
 */
export function pgResources(database: string, query: PgQuery): ResourceProvider {
  const overviewUri = `pg://${database}`;

  async function families(): Promise<Family[]> {
    const rows = await query(TABLES_SQL);
    const facts: TableFact[] = rows.map((r) => ({
      name: `${r.schema}.${r.name}`,
      rows: num(r.rows_est),
      bytes: num(r.bytes),
    }));
    return collapseShards(facts);
  }

  async function overview(): Promise<string> {
    const [fams, schemas] = await Promise.all([families(), query(SCHEMAS_SQL)]);
    return JSON.stringify(
      {
        database,
        tables: fams.reduce((a, f) => a + f.members.length, 0),
        schemas: schemas.map((s) => ({
          schema: String(s.schema),
          tables: num(s.tables),
          size: humanBytes(num(s.bytes)),
        })),
        largest: fams.slice(0, 30).map((f) => ({
          table: f.name,
          rows: f.rows || undefined,
          size: f.bytes ? humanBytes(f.bytes) : undefined,
        })),
        notes: [
          `Read pg://${database}/<schema>.<table> for columns, primary key and indexes.`,
          "Row estimates come from pg_class.reltuples and move with ANALYZE; the table list is live.",
        ],
      },
      null,
      2,
    );
  }

  async function tableBody(rest: string): Promise<string> {
    const { schema, table } = splitQualified(rest);
    const rows = await query(ONE_TABLE_SQL, [schema, table]);
    if (!rows.length) throw new ResourceFault(`no such table: ${schema}.${table}`);
    const r = rows[0];
    return JSON.stringify(
      {
        database,
        schema: String(r.schema),
        table: String(r.name),
        type: r.type ?? "table",
        approxRows: num(r.rows_est) || undefined,
        size: humanBytes(num(r.bytes)),
        comment: r.comment ?? undefined,
        primaryKey: r.primary_key ?? [],
        columns: r.columns ?? [],
        indexes: r.indexes ?? [],
      },
      null,
      2,
    );
  }

  return {
    async list(cursor?: string) {
      const fams = await families();
      const { slice, nextCursor } = page(fams, cursor);
      const resources: ResourceEntry[] = [];
      if (!cursor) {
        resources.push({
          uri: overviewUri,
          name: database,
          description: `Schema overview: ${fams.length} tables, live from the catalog`,
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
          uriTemplate: `pg://${database}/{schema}.{table}`,
          name: `${database} table schema`,
          description: "Columns, primary key, indexes and size of any table in this database.",
          mimeType: "application/json",
        },
      ];
    },

    async read(uri: string): Promise<ResourceBody[]> {
      const { authority, rest } = splitUri(uri, "pg");
      if (authority !== database) {
        throw new ResourceFault(`this MCP is connected to ${database}, not ${authority}`);
      }
      if (!rest) return [{ uri, mimeType: "application/json", text: await overview() }];
      return [{ uri, mimeType: "application/json", text: await tableBody(rest) }];
    },
  };
}
