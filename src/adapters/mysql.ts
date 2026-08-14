import type { Pool } from "mysql2/promise";
import { DirectAdapter, Lazy } from "./direct.js";
import type { ToolDef } from "./tool-server.js";
import {
  assertReadOnly, clampRowLimit, dropNullColumns, limitReport, withRowLimit,
  DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT,
} from "./sql.js";
import { mysqlResources } from "./mysql-resources.js";
import type { ResourceProvider } from "./resources.js";

/**
 * One tool, matching the single-tool MySQL MCP this replaced.
 *
 * No discovery tools here, unlike the Postgres adapter: MySQL's introspection is already a one-liner
 * every model knows (`SHOW TABLES`, `DESCRIBE t`, `SHOW INDEX FROM t`, `EXPLAIN`), so a wrapper would
 * add a schema to every request and teach the model nothing. Postgres keeps its two, because the
 * equivalent there is a pg_class/pg_namespace join — `\dt+` is a psql feature, not SQL.
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
];

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
    const pool = mysql.createPool({
      host: String(this.def.host ?? "localhost"),
      port: Number(this.def.port ?? 3306),
      user: String(this.def.user ?? ""),
      password: String(this.def.password ?? ""),
      database: this.def.database ? String(this.def.database) : undefined,
      timezone: String(this.def.timezone ?? "Z"),
      connectionLimit: 5, // a handful of local clients, not a web app
      queueLimit: 20, // bound the backlog instead of growing it without limit
      connectTimeout: 5000,
      dateStrings: true, // keep DATE/DATETIME as strings (avoids TZ surprises)
    });
    // Per-connection session setup. `max_execution_time` caps runaway SELECTs server-side (mysql2
    // has no per-query timeout), and the read-only transaction default is the real guard behind the
    // statement-shape check — MySQL refuses writes outright.
    const session = [`SET SESSION max_execution_time = 15000`];
    if (this.readonly) session.push("SET SESSION TRANSACTION READ ONLY");
    pool.on("connection", (conn: { query: (sql: string) => unknown }) => {
      for (const sql of session) {
        try {
          void (conn.query(sql) as Promise<unknown>)?.catch?.(() => { /* older servers may not know it */ });
        } catch { /* ignore */ }
      }
    });
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
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  async ping(): Promise<void> {
    const pool = await this.conn.get();
    const [rows] = await pool.query("SELECT 1 AS ok");
    if (!Array.isArray(rows) || (rows[0] as { ok?: number }).ok !== 1) {
      throw new Error("mysql SELECT 1 returned no row");
    }
  }

  async close(): Promise<void> {
    await this.conn.take()?.end();
  }
}
