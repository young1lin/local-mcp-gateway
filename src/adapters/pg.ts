import type { Pool, QueryResult } from "pg";
import { DirectAdapter, Lazy } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import {
  assertReadOnly, clampRowLimit, dropNullColumns, isReadOnlySql, limitReport, withRowLimit, likeContains,
  tablePageArgs, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, DEFAULT_TABLE_LIMIT, MAX_TABLE_LIMIT,
} from "./sql.js";
import {
  BROWSE_DEFAULT_PAGE, BROWSE_TABLES_MAX, BROWSE_TABLES_PAGE, browseCountSql, browseOffset,
  browseOrder, browsePageSize, browseRowsSql, buildEditStatements, buildFilterWhere, clampBrowseLimit,
  toBrowseColumns, toBrowseIndexes, buildPgDdl, toCsv, toJsonLines, exportRowLimit,
  EXPORT_CHUNK, EXPORT_ROW_CAP, mapImportRows, IMPORT_ROW_CAP, buildDdlOpSql, type ImportMapping, type DdlOp,
  type BrowseColumn, type BrowseEditResult, type BrowseForeignKey,
  type BrowseTableInfo, type BrowseTableDetail, type DbBrowser, type ExportResult,
} from "../dbbrowser.js";
import { pgResources } from "./pg-resources.js";
import type { ResourceProvider } from "./resources.js";

const SCHEMA_ARG = { type: "string", description: "Schema name. Defaults to every non-system schema." } as const;
const TABLE_ARG = { type: "string", description: "Table name (unqualified)." } as const;
const GREP_ARG = {
  type: "string",
  description:
    "Keep only tables whose name contains this substring (case-insensitive): \"users\" lists p_users, " +
    "users_settings, … Optional — omit to list everything.",
} as const;
const LIMIT_ARG = {
  type: "number",
  description: `Max tables per page (default ${DEFAULT_TABLE_LIMIT}, max ${MAX_TABLE_LIMIT}).`,
} as const;
const PAGE_ARG = {
  type: "number",
  description: "0-based page index through the filtered list (default 0) — the reply's total/more say what is left.",
} as const;

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
      "querying, to know what exists and what is big enough to need a LIMIT. Paged: limit per page " +
      "(default 200, max 1000) and 0-based page; the reply carries total and more. Pass `grep` to " +
      'keep only names containing it: grep "users" lists p_users, users_settings, …',
    inputSchema: { type: "object", properties: { schema: SCHEMA_ARG, grep: GREP_ARG, limit: LIMIT_ARG, page: PAGE_ARG } },
  },
  {
    name: "pg_describe_table",
    description:
      "Columns of a table: type, nullability, default, and which columns form the primary key. " +
      "For indexes, query pg_indexes; for a plan, run EXPLAIN through pg_query.",
    inputSchema: { type: "object", properties: { table: TABLE_ARG, schema: { type: "string", description: "Schema name (default 'public')." } }, required: ["table"] },
  },
];

export const LIST_TABLES_SQL = `
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
     -- $2 is a ready-built %substring% pattern (likeContains); ESCAPE '!' keeps its % and _ literal.
     AND ($2::text IS NULL OR c.relname ILIKE $2 ESCAPE '!')
   ORDER BY 1, 2
   LIMIT $3 OFFSET $4`;

/** Same filter, counted — so a page can say how much of the list is behind it. */
export const COUNT_TABLES_SQL = `
  SELECT count(*)::int AS total
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','v','m','p','f')
     AND n.nspname NOT IN ('pg_catalog','information_schema')
     AND ($1::text IS NULL OR n.nspname = $1)
     AND ($2::text IS NULL OR c.relname ILIKE $2 ESCAPE '!')`;

export const DESCRIBE_SQL = `
  SELECT column_name, data_type, is_nullable, column_default,
         character_maximum_length, numeric_precision, numeric_scale,
         col_description(format('%I.%I', table_schema, table_name)::regclass, ordinal_position) AS column_comment
    FROM information_schema.columns
   WHERE table_schema = $1 AND table_name = $2
   ORDER BY ordinal_position`;

