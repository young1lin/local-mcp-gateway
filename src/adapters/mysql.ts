import type { Pool, PoolOptions } from "mysql2/promise";
import { DirectAdapter, Lazy } from "./direct.js";
import type { ServerDef } from "../config.js";
import type { ToolDef } from "./tool-server.js";
import {
  assertReadOnly, clampRowLimit, dropNullColumns, isReadOnlySql, limitReport, withRowLimit, likeContains,
  tablePageArgs, DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, DEFAULT_TABLE_LIMIT, MAX_TABLE_LIMIT,
} from "./sql.js";
import {
  BROWSE_DEFAULT_PAGE, BROWSE_TABLES_MAX, BROWSE_TABLES_PAGE, browseCountSql, browseOffset,
  browseOrder, browsePageSize, browseRowsSql, buildEditStatements, buildFilterWhere, clampBrowseLimit, qualified,
  toBrowseColumns, toBrowseIndexes, toCsv, toJsonLines, exportRowLimit, EXPORT_CHUNK, EXPORT_ROW_CAP,
  mapImportRows, IMPORT_ROW_CAP, buildDdlOpSql, type ImportMapping, type DdlOp,
  type BrowseColumn, type BrowseEditResult, type BrowseForeignKey,
  type BrowseTableInfo, type BrowseTableDetail, type DbBrowser, type ExportResult,
} from "../dbbrowser.js";
import { mysqlResources } from "./mysql-resources.js";
import { humanBytes, type ResourceProvider } from "./resources.js";

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
 * Two tools: the query tool (matching the single-tool MySQL MCP this replaced), and a table listing
 * with an optional name filter.
 *
 * SHOW TABLES exists, but it answers names only — no sizes, no row estimates, no filtering — so on
 * an instance with thousands of tables the model shipped the whole list and grepped it client-side.
 * mysql_list_tables is that one call done properly: sizes and row estimates beside the names, and a
 * server-side grep. DESCRIBE t, SHOW INDEX FROM t and EXPLAIN stay un-wrapped, unlike Postgres's
 * describe tool: they are one-liners every model already knows, and each wrapper schema is re-sent
 * on every request.
 *
 * Targets MySQL 8.0+.
 */
const TOOLS: ToolDef[] = [
  {
    name: "mysql_query",
    description:
      "Run a SQL statement (SELECT / INSERT / UPDATE / DELETE / DDL, plus SHOW / DESCRIBE / EXPLAIN for " +
      "schema and plans). Returns { rowCount, rows } for a SELECT, or { affectedRows, insertId, " +
      `changedRows } for DML/DDL. A SELECT written without its own LIMIT is capped at ${DEFAULT_ROW_LIMIT} ` +
      "rows and says so in the reply — raise `limit` or write your own LIMIT/OFFSET for more. " +
      "NULL columns are omitted from each row (use DESCRIBE for the full column list), so on a wide " +
      "table name the columns you need rather than SELECT *.",
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
    name: "mysql_list_tables",
    description:
      "List the connected database's tables and views with their approximate row count and on-disk " +
      "size — use this before querying, to know what exists and what is big enough to need a LIMIT. " +
      "Paged: limit per page (default 200, max 1000) and 0-based page; the reply carries total and " +
      'more. Pass `grep` to keep only names containing it: grep "users" lists p_users, users_settings, …',
    inputSchema: { type: "object", properties: { grep: GREP_ARG, limit: LIMIT_ARG, page: PAGE_ARG } },
  },
];

/** One row mysql_list_tables hands back — the same shape as pg_list_tables, so a model that knows one
 *  reads the other. approx_rows is an estimate (NULL for views); size is data + indexes. */
interface ListedTable {
  schema: string;
  name: string;
  type: string;
  approx_rows: number | null;
  size: string;
}

