import type { Pool, QueryResult } from "pg";
import { DirectAdapter, Lazy } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import {
  assertReadOnly, clampRowLimit, dropNullColumns, limitReport, withRowLimit,
  DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT,
} from "./sql.js";
import { pgResources } from "./pg-resources.js";
import type { ResourceProvider } from "./resources.js";

const SCHEMA_ARG = { type: "string", description: "Schema name. Defaults to every non-system schema." } as const;
const TABLE_ARG = { type: "string", description: "Table name (unqualified)." } as const;

/**
 * Three tools: run a statement, and the two things a model cannot guess — what tables exist (with
 * sizes, so it knows what needs a LIMIT) and what columns they have.
 *
 * Deliberately no pg_list_indexes / pg_list_schemas / pg_explain. Each was a `pg_query` the model can
 * write itself (`pg_indexes`, the schema column already in pg_list_tables, `EXPLAIN`), and every tool
 * schema is re-sent on every request across both Postgres endpoints.
 */
const TOOLS: ToolDef[] = [
  {
    name: "pg_query",
    description:
      "Run a SQL statement. Returns { command, rowCount, rows } — so an UPDATE/DELETE reports how many " +
      "rows it actually touched. A SELECT written without its own LIMIT is capped at " +
      `${DEFAULT_ROW_LIMIT} rows and says so in the reply — raise \`limit\` or write your own ` +
      "LIMIT/OFFSET to page through more. NULL columns are omitted from each row (pg_describe_table " +
      "gives the full column list), so on a wide table name the columns you need rather than SELECT *.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL statement to execute." },
        limit: { type: "number", description: `Row cap for a LIMIT-less SELECT (default ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}).` },
      },
      required: ["sql"],
    },
  },
  {
    name: "pg_list_tables",
    description:
      "List tables and views with their approximate row count and on-disk size — use this before " +
      "querying, to know what exists and what is big enough to need a LIMIT.",
    inputSchema: { type: "object", properties: { schema: SCHEMA_ARG } },
  },
  {
    name: "pg_describe_table",
    description:
      "Columns of a table: type, nullability, default, and which columns form the primary key. " +
      "For indexes, query pg_indexes; for a plan, run EXPLAIN through pg_query.",
    inputSchema: { type: "object", properties: { table: TABLE_ARG, schema: { type: "string", description: "Schema name (default 'public')." } }, required: ["table"] },
  },
];

const LIST_TABLES_SQL = `
  SELECT n.nspname AS schema,
         c.relname  AS name,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                        WHEN 'p' THEN 'partitioned table' WHEN 'f' THEN 'foreign table' END AS type,
         -- reltuples is -1 when the table has never been analyzed; report that as unknown rather
         -- than as a row count of minus one.
         CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS approx_rows,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','v','m','p','f')
     AND n.nspname NOT IN ('pg_catalog','information_schema')
     AND ($1::text IS NULL OR n.nspname = $1)
   ORDER BY 1, 2`;

const DESCRIBE_SQL = `
  SELECT column_name, data_type, is_nullable, column_default,
         character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
   WHERE table_schema = $1 AND table_name = $2
   ORDER BY ordinal_position`;

const PK_SQL = `
  SELECT a.attname AS column
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass
     AND i.indisprimary`;

/**
 * In-process PostgreSQL adapter: a small pg Pool behind a query tool and two discovery tools. `pg` is
 * imported on first use, so a gateway with no Postgres MCP never pays for it.
 */
export class PgAdapter extends DirectAdapter {
  readonly type = "pg";
  protected readonly tools = TOOLS;
  private readonly conn = new Lazy<Pool>(() => this.createPool());

  /** Database name out of the connection URL, or "" when the URL is unusable. */
  private get database(): string {
    try {
      const u = new URL(String(this.def.url ?? ""));
      return decodeURIComponent(u.pathname.replace(/^\//, ""));
    } catch {
      return "";
    }
  }

  /** The database this endpoint talks to, with the password stripped. */
  protected get target(): string {
    try {
      const u = new URL(String(this.def.url ?? ""));
      return `${this.database || "postgres"} @ ${u.hostname}:${u.port || 5432}`;
    } catch {
      return "postgres";
    }
  }

  protected resources(): ResourceProvider | undefined {
    const database = this.database;
    if (!database) return undefined;
    return pgResources(database, async (sql, params) => {
      const pool = await this.conn.get();
      return (await pool.query(sql, params)).rows as Array<Record<string, unknown>>;
    });
  }

  protected open(): Promise<Pool> {
    return this.conn.get();
  }

  private async createPool(): Promise<Pool> {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: String(this.def.url ?? ""),
      max: 4,
      connectionTimeoutMillis: 5000,
      // Longer than the health-probe interval on purpose: with the pg default of 10s, every 15s probe
      // opened a brand-new backend and let it time out again — a forked Postgres process per probe.
      idleTimeoutMillis: 60000,
      // A runaway query used to hold a pool slot forever; five of them starved the pool and the
      // health probe with it, so the panel showed "down" for a gateway that had blocked itself.
      statement_timeout: 15000,
      query_timeout: 20000,
      // Server-enforced read-only session — the actual boundary, unlike the statement-shape check.
      ...(this.readonly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    // A pool that emits 'error' with no listener takes the process down (idle client killed by the
    // server, network drop). Swallow it: the pool discards the client and the next query reconnects.
    pool.on("error", () => { /* handled by the pool itself */ });
    return pool;
  }

  /** Shape one pg result for the model: what ran, how many rows it touched, and the rows themselves. */
  private static summarize(res: QueryResult | QueryResult[]): unknown {
    const one = (r: QueryResult) => ({ command: r.command, rowCount: r.rowCount ?? 0, rows: dropNullColumns(r.rows ?? []) });
    return Array.isArray(res) ? res.map(one) : one(res);
  }

  protected async call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const pool = await this.conn.get();
    switch (tool) {
      case "pg_query": {
        const sql = String(args?.sql ?? "").trim();
        if (!sql) throw new Error("sql is required");
        if (this.readonly) assertReadOnly(sql, "Postgres");
        const prepared = withRowLimit(sql, clampRowLimit(args?.limit, this.maxRows));
        const summary = PgAdapter.summarize(await pool.query(prepared.sql));
        if (Array.isArray(summary)) return summary; // several results: nothing to annotate
        const { rowCount } = summary as { rowCount: number };
        return { ...(summary as object), ...limitReport(prepared, rowCount, args?.limit) };
      }
      case "pg_list_tables":
        return (await pool.query(LIST_TABLES_SQL, [args?.schema ? String(args.schema) : null])).rows;
      case "pg_describe_table": {
        const schema = String(args?.schema ?? "public");
        const table = String(args?.table ?? "");
        if (!table) throw new Error("table is required");
        const [cols, pk] = await Promise.all([
          pool.query(DESCRIBE_SQL, [schema, table]),
          pool.query(PK_SQL, [schema, table]).catch(() => ({ rows: [] as Array<{ column: string }> })),
        ]);
        if (!cols.rows.length) throw new Error(`no such table: ${schema}.${table}`);
        return { schema, table, primaryKey: pk.rows.map((r) => r.column), columns: cols.rows };
      }
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  async ping(): Promise<void> {
    const pool = await this.conn.get();
    const res = await pool.query("SELECT 1 AS ok");
    if (res.rows?.[0]?.ok !== 1) throw new Error("pg SELECT 1 returned no row");
  }

  async close(): Promise<void> {
    await this.conn.take()?.end();
  }
}