const PK_SQL = `
  SELECT a.attname AS column
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass
     AND i.indisprimary`;

/** Indexes with their full CREATE INDEX statement, one row per index. pg_index is joined (not
 *  just pg_indexes) because only it carries indisprimary — pg_indexes lists the PRIMARY KEY index
 *  like any other unique index, and its name is only CONVENTIONALLY <table>_pkey. */
export const PG_BROWSE_INDEXES_SQL = `
  SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
         CASE WHEN i.indisprimary THEN 1 ELSE 0 END AS is_primary
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
   WHERE n.nspname = $1
     AND i.indrelid = format('%I.%I', $1::text, $2::text)::regclass
   ORDER BY ic.relname`;

/** Foreign keys: one row per column of each referencing constraint (LATERAL UNNEST walks the
 *  conkey/confkey column-number pairs in lockstep). */
const PG_BROWSE_FK_SQL = `
  SELECT con.conname AS name, a.attname AS column,
         fn.nspname AS ref_schema, cf.relname AS ref_table, af.attname AS ref_column
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class cf ON cf.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = cf.relnamespace
    CROSS JOIN LATERAL UNNEST(con.conkey, con.confkey) AS k(attnum, ref_attnum)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = k.ref_attnum
   WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
   ORDER BY con.conname, a.attnum`;

/**
 * The filter params LIST_TABLES_SQL / COUNT_TABLES_SQL expect: [schema-or-null, grep-or-null]
 * (the LIMIT/OFFSET pair is appended by the caller). The Data view lists every non-system schema,
 * so the schema slot is always null — but it must still BE there, or the bind message supplies
 * one parameter fewer than the statement's placeholders and Postgres refuses the query.
 */