/**
 * The queries behind mysql_list_tables, built as { list, count } so the filtering and paging logic
 * is testable without a live MySQL. count shares the list's WHERE so a page can report the filtered
 * total beside the rows.
 *
 * Row counts and sizes come from the statistics snapshot information_schema serves — cached up to
 * information_schema_stats_expiry (a day by default), the same caveat as mysql-resources.ts. The
 * grep filter and the paging are applied SERVER-side: with thousands of tables on an instance,
 * shipping the whole list to drop most of it client-side is exactly what grep and pages exist to
 * avoid. LIKE under MySQL's default _ci collation is case-insensitive, matching Postgres's ILIKE.
 */
export function mysqlListTables(
  database: string,
  grep?: string,
  paging: { page: number; limit: number; offset: number } = { page: 0, limit: DEFAULT_TABLE_LIMIT, offset: 0 },
): { list: { sql: string; params: unknown[] }; count: { sql: string; params: unknown[] } } {
  const pattern = grep ? likeContains(grep) : null;
  const where = `table_schema = ?${pattern ? " AND table_name LIKE ? ESCAPE '!'" : ""}`;
  return {
    list: {
      sql: `
      SELECT table_name AS name,
            CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view'
                            ELSE LOWER(table_type) END AS type,
            table_rows AS approx_rows,
            COALESCE(data_length, 0) + COALESCE(index_length, 0) AS bytes
        FROM information_schema.tables
       WHERE ${where}
       ORDER BY table_name
       LIMIT ? OFFSET ?`,
      params: pattern
        ? [database, pattern, paging.limit, paging.offset]
        : [database, paging.limit, paging.offset],
    },
    count: {
      sql: `
      SELECT COUNT(*) AS total
        FROM information_schema.tables
       WHERE ${where}`,
      params: pattern ? [database, pattern] : [database],
    },
  };
}

/** Columns of one table for the Data view — the shape toBrowseColumns reads. Every column is
 *  aliased to its lowercase name: MySQL 8 reports information_schema columns back in UPPERCASE
 *  when the select list is unaliased, which would leave toBrowseColumns reading undefined.
 *  column_comment rides along so the panel can say what a field means, not just its type. */
export const MYSQL_BROWSE_COLUMNS_SQL = `
  SELECT column_name AS column_name, data_type AS data_type,
         is_nullable AS is_nullable, column_default AS column_default,
         column_comment AS column_comment
    FROM information_schema.columns
   WHERE table_schema = ? AND table_name = ?
   ORDER BY ordinal_position`;

/** Indexes, one row per indexed column (aliased: MySQL uppercases unaliased catalog columns).
 *  PRIMARY is folded in from statistics rather than a second query. */
export const MYSQL_BROWSE_INDEXES_SQL = `
  SELECT index_name AS name, CAST(non_unique AS SIGNED) AS unique0,
         0 AS is_primary, column_name AS col
    FROM information_schema.statistics
   WHERE table_schema = ? AND table_name = ?
   ORDER BY index_name, seq_in_index`;

/** Foreign keys: one row per column of each referencing constraint. */
export const MYSQL_BROWSE_FK_SQL = `
  SELECT kcu.constraint_name AS name, kcu.column_name AS col,
         kcu.referenced_table_schema AS ref_schema, kcu.referenced_table_name AS ref_table,
         kcu.referenced_column_name AS ref_column
    FROM information_schema.key_column_usage kcu
   WHERE kcu.table_schema = ? AND kcu.table_name = ?
     AND kcu.referenced_table_name IS NOT NULL
   ORDER BY kcu.constraint_name, kcu.ordinal_position`;

/** The PRIMARY KEY's columns, in key order — the address an edit's WHERE clause speaks. */
const MYSQL_BROWSE_PK_SQL = `
  SELECT column_name AS column_name
    FROM information_schema.key_column_usage
   WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
   ORDER BY ordinal_position`;

/**
 * The pool options every MySQL connection shares. Exported as a pure builder so the flags that are
 * only observable against a live server still have a regression test.
 */