export function pgBrowseTableParams(grep?: string): Array<string | null> {
  return [null, grep ? likeContains(grep) : null];
}

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
      case "pg_list_tables": {
        const paging = tablePageArgs(args);
        const filters = [
          args?.schema ? String(args.schema) : null,
          args?.grep ? likeContains(String(args.grep)) : null,
        ];
        const [list, count] = await Promise.all([
          pool.query(LIST_TABLES_SQL, [...filters, paging.limit, paging.offset]),
          pool.query(COUNT_TABLES_SQL, filters),
        ]);
        const total = Number((count.rows[0] as { total?: number } | undefined)?.total ?? 0);
        return {
          tables: list.rows,
          total,
          page: paging.page,
          limit: paging.limit,
          more: paging.offset + list.rows.length < total,
        };
      }
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

  // --- admin panel Data view ---------------------------------------------------------------------

  /**
   * The Data view's browser, riding the same pool the MCP tools use. Reads page server-side; the
   * edit batch checks out ONE pool client for BEGIN ... COMMIT so a failure rolls the whole batch
   * back (see dbbrowser.ts for the contract).
   */
  dbBrowser(): DbBrowser {
    type Runner = {
      query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; fields?: Array<{ name?: string }>; rowCount?: number | null }>;
      // The object form forces the EXTENDED protocol: node-postgres uses the simple query protocol
      // for a bare string, and simple is the one that runs `SELECT 1; DROP TABLE t` as two
      // statements. With a values array (even empty) the server rejects multiple commands at
      // Parse — the second wall behind isReadOnlySql for the read-only console.
      query(q: { text: string; values?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>>; fields?: Array<{ name?: string }>; rowCount?: number | null }>;
    };
    const metaOf = async (run: Runner, schema: string, table: string) => {
      const [cols, pk] = await Promise.all([
        run.query(DESCRIBE_SQL, [schema, table]),
        run.query(PK_SQL, [schema, table]).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
      ]);
      if (!cols.rows.length) throw new Error(`no such table: ${schema}.${table}`);
      const pkCols = (pk.rows as Array<{ column: string }>).map((r) => String(r.column));
      return { columns: toBrowseColumns(cols.rows, pkCols), pk: pkCols };
    };

    return {
      dialect: "pg",
      readonly: this.readonly,
      label: this.target,
      listTables: async (o) => {
        const pool = (await this.conn.get()) as unknown as Runner;
        const page = Math.max(0, Math.floor(Number(o.page) || 0));
        const limit = clampBrowseLimit(o.limit, BROWSE_TABLES_PAGE, BROWSE_TABLES_MAX);
        const filters = pgBrowseTableParams(o.grep ? String(o.grep) : undefined);
        const [list, count] = await Promise.all([
          pool.query(LIST_TABLES_SQL, [...filters, limit, page * limit]),
          pool.query(COUNT_TABLES_SQL, filters),
        ]);
        const tables = list.rows.map((r): BrowseTableInfo => ({
          schema: String(r.schema),
          name: String(r.name),
          type: String(r.type),
          approxRows: r.approx_rows == null ? null : Number(r.approx_rows),
          size: String(r.size ?? ""),
        }));
        const total = Number(count.rows[0]?.total ?? 0);
        return { tables, total, page, limit, more: page * limit + tables.length < total };
      },
      readTable: async (o) => {
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const schema = String(o.schema ?? "public");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns, pk } = await metaOf(pool, schema, table);
        const offset = browseOffset(o.offset);
        const limit = browsePageSize(o.limit);
        const names = columns.map((c: BrowseColumn) => c.name);
        const order = browseOrder(names, o.order, o.dir, "pg");
        // Full columns (not just names): a contains filter on a non-text column needs CAST(col AS
        // text) ILIKE on Postgres, and only the column list knows the types.
        const where = buildFilterWhere("pg", columns, o.filters ?? []);
        const rowsStmt = browseRowsSql("pg", { schema, table }, names, order, offset, limit, where.frag, where.params);
        const cntStmt = browseCountSql("pg", { schema, table }, where.frag, where.params);
        const [rowsRes, cntRes] = await Promise.all([
          pool.query(rowsStmt.sql, rowsStmt.params),
          pool.query(cntStmt.sql, cntStmt.params),
        ]);
        const total = Number(cntRes.rows[0]?.total ?? 0);
        return {
          schema,
          table,
          columns,
          rows: rowsRes.rows,
          total,
          offset,
          limit,
          primaryKey: pk,
          editable: !this.readonly && pk.length > 0,
          editNote: this.readonly
            ? "this MCP is configured readonly"
            : pk.length ? undefined : "table has no primary key, so a row cannot be addressed for edits",
        };
      },
      describeTable: async (o) => {
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const schema = String(o.schema ?? "public");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns, pk } = await metaOf(pool, schema, table);
        const [idxRes, fkRes] = await Promise.all([
          pool.query(PG_BROWSE_INDEXES_SQL, [schema, table]),
          pool.query(PG_BROWSE_FK_SQL, [schema, table]).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
        ]);
        const indexes = toBrowseIndexes(
          (idxRes.rows as Array<Record<string, unknown>>).map((r) => ({
            name: r.name,
            // A CREATE UNIQUE INDEX says so in its definition; the PK index is flagged by
            // indisprimary itself, not by a <table>_pkey name guess.
            unique: String(r.definition ?? "").startsWith("CREATE UNIQUE") ? 0 : 1,
            primary: r.is_primary,
            column: null, // the definition already lists the columns; nothing to fold
            definition: r.definition,
          })),
        );
        const foreignKeys: BrowseForeignKey[] = (fkRes.rows as Array<Record<string, unknown>>).map((r) => ({
          name: String(r.name),
          column: String(r.column),
          refSchema: String(r.ref_schema),
          refTable: String(r.ref_table),
          refColumn: String(r.ref_column),
        }));
        return {
          schema,
          table,
          columns,
          primaryKey: pk,
          indexes,
          foreignKeys,
          // Postgres has no SHOW CREATE TABLE — a faithful sketch from the catalog (dbbrowser.ts).
          ddl: buildPgDdl({ schema, table }, columns, pk, foreignKeys),
        };
      },
      applyEdits: async (o) => {
        if (this.readonly) throw new Error("refused: this Postgres MCP is configured readonly — editing is disabled");
        const table = String(o.table ?? "");
        const edits = o.edits ?? [];
        if (!table) throw new Error("table is required");
        if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array");
        const schema = String(o.schema ?? "public");
        const pool = await this.conn.get();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const run = client as unknown as Runner;
          const { columns, pk } = await metaOf(run, schema, table);
          const stmts = buildEditStatements("pg", { schema, table }, edits, columns, pk);
          const results: BrowseEditResult[] = [];
          for (let i = 0; i < stmts.length; i++) {
            const res = await run.query(stmts[i].sql, stmts[i].params);
            results.push({ op: edits[i].op, affected: res.rowCount ?? 0 });
          }
          await client.query("COMMIT");
          return { results };
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch { /* the connection is already broken */ }
          throw err;
        } finally {
          client.release();
        }
      },
      exportTable: async (o) => {
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const schema = String(o.schema ?? "public");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns } = await metaOf(pool, schema, table);
        const names = columns.map((c: BrowseColumn) => c.name);
        const cap = exportRowLimit(o.limit);
        const all: Array<Record<string, unknown>> = [];
        let capped = false;
        for (let offset = 0; offset < cap; offset += EXPORT_CHUNK) {
          const chunk = Math.min(EXPORT_CHUNK, cap - offset);
          const stmt = browseRowsSql("pg", { schema, table }, names, null, offset, chunk);
          const res = await pool.query(stmt.sql, stmt.params);
          all.push(...res.rows);
          if (res.rows.length < chunk) break;
          if (offset + chunk >= cap) capped = true;
        }
        return {
          format: o.format === "json" ? "json" : "csv",
          columns: names,
          rows: all.length,
          capped: capped || all.length >= EXPORT_ROW_CAP,
          body: o.format === "json" ? toJsonLines(all) : toCsv(names, all),
        } satisfies ExportResult;
      },
      importTable: async (o) => {
        if (this.readonly) throw new Error("refused: this Postgres MCP is configured readonly — import is disabled");
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        if (o.lines.length > IMPORT_ROW_CAP) throw new Error(`too many rows for one import (max ${IMPORT_ROW_CAP})`);
        const rows = mapImportRows(o.header, o.lines, o.mapping);
        if (!rows.length) throw new Error("nothing to import after mapping — every row was empty or skipped");
        const edits = rows.map((values) => ({ op: "insert" as const, values }));
        const schema = String(o.schema ?? "public");
        const pool = await this.conn.get();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const run = client as unknown as Runner;
          const { columns } = await metaOf(run, schema, table);
          const stmts = buildEditStatements("pg", { schema, table }, edits, columns, []);
          for (const s of stmts) await run.query(s.sql, s.params);
          await client.query("COMMIT");
          return { inserted: rows.length };
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch { /* already broken */ }
          throw err;
        } finally {
          client.release();
        }
      },
      ddlOp: async (o) => {
        if (this.readonly) throw new Error("refused: this Postgres MCP is configured readonly — structure operations are disabled");
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const schema = String(o.schema ?? "public");
        const sql = buildDdlOpSql("pg", o.op, { schema, table }, { to: o.to });
        const pool = (await this.conn.get()) as unknown as Runner;
        await pool.query(sql);
        return { ran: sql };
      },
      runQuery: async (sql, limit) => {
        const s = String(sql ?? "").trim();
        if (!s) throw new Error("sql is required");
        if (!isReadOnlySql(s)) {
          throw new Error("the Data view console is read-only — edit rows in the grid instead (edits commit as one transaction)");
        }
        const pool = (await this.conn.get()) as unknown as Runner;
        const prepared = withRowLimit(s, clampRowLimit(limit, BROWSE_DEFAULT_PAGE));
        // Object form on purpose (see Runner above): the console is read-only by contract, and the
        // extended protocol refuses a stacked second statement server-side even if a masked-literal
        // trick ever slips one past isReadOnlySql. pg_query (the MCP tool) keeps the string form —
        // multi-statement there is a feature summarize() already reports per result.
        const res = await pool.query({ text: prepared.sql, values: [] });
        const columns = res.rows.length
          ? Object.keys(res.rows[0])
          : (res.fields ?? []).map((f) => String(f.name));
        return {
          columns,
          rows: res.rows,
          rowCount: res.rows.length,
          ...limitReport(prepared, res.rows.length, limit),
        };
      },
    };
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