export function mysqlPoolOptions(def: ServerDef): PoolOptions {
  return {
    host: String(def.host ?? "localhost"),
    port: Number(def.port ?? 3306),
    user: String(def.user ?? ""),
    password: String(def.password ?? ""),
    database: def.database ? String(def.database) : undefined,
    timezone: String(def.timezone ?? "Z"),
    connectionLimit: 5, // a handful of local clients, not a web app
    queueLimit: 20, // bound the backlog instead of growing it without limit
    connectTimeout: 5000,
    dateStrings: true, // keep DATE/DATETIME as strings (avoids TZ surprises)
    // BIGINT must survive the wire as an exact string: 18-19 digit ids (snowflake) are not
    // representable as a JS double, and mysql2's default Number() conversion silently rounds
    // their low digits — 734023681584275456 arrives as 734023681584275500 in every row, grid
    // cell, export and model reply. Strings are exact end to end, and MySQL coerces a numeric
    // string back against the column on bind, so edits and filters keep working.
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}

/**
 * The health verdict on `SELECT 1 AS ok`. A bare integer literal is typed LONGLONG by the server,
 * so with bigNumberStrings the row comes back as `{ ok: "1" }` — the exact-string mode that keeps
 * 18-digit ids whole. Both spellings mean healthy; anything else (or no row at all) is not.
 */
export function pingOk(rows: unknown): boolean {
  const first = Array.isArray(rows) ? (rows[0] as { ok?: unknown } | undefined) : undefined;
  return first != null && String(first.ok) === "1";
}

/** The per-connection session statements a pool hands every new connection. */
export function mysqlSessionSql(readonly: boolean): string[] {
  // `max_execution_time` caps runaway SELECTs server-side (mysql2 has no per-query timeout), and
  // the read-only session default is the real guard behind the statement-shape check — MySQL
  // refuses writes outright.
  const session = [`SET SESSION max_execution_time = 15000`];
  if (readonly) session.push("SET SESSION TRANSACTION READ ONLY");
  return session;
}

/**
 * Run those statements on every connection the pool opens.
 *
 * The 'connection' event carries a CALLBACK-API connection: its `query()` returns undefined, not a
 * promise, so the first cut's `conn.query(sql).catch(...)` never sent anything — mysql2 logged "you
 * tried to call .then()" on every connect and the session guard silently did not exist. The
 * promise face (`conn.promise()`) is the one that actually executes here.
 */
export function wireMysqlSession(
  pool: { on: (event: "connection", listener: (conn: unknown) => void) => unknown },
  readonly: boolean,
): void {
  pool.on("connection", (conn) => {
    // The event carries the CORE (callback) connection. The promise-side PoolConnection type does
    // not declare .promise(), but the runtime object has it — that face is the one that executes.
    const session = conn as SessionConn;
    for (const sql of mysqlSessionSql(readonly)) {
      session.promise().query(sql).catch(() => { /* older servers may not know the statement */ });
    }
  });
}

interface SessionConn {
  promise(): { query(sql: string): Promise<unknown> };
}

/**
 * In-process MySQL adapter: a small mysql2 pool behind one query tool. `mysql2` is imported on first
 * use (~10 MB of RSS, measured) rather than at boot.
 */
export class MysqlAdapter extends DirectAdapter {
  readonly type = "mysql";
  protected readonly tools = TOOLS;
  private readonly conn = new Lazy<Pool>(() => this.createPool());

  protected get target(): string {
    const where = `${this.def.host ?? "localhost"}:${this.def.port ?? 3306}`;
    return this.def.database ? `${this.def.database} @ ${where}` : where;
  }

  /**
   * Schema as resources, scoped to the configured database.
   *
   * Without a `database` there is nothing to scope a listing to — the connection would see every
   * table of the instance — so the capability is simply not announced in that case.
   */
  protected resources(): ResourceProvider | undefined {
    const database = this.def.database ? String(this.def.database) : "";
    if (!database) return undefined;
    return mysqlResources(database, async (sql, params) => {
      const pool = await this.conn.get();
      const [rows] = await pool.query(sql, params);
      return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    });
  }

  protected open(): Promise<Pool> {
    return this.conn.get();
  }

  private async createPool(): Promise<Pool> {
    const { default: mysql } = await import("mysql2/promise");
    const pool = mysql.createPool(mysqlPoolOptions(this.def));
    wireMysqlSession(pool, this.readonly);
    return pool;
  }

  protected async call(tool: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const pool = await this.conn.get();
    switch (tool) {
      case "mysql_query": {
        const sql = String(args?.sql ?? "").trim();
        if (!sql) throw new Error("sql is required");
        if (this.readonly) assertReadOnly(sql, "MySQL");
        const prepared = withRowLimit(sql, clampRowLimit(args?.limit, this.maxRows));
        const [result] = await pool.query(prepared.sql);
        if (Array.isArray(result)) {
          return {
            rowCount: result.length,
            // `result` is a union of row shapes here; a nested array (multi-statement) passes through.
            rows: dropNullColumns(result as unknown[]),
            ...limitReport(prepared, result.length, args?.limit),
          };
        }
        const h = result as { affectedRows?: number; insertId?: number; changedRows?: number; info?: string };
        return { affectedRows: h.affectedRows ?? 0, insertId: h.insertId ?? 0, changedRows: h.changedRows ?? 0, info: h.info ?? "" };
      }
      case "mysql_list_tables": {
        const database = String(this.def.database ?? "");
        if (!database) {
          throw new Error(
            "no database configured on this MySQL MCP — set its database field, or query " +
            "information_schema.tables through mysql_query",
          );
        }
        const paging = tablePageArgs(args);
        const q = mysqlListTables(database, args?.grep ? String(args.grep) : undefined, paging);
        const [listRes, countRes] = await Promise.all([
          pool.query(q.list.sql, q.list.params),
          pool.query(q.count.sql, q.count.params),
        ]);
        const tables = (listRes[0] as Array<Record<string, unknown>>).map((r): ListedTable => ({
          schema: database,
          name: String(r.name),
          type: String(r.type),
          // table_rows is an estimate (NULL for views) — keep NULL as unknown rather than 0.
          approx_rows: r.approx_rows == null ? null : Number(r.approx_rows),
          size: humanBytes(Number(r.bytes ?? 0)),
        }));
        const total = Number((countRes[0] as Array<{ total?: number }> | undefined)?.[0]?.total ?? 0);
        return {
          tables,
          total,
          page: paging.page,
          limit: paging.limit,
          more: paging.offset + tables.length < total,
        };
      }
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  // --- admin panel Data view ---------------------------------------------------------------------

  /** Anything that can run parameterized queries — the pool for reads, one dedicated connection
   *  for a transactional edit batch. Structural so both slot into the same helpers. */
  private browseRunner(): Promise<unknown> {
    return this.conn.get();
  }

  /**
   * The Data view's browser, riding the same pool the MCP tools use. Reads page server-side; the
   * edit batch takes ONE connection from the pool for BEGIN ... COMMIT so a failure rolls the
   * whole batch back (see dbbrowser.ts for the contract).
   */
  dbBrowser(): DbBrowser {
    type Runner = { query(sql: string, params?: unknown[]): Promise<[unknown, unknown]> };
    const database = String(this.def.database ?? "");
    const needDb = (): string => {
      if (!database) {
        throw new Error("no database configured on this MySQL MCP — set its database field first");
      }
      return database;
    };
    const metaOf = async (run: Runner, db: string, table: string) => {
      const [colsRes, pkRes] = await Promise.all([
        run.query(MYSQL_BROWSE_COLUMNS_SQL, [db, table]),
        run.query(MYSQL_BROWSE_PK_SQL, [db, table]),
      ]);
      const colRows = (colsRes[0] ?? []) as Array<Record<string, unknown>>;
      if (!colRows.length) throw new Error(`no such table: ${db}.${table}`);
      const pk = ((pkRes[0] ?? []) as Array<{ column_name?: string }>).map((r) => String(r.column_name));
      return { columns: toBrowseColumns(colRows, pk), pk };
    };

    return {
      dialect: "mysql",
      readonly: this.readonly,
      label: this.target,
      listTables: async (o) => {
        const db = needDb();
        const pool = (await this.conn.get()) as unknown as Runner;
        const page = Math.max(0, Math.floor(Number(o.page) || 0));
        const limit = clampBrowseLimit(o.limit, BROWSE_TABLES_PAGE, BROWSE_TABLES_MAX);
        const q = mysqlListTables(db, o.grep ? String(o.grep) : undefined, { page, limit, offset: page * limit });
        const [listRes, countRes] = await Promise.all([
          pool.query(q.list.sql, q.list.params),
          pool.query(q.count.sql, q.count.params),
        ]);
        const tables = ((listRes[0] ?? []) as Array<Record<string, unknown>>).map((r): BrowseTableInfo => ({
          schema: db,
          name: String(r.name),
          type: String(r.type),
          // table_rows is an estimate (NULL for views) — keep NULL as unknown rather than 0.
          approxRows: r.approx_rows == null ? null : Number(r.approx_rows),
          size: humanBytes(Number(r.bytes ?? 0)),
        }));
        const total = Number((countRes[0] as Array<{ total?: number }> | undefined)?.[0]?.total ?? 0);
        return { tables, total, page, limit, more: page * limit + tables.length < total };
      },
      readTable: async (o) => {
        const db = needDb();
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns, pk } = await metaOf(pool, db, table);
        const offset = browseOffset(o.offset);
        const limit = browsePageSize(o.limit);
        const names = columns.map((c: BrowseColumn) => c.name);
        const order = browseOrder(names, o.order, o.dir, "mysql");
        const where = buildFilterWhere("mysql", names, o.filters ?? []);
        const rowsStmt = browseRowsSql("mysql", { schema: db, table }, names, order, offset, limit, where.frag, where.params);
        const cntStmt = browseCountSql("mysql", { schema: db, table }, where.frag, where.params);
        const [rowsRes, cntRes] = await Promise.all([
          pool.query(rowsStmt.sql, rowsStmt.params),
          pool.query(cntStmt.sql, cntStmt.params),
        ]);
        const total = Number((cntRes[0] as Array<{ total?: number }> | undefined)?.[0]?.total ?? 0);
        return {
          schema: db,
          table,
          columns,
          rows: (rowsRes[0] ?? []) as Array<Record<string, unknown>>,
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
        const db = needDb();
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns, pk } = await metaOf(pool, db, table);
        const [idxRes, fkRes, ddlRes] = await Promise.all([
          pool.query(MYSQL_BROWSE_INDEXES_SQL, [db, table]),
          pool.query(MYSQL_BROWSE_FK_SQL, [db, table]),
          // SHOW CREATE TABLE cannot bind its identifier; quoteIdent has vetted both parts.
          pool.query("SHOW CREATE TABLE " + qualified("mysql", { schema: db, table })),
        ]);
        const indexes = toBrowseIndexes(
          ((idxRes[0] ?? []) as Array<Record<string, unknown>>).map((r) => ({
            name: r.name,
            unique: r.unique0,
            primary: String(r.name) === "PRIMARY" ? 1 : 0,
            column: r.col,
          })),
        );
        const foreignKeys: BrowseForeignKey[] = ((fkRes[0] ?? []) as Array<Record<string, unknown>>).map((r) => ({
          name: String(r.name),
          column: String(r.col),
          refSchema: String(r.ref_schema ?? db),
          refTable: String(r.ref_table),
          refColumn: String(r.ref_column),
        }));
        // SHOW CREATE TABLE answers one row whose SECOND field is the DDL (the first is the name).
        const ddlRow = (ddlRes[0] as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
        const ddl = String(ddlRow["Create Table"] ?? Object.values(ddlRow)[1] ?? "");
        return { schema: db, table, columns, primaryKey: pk, indexes, foreignKeys, ddl };
      },
      applyEdits: async (o) => {
        if (this.readonly) throw new Error("refused: this MySQL MCP is configured readonly — editing is disabled");
        const db = needDb();
        const table = String(o.table ?? "");
        const edits = o.edits ?? [];
        if (!table) throw new Error("table is required");
        if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array");
        const pool = await this.conn.get();
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const run = conn as unknown as Runner;
          const { columns, pk } = await metaOf(run, db, table);
          const stmts = buildEditStatements("mysql", { schema: db, table }, edits, columns, pk);
          const results: BrowseEditResult[] = [];
          for (let i = 0; i < stmts.length; i++) {
            const [r] = await run.query(stmts[i].sql, stmts[i].params);
            const affected = Array.isArray(r)
              ? r.length
              : Number((r as { affectedRows?: number }).affectedRows ?? 0);
            results.push({ op: edits[i].op, affected });
          }
          await conn.commit();
          return { results };
        } catch (err) {
          try { await conn.rollback(); } catch { /* the connection is already broken */ }
          throw err;
        } finally {
          conn.release();
        }
      },
      exportTable: async (o) => {
        const db = needDb();
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const pool = (await this.conn.get()) as unknown as Runner;
        const { columns } = await metaOf(pool, db, table);
        const names = columns.map((c: BrowseColumn) => c.name);
        const cap = exportRowLimit(o.limit);
        const all: Array<Record<string, unknown>> = [];
        let capped = false;
        // Offset paging in chunks: simple, and the cap keeps the O(offset) tail-walk bounded.
        for (let offset = 0; offset < cap; offset += EXPORT_CHUNK) {
          const chunk = Math.min(EXPORT_CHUNK, cap - offset);
          const stmt = browseRowsSql("mysql", { schema: db, table }, names, null, offset, chunk);
          const [res] = await pool.query(stmt.sql, stmt.params);
          const rows = (res as Array<Record<string, unknown>>) ?? [];
          all.push(...rows);
          if (rows.length < chunk) break; // table exhausted before the cap
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
        if (this.readonly) throw new Error("refused: this MySQL MCP is configured readonly — import is disabled");
        const db = needDb();
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        if (o.lines.length > IMPORT_ROW_CAP) throw new Error(`too many rows for one import (max ${IMPORT_ROW_CAP})`);
        const rows = mapImportRows(o.header, o.lines, o.mapping);
        if (!rows.length) throw new Error("nothing to import after mapping — every row was empty or skipped");
        const edits = rows.map((values) => ({ op: "insert" as const, values }));
        const pool = await this.conn.get();
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const run = conn as unknown as Runner;
          const { columns } = await metaOf(run, db, table);
          const stmts = buildEditStatements("mysql", { schema: db, table }, edits, columns, []);
          for (const s of stmts) await run.query(s.sql, s.params);
          await conn.commit();
          return { inserted: rows.length };
        } catch (err) {
          try { await conn.rollback(); } catch { /* already broken */ }
          throw err;
        } finally {
          conn.release();
        }
      },
      ddlOp: async (o) => {
        if (this.readonly) throw new Error("refused: this MySQL MCP is configured readonly — structure operations are disabled");
        const db = needDb();
        const table = String(o.table ?? "");
        if (!table) throw new Error("table is required");
        const sql = buildDdlOpSql("mysql", o.op, { schema: db, table }, { to: o.to });
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
        const [rows, fields] = await pool.query(prepared.sql);
        const list = Array.isArray(rows) ? rows : [];
        const columns = list.length
          ? Object.keys(list[0] as object)
          : ((fields as Array<{ name?: string }> | undefined) ?? []).map((f) => String(f.name));
        return {
          columns,
          rows: list as Array<Record<string, unknown>>,
          rowCount: list.length,
          ...limitReport(prepared, list.length, limit),
        };
      },
    };
  }

  async ping(): Promise<void> {
    const pool = await this.conn.get();
    const [rows] = await pool.query("SELECT 1 AS ok");
    if (!pingOk(rows)) {
      throw new Error("mysql SELECT 1 returned no row");
    }
  }

  async close(): Promise<void> {
    await this.conn.take()?.end();
  }
}
