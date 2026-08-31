import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { buildApp } from "../src/router.js";
import { TokenManager } from "../src/token.js";
import { makeAdapter } from "../src/adapters/factory.js";
import type { Adapter } from "../src/adapters/types.js";
import { setCallLogDir } from "../src/calls.js";
import {
  BROWSE_DEFAULT_PAGE, BROWSE_PAGE_SIZES, browseCountSql, browseOffset, browseOrder, browsePageSize,
  browseRowsSql, buildEditStatements, buildFilterWhere, buildPgDdl, quoteIdent, toBrowseColumns,
  csvEscape, sqlLiteral, toBrowseIndexes, toInsertStatement, withExplain,
  EXPORT_CHUNK, EXPORT_ROW_CAP, exportRowLimit, toCsv, toJsonLines,
  parseCsvLine, mapImportRows, IMPORT_ROW_CAP, buildDdlOpSql, numericBindValue, clampBrowseLimit,
  type BrowseColumn, type BrowseDataPage, type BrowseEdit, type BrowseFilter, type BrowseForeignKey,
  type BrowseTableDetail, type BrowseTables, type DbBrowser,
} from "../src/dbbrowser.js";

import type { Server } from "@modelcontextprotocol/server";

import { setShutdownSignal } from "../src/adminapi.js";
import { LIST_TABLES_SQL, COUNT_TABLES_SQL, DESCRIBE_SQL, pgBrowseTableParams } from "../src/adapters/pg.js";
import { MYSQL_BROWSE_INDEXES_SQL, MYSQL_BROWSE_FK_SQL, MYSQL_BROWSE_COLUMNS_SQL } from "../src/adapters/mysql.js";

// The call log is on disk; keep this suite out of the repo's logs/ directory.
setCallLogDir(mkdtempSync(join(tmpdir(), "mcp-dbbrowse-")));
// The admin API mounts a shutdown route; make sure no test can reach the real signal.
setShutdownSignal(() => {});

// --- pure helpers -------------------------------------------------------------------------------

describe("browse paging clamps", () => {
  it("defaults to 50 and never exceeds 500", () => {
    expect(browsePageSize(undefined)).toBe(BROWSE_DEFAULT_PAGE);
    expect(browsePageSize("nonsense")).toBe(BROWSE_DEFAULT_PAGE);
    expect(browsePageSize(0)).toBe(BROWSE_DEFAULT_PAGE);
    expect(browsePageSize(-5)).toBe(BROWSE_DEFAULT_PAGE);
    expect(browsePageSize(100000)).toBe(500);
    expect(browsePageSize(10)).toBe(10);
  });

  it("offers exactly the sizes the panel ships", () => {
    expect([...BROWSE_PAGE_SIZES]).toEqual([10, 20, 50, 100, 200, 500]);
  });

  it("clamps offsets to non-negative integers", () => {
    expect(browseOffset(undefined)).toBe(0);
    expect(browseOffset(-3)).toBe(0);
    expect(browseOffset("40")).toBe(40);
  });
});

describe("identifier quoting", () => {
  it("quotes per dialect", () => {
    expect(quoteIdent("mysql", "users")).toBe("`users`");
    expect(quoteIdent("pg", "users")).toBe('"users"');
  });

  it("refuses anything that is not a plain identifier", () => {
    for (const bad of ["users; DROP TABLE x", "a`b", 'c"d', "with space", ""]) {
      expect(() => quoteIdent("mysql", bad)).toThrow();
      expect(() => quoteIdent("pg", bad)).toThrow();
    }
  });
});

describe("read paging SQL", () => {
  it("builds a bounded, ordered select for both dialects", () => {
    expect(browseRowsSql("mysql", { schema: "app", table: "users" }, ["id", "name"], "`id` DESC", 40, 20))
      .toEqual({ sql: "SELECT `id`, `name` FROM `app`.`users` ORDER BY `id` DESC LIMIT 20 OFFSET 40", params: [] });
    expect(browseRowsSql("pg", { schema: "public", table: "users" }, ["id"], null, 0, 500))
      .toEqual({ sql: 'SELECT "id" FROM "public"."users" LIMIT 500 OFFSET 0', params: [] });
    expect(browseCountSql("pg", { table: "t" }))
      .toEqual({ sql: 'SELECT COUNT(*) AS total FROM "t"', params: [] });
  });

  it("refuses to sort by an unknown column or in an unknown direction", () => {
    expect(() => browseOrder(["id"], "evil; --", "asc", "mysql")).toThrow(/unknown column/);
    expect(() => browseOrder(["id"], "id", "sideways", "pg")).toThrow(/asc or desc/);
    expect(browseOrder(["id"], "id", "desc", "mysql")).toBe("`id` DESC");
    expect(browseOrder(["id"], undefined, undefined, "mysql")).toBeNull();
  });
});

describe("field filters", () => {
  const NAMES = ["id", "name"];

  it("binds comparison values as parameters, numeric-looking text as numbers", () => {
    const out = buildFilterWhere("mysql", NAMES, [{ column: "id", op: "gte", value: "42" }]);
    expect(out).toEqual({ frag: " WHERE `id` >= ?", params: [42] });
    const pg = buildFilterWhere("pg", NAMES, [{ column: "name", op: "eq", value: "alice' --" }]);
    expect(pg).toEqual({ frag: ' WHERE "name" = $1', params: ["alice' --"] });
  });

  it("binds integers beyond Number.MAX_SAFE_INTEGER as strings so snowflake IDs stay exact", () => {
    const out = buildFilterWhere("mysql", NAMES, [{ column: "id", op: "eq", value: "1120230230635368448" }]);
    expect(out.params).toEqual(["1120230230635368448"]);
    const pg = buildFilterWhere("pg", NAMES, [{ column: "id", op: "eq", value: "9007199254740993" }]);
    expect(pg.params).toEqual(["9007199254740993"]);
    // The boundary itself stays a number, and decimals still bind as numbers.
    expect(buildFilterWhere("mysql", NAMES, [{ column: "id", op: "eq", value: "9007199254740991" }]).params).toEqual([9007199254740991]);
    expect(buildFilterWhere("mysql", NAMES, [{ column: "id", op: "eq", value: "3.14" }]).params).toEqual([3.14]);
  });

  it("stacks terms with AND and numbers $n across them", () => {
    const out = buildFilterWhere("pg", NAMES, [
      { column: "id", op: "lt", value: "10" },
      { column: "name", op: "ne", value: "bob" },
    ]);
    expect(out.frag).toBe(' WHERE "id" < $1 AND "name" <> $2');
    expect(out.params).toEqual([10, "bob"]);
  });

  it("contains/excludes escape the user's wildcards and match case-insensitively on pg", () => {
    const my = buildFilterWhere("mysql", NAMES, [{ column: "name", op: "like", value: "50%_off" }]);
    expect(my.frag).toBe(" WHERE `name` LIKE ? ESCAPE '!'");
    expect(my.params).toEqual(["%50!%!_off%"]);
    const pg = buildFilterWhere("pg", NAMES, [{ column: "name", op: "notLike", value: "x" }]);
    var q = String.fromCharCode(34); // double quote
    expect(pg.frag).toBe(' WHERE ' + q + 'name' + q + ' NOT ILIKE $1 ESCAPE ' + String.fromCharCode(39) + '!' + String.fromCharCode(39));
  });

  it("IS NULL / IS NOT NULL take no value and no parameter", () => {
    expect(buildFilterWhere("mysql", NAMES, [{ column: "name", op: "isNull" }]))
      .toEqual({ frag: " WHERE `name` IS NULL", params: [] });
    expect(buildFilterWhere("pg", NAMES, [{ column: "id", op: "isNotNull" }]))
      .toEqual({ frag: ' WHERE "id" IS NOT NULL', params: [] });
  });

  it("refuses unknown columns, unknown operators and missing values", () => {
    expect(() => buildFilterWhere("mysql", NAMES, [{ column: "evil; --", op: "eq", value: "1" }])).toThrow(/unknown column/);
    expect(() => buildFilterWhere("mysql", NAMES, [{ column: "id", op: "DROP", value: "1" } as never])).toThrow(/unknown filter operator/);
    expect(() => buildFilterWhere("mysql", NAMES, [{ column: "id", op: "eq" }])).toThrow(/needs a value/);
    expect(() => buildFilterWhere("mysql", NAMES, [{ column: "name", op: "like", value: "" }])).toThrow(/needs a value/);
  });

  it("an empty filter set is no WHERE at all", () => {
    expect(buildFilterWhere("mysql", NAMES, [])).toEqual({ frag: "", params: [] });
  });

  it("rides along inside the paged select and the count", () => {
    const w = buildFilterWhere("mysql", NAMES, [{ column: "id", op: "eq", value: "7" }]);
    const rows = browseRowsSql("mysql", { table: "users" }, NAMES, null, 0, 50, w.frag, w.params);
    expect(rows).toEqual({ sql: "SELECT `id`, `name` FROM `users` WHERE `id` = ? LIMIT 50 OFFSET 0", params: [7] });
    expect(browseCountSql("mysql", { table: "users" }, w.frag, w.params))
      .toEqual({ sql: "SELECT COUNT(*) AS total FROM `users` WHERE `id` = ?", params: [7] });
  });
});

const COLS: BrowseColumn[] = [
  { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
  { name: "name", dataType: "varchar", nullable: true, isPrimaryKey: false },
];

describe("edit statement building", () => {
  it("binds updates by the full primary key", () => {
    const edits: BrowseEdit[] = [{ op: "update", pk: { id: 7 }, changes: { name: "alice" } }];
    expect(buildEditStatements("mysql", { schema: "app", table: "users" }, edits, COLS, ["id"]))
      .toEqual([{ sql: "UPDATE `app`.`users` SET `name` = ? WHERE `id` = ?", params: ["alice", 7] }]);
    expect(buildEditStatements("pg", { schema: "public", table: "users" }, edits, COLS, ["id"]))
      .toEqual([{ sql: 'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2', params: ["alice", 7] }]);
  });

  it("builds inserts and deletes with bound values", () => {
    const out = buildEditStatements("mysql", { table: "users" }, [
      { op: "insert", values: { id: 9, name: "bob" } },
      { op: "delete", pk: { id: 3 } },
    ], COLS, ["id"]);
    expect(out[0].sql).toBe("INSERT INTO `users` (`id`, `name`) VALUES (?, ?)");
    expect(out[0].params).toEqual([9, "bob"]);
    expect(out[1].sql).toBe("DELETE FROM `users` WHERE `id` = ?");
    expect(out[1].params).toEqual([3]);
  });

  it("drops unknown columns, and errors when nothing is left to do", () => {
    const out = buildEditStatements("pg", { table: "users" }, [
      { op: "update", pk: { id: 1 }, changes: { name: "x", ghost: "y" } },
    ], COLS, ["id"]);
    expect(out[0].sql).not.toContain("ghost");
    expect(() => buildEditStatements("mysql", { table: "u" }, [
      { op: "update", pk: { id: 1 }, changes: { ghost: "y" } },
    ], COLS, ["id"])).toThrow(/no column/);
  });

  it("refuses row edits on a table without a primary key, or with an incomplete key", () => {
    expect(() => buildEditStatements("mysql", { table: "u" }, [
      { op: "delete", pk: {} },
    ], COLS, [])).toThrow(/no primary key/);
    expect(() => buildEditStatements("mysql", { table: "u" }, [
      { op: "delete", pk: { name: "x" } },
    ], COLS, ["id"])).toThrow(/primary-key column id/);
  });
});

describe("toBrowseColumns", () => {
  it("marks PK membership and nullability", () => {
    const cols = toBrowseColumns([
      { column_name: "id", data_type: "int", is_nullable: "NO", column_default: null },
      { column_name: "name", data_type: "text", is_nullable: "YES", column_default: "''" },
    ], ["id"]);
    expect(cols[0]).toMatchObject({ name: "id", nullable: false, isPrimaryKey: true });
    expect(cols[1]).toMatchObject({ name: "name", nullable: true, isPrimaryKey: false, defaultValue: "''" });
  });

  it("carries the column comment through, treating blank or missing as none", () => {
    const cols = toBrowseColumns([
      { column_name: "id", data_type: "bigint", is_nullable: "NO", column_default: null,
        column_comment: "Snowflake-style row ID" },
      { column_name: "name", data_type: "text", is_nullable: "YES", column_default: null,
        column_comment: "" },
      { column_name: "note", data_type: "text", is_nullable: "YES", column_default: null },
    ], ["id"]);
    expect(cols[0].comment).toBe("Snowflake-style row ID");
    expect(cols[1].comment).toBeNull();
    expect(cols[2].comment).toBeNull();
  });
});

// --- adapter wiring (no live database needed) ----------------------------------------------------

describe("pg table-list statement wiring", () => {
  // Regression: the Data view's listTables once passed [grep] alone against a statement with
  // $1..$4, and Postgres refused every page with "bind message supplies N parameters, but
  // prepared statement requires N+1". The invariant is checked textually: every $n placeholder
  // in the statement must be supplied by params + limit/offset.
  const placeholders = (sql: string): number =>
    Math.max(...(sql.match(/\$(\d+)/g) ?? ["$0"]).map((p) => Number(p.slice(1))));

  it("supplies every placeholder in LIST_TABLES_SQL", () => {
    expect(pgBrowseTableParams()).toHaveLength(2);
    expect(pgBrowseTableParams("us")).toEqual([null, "%us%"]);
    const limit = 200, offset = 0;
    expect(placeholders(LIST_TABLES_SQL)).toBe(pgBrowseTableParams("us").length + 2);
    expect(placeholders(COUNT_TABLES_SQL)).toBe(pgBrowseTableParams("us").length);
  });
});

describe("structure detail shaping", () => {
  it("folds per-column index rows into one index per name", () => {
    const idx = toBrowseIndexes([
      { name: "PRIMARY", unique: 0, primary: 1, column: "id" },
      { name: "name_idx", unique: 1, primary: 0, column: "name" },
      { name: "name_idx", unique: 1, primary: 0, column: "email" },
    ]);
    expect(idx).toHaveLength(2);
    const pk = idx.find((i) => i.name === "PRIMARY");
    expect(pk).toMatchObject({ unique: true, primary: true, columns: ["id"] });
    const other = idx.find((i) => i.name === "name_idx");
    expect(other).toMatchObject({ unique: false, primary: false, columns: ["name", "email"] });
  });

  it("synthesizes a readable pg DDL from the catalog pieces", () => {
    const cols: BrowseColumn[] = [
      { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
      { name: "email", dataType: "text", nullable: false, isPrimaryKey: false, defaultValue: "''::text" },
      { name: "note", dataType: "text", nullable: true, isPrimaryKey: false },
    ];
    const fks: BrowseForeignKey[] = [{
      name: "owner_fk", column: "id", refSchema: "public", refTable: "users", refColumn: "id",
    }];
    const ddl = buildPgDdl({ schema: "public", table: "things" }, cols, ["id"], fks);
    expect(ddl).toContain('CREATE TABLE "public"."things"');
    expect(ddl).toContain('"id" bigint NOT NULL');
    expect(ddl).toContain('"email" text NOT NULL DEFAULT \'\'::text');
    expect(ddl).toContain('"note" text');
    expect(ddl).toContain('PRIMARY KEY ("id")');
    expect(ddl).toContain('FOREIGN KEY ("id") REFERENCES "public"."users" ("id")');
  });

  it("omits the PK and FK clauses when there are none", () => {
    const ddl = buildPgDdl({ schema: "s", table: "t" },
      [{ name: "x", dataType: "int", nullable: true, isPrimaryKey: false }], []);
    expect(ddl).not.toContain("PRIMARY KEY");
    expect(ddl).not.toContain("FOREIGN KEY");
  });
});

// Regression: COLUMN is a reserved word in MySQL 8 — an alias spelled "column" once made every
// schema-tab query die with a syntax error near 'column'. Aliases must stay non-reserved.
describe("mysql browse statement aliases", () => {
  it("never aliases a select expression to the reserved word column", () => {
    for (const sql of [MYSQL_BROWSE_INDEXES_SQL, MYSQL_BROWSE_FK_SQL]) {
      expect(sql).not.toMatch(/AS\s+column\b/i);
    }
    expect(MYSQL_BROWSE_INDEXES_SQL).toMatch(/AS col\b/);
    expect(MYSQL_BROWSE_FK_SQL).toMatch(/AS col\b/);
  });
});

// The Data view's header tooltip shows the column COMMENT ("what this field means"), so the
// column queries behind it must fetch it — and the pg one must do so without growing the bind
// list its callers supply, or every describe would die on a placeholder-count mismatch.
describe("column comment wiring", () => {
  it("mysql selects column_comment under its lowercase alias", () => {
    expect(MYSQL_BROWSE_COLUMNS_SQL).toMatch(/column_comment\s+AS\s+column_comment/i);
  });

  it("pg computes column_comment in the select list, adding no placeholders", () => {
    expect(DESCRIBE_SQL).toMatch(/col_description\(/i);
    expect(DESCRIBE_SQL).toMatch(/AS\s+column_comment/i);
    const ns = [...DESCRIBE_SQL.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ns)).toBe(2); // callers still bind exactly [schema, table]
  });
});

describe("withExplain", () => {
  it("prefixes a plain statement once", () => {
    expect(withExplain("SELECT * FROM t")).toBe("EXPLAIN SELECT * FROM t");
    expect(withExplain("select 1")).toBe("EXPLAIN select 1");
  });

  it("is idempotent and strips the trailing terminator", () => {
    expect(withExplain("EXPLAIN SELECT 1")).toBe("EXPLAIN SELECT 1");
    expect(withExplain("explain select 1;")).toBe("explain select 1");
    expect(withExplain("SELECT 1;\n")).toBe("EXPLAIN SELECT 1");
  });
});

describe("copy-out helpers", () => {
  it("escapes CSV cells per RFC 4180", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape("plain")).toBe(String.fromCharCode(34) + "plain" + String.fromCharCode(34));
    expect(csvEscape('say "hi"')).toBe(String.fromCharCode(34) + 'say ""hi""' + String.fromCharCode(34));
    expect(csvEscape("a,b\nline2")).toBe(String.fromCharCode(34) + "a,b\nline2" + String.fromCharCode(34));
    // an object becomes compact JSON, whose quotes double like any other quote inside the cell
    expect(csvEscape({ x: 1 })).toBe(String.fromCharCode(34) + '{""x"":1}' + String.fromCharCode(34));
  });

  it("renders SQL literals for the clipboard", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(true)).toBe("true");
    const q = String.fromCharCode(39);
    expect(sqlLiteral("it" + q + "s")).toBe(q + "it" + q + q + "s" + q);
  });

  it("builds an INSERT matching the edit builders quoting rules", () => {
    const out = toInsertStatement("mysql", { schema: "app", table: "users" }, ["id", "name", "ghost"],
      { id: 1, name: "alice", ghost: undefined });
    expect(out).toBe("INSERT INTO `app`.`users` (`id`, `name`) VALUES (1, 'alice');");
    const pg = toInsertStatement("pg", { table: "t" }, ["a"], { a: null });
    expect(pg).toBe('INSERT INTO "t" ("a") VALUES (NULL);');
  });
});

describe("export helpers", () => {
  it("clamps the row cap", () => {
    expect(EXPORT_ROW_CAP).toBe(100_000);
    expect(exportRowLimit(undefined)).toBe(EXPORT_ROW_CAP);
    expect(exportRowLimit(500)).toBe(500);
    expect(exportRowLimit(999_999_999)).toBe(EXPORT_ROW_CAP);
  });

  it("builds CSV with a header and RFC 4180 quoting", () => {
    const q = String.fromCharCode(34);
    const csv = toCsv(["id", "name"], [{ id: 1, name: 'a,b"' }, { id: null, name: null }]);
    // every cell is quoted uniformly (numbers included) — simplest RFC-legal shape
    expect(csv.split("\r\n")).toEqual([q + "id" + q + "," + q + "name" + q, q + "1" + q + "," + q + 'a,b""' + q, ","]);
  });

  it("builds newline-delimited JSON", () => {
    const out = toJsonLines([{ a: 1 }, { b: null }]);
    expect(out.split("\n")).toEqual(['{"a":1}', '{"b":null}']);
  });
});

describe("CSV import helpers", () => {
  it("parses an RFC 4180 line: doubled quotes, embedded commas", () => {
    expect(parseCsvLine('a,"b,c","say ""hi"""')).toEqual(["a", "b,c", 'say "hi"']);
    expect(parseCsvLine("plain,cells")).toEqual(["plain", "cells"]);
  });

  it("maps rows through the mapping, coercing numbers and dropping empty rows", () => {
    const rows = mapImportRows(["id", "name", "note"], ["1,alice,x", '"2","bob",', ",,"], ["id", "name", null]);
    expect(rows).toEqual([{ id: 1, name: "alice" }, { id: 2, name: "bob" }]);
  });

  it("refuses a mapping that does not cover the header", () => {
    expect(() => mapImportRows(["a"], ["1"], [])).toThrow(/covers/);
  });
});

describe("structure operation statements", () => {
  it("builds dialect-correct rename/truncate/drop", () => {
    expect(buildDdlOpSql("mysql", "rename", { schema: "app", table: "users" }, { to: "members" }))
      .toBe("RENAME TABLE `app`.`users` TO `app`.`members`");
    expect(buildDdlOpSql("pg", "rename", { schema: "public", table: "users" }, { to: "members" }))
      .toBe('ALTER TABLE "public"."users" RENAME TO "members"');
    expect(buildDdlOpSql("mysql", "truncate", { table: "users" })).toBe("TRUNCATE TABLE `users`");
    expect(buildDdlOpSql("pg", "drop", { schema: "s", table: "t" })).toBe('DROP TABLE "s"."t"');
  });

  it("refuses a rename without a target and an unknown op", () => {
    expect(() => buildDdlOpSql("mysql", "rename", { table: "a" })).toThrow(/new table name/);
    expect(() => buildDdlOpSql("mysql", "explode" as never, { table: "a" })).toThrow(/unknown structure operation/);
  });
});

describe("adapter wiring", () => {
  it("mysql and pg adapters expose a browser that reports its dialect and target", () => {
    const mysql = makeAdapter({ type: "mysql", host: "127.0.0.1", database: "app" }, "m");
    const b = mysql.dbBrowser?.();
    expect(b?.dialect).toBe("mysql");
    expect(b?.label).toContain("app @");
    expect(b?.readonly).toBe(false);

    const pg = makeAdapter({ type: "pg", url: "postgres://u:pw@127.0.0.1:5432/app" }, "p");
    expect(pg.dbBrowser?.().dialect).toBe("pg");
  });

  it("carries readonly through to the browser", () => {
    const a = makeAdapter({ type: "pg", url: "postgres://u:pw@127.0.0.1:5432/app", readonly: true }, "p");
    expect(a.dbBrowser?.().readonly).toBe(true);
  });

  it("refuses to list tables when the MySQL MCP has no database configured", async () => {
    const a = makeAdapter({ type: "mysql", host: "127.0.0.1" }, "m");
    await expect(a.dbBrowser!().listTables({})).rejects.toThrow(/no database configured/);
  });
});

// --- HTTP API (a fake adapter standing in for a live database) -----------------------------------

const stubColumns: BrowseColumn[] = [
  { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
  { name: "name", dataType: "text", nullable: true, isPrimaryKey: false },
];

/** A DbBrowser over the real builders with an in-memory table, so the routes and the payload
 *  contract are tested end-to-end without a live MySQL/Postgres. */
function stubBrowser(seen: { edits?: unknown; query?: string; filters?: unknown; imported?: unknown; ddl?: unknown }): DbBrowser {
  return {
    dialect: "mysql",
    readonly: false,
    label: "stub @ localhost",
    async listTables(o): Promise<BrowseTables> {
      return { tables: [{ schema: "app", name: "users", type: "table", approxRows: 12, size: "16 KB" }],
              total: 1, page: Number(o.page) || 0, limit: 200, more: false };
    },
    async describeTable(o): Promise<BrowseTableDetail> {
      return {
        schema: "app",
        table: String(o.table),
        columns: stubColumns,
        primaryKey: ["id"],
        indexes: [{ name: "PRIMARY", unique: true, primary: true, columns: ["id"] }],
        foreignKeys: [],
        ddl: "CREATE TABLE stub",
      };
    },
    async ddlOp(o) {
      seen.ddl = o;
      if (o.op === "rename" && !o.to) throw new Error("rename needs the new table name");
      return { ran: "stub " + o.op };
    },
    async importTable(o) {
      seen.imported = { header: o.header, lines: o.lines, mapping: o.mapping };
      return { inserted: mapImportRows(o.header, o.lines, o.mapping).length };
    },
    async exportTable(o) {
      return {
        format: o.format === "json" ? "json" : "csv",
        columns: stubColumns.map((c) => c.name),
        rows: 2,
        capped: false,
        body: o.format === "json" ? '{"id":1}\n{"id":2}' : "id,name\r\n1,a",
      };
    },
    async readTable(o): Promise<BrowseDataPage> {
      seen.filters = o.filters;
      const limit = browsePageSize(o.limit);
      const offset = browseOffset(o.offset);
      return {
        schema: "app", table: String(o.table), columns: stubColumns,
        rows: [{ id: offset + 1, name: "a" }, { id: offset + 2, name: null }].slice(0, limit),
        total: 2, offset, limit, primaryKey: ["id"], editable: true,
      };
    },
    async applyEdits(o) {
      seen.edits = o.edits;
      return { results: o.edits.map((e) => ({ op: e.op, affected: 1 })) };
    },
    async runQuery(sql) {
      seen.query = sql;
      return { columns: ["id"], rows: [{ id: 1 }], rowCount: 1 };
    },
  };
}

function fakeAdapter(browser?: DbBrowser): Adapter {
  return {
    type: "mysql",
    build: async () => { throw new Error("not used in this suite"); },
    ...(browser ? { dbBrowser: () => browser } : {}),
  } as Adapter & { build(): Promise<Server> };
}

const registries: Registry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((r) => r.closeAll()));
});

function setup() {
  const path = join(tmpdir(), `mcp-dbbrowse-api-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const registry = new Registry(60000);
  const store = new ManagedStore(path);
  registries.push(registry);
  const app = buildApp(registry, new TokenManager(store, "t"), store);
  return { registry, app };
}

describe("data browser API", () => {
  it("runs a read-only redis command through the console route", async () => {
    const { registry, app } = setup();
    const fakeRedis = {
      type: "redis",
      build: async () => { throw new Error("not used"); },
      redisBrowser: () => ({
        readonly: false,
        label: "r",
        listKeys: async () => ({ keys: [], cursor: "0", done: true }),
        readKey: async () => ({}),
        runCommand: async (line: string) => line.toUpperCase().startsWith("GET") ? "value" : ["a", "b"],
      }),
    } as never;
    registry.register("rdb", "config", { type: "redis" }, fakeRedis);
    const ok = await request(app).post("/api/db/rdb/command").send({ command: "GET mykey" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ reply: "value" });
    const arr = await request(app).post("/api/db/rdb/command").send({ command: "LRANGE mylist 0 -1" });
    expect(arr.body.reply).toEqual(["a", "b"]);
    const empty = await request(app).post("/api/db/rdb/command").send({ command: "  " });
    expect(empty.status).toBe(400);
  });
  it("lists mongo connections with dialect mongo, and serves collections + docs", async () => {
    const { registry, app } = setup();
    const fakeMongo = {
      type: "mongo",
      build: async () => { throw new Error("not used"); },
      mongoBrowser: () => ({
        readonly: false,
        label: "app @ localhost:27017",
        listCollections: async (o: { grep?: string }) => [
          { name: "users", type: "collection", approxDocs: 12, size: "4 KB" },
          ...(o.grep ? [] : [{ name: "events", type: "collection", approxDocs: 9000, size: "1.2 MB" }]),
        ],
        readCollection: async (o: { collection: string; filterJson?: string }) => ({
          collection: o.collection,
          documents: [{ _id: 1, name: "a" }, { _id: 2, name: "b" }],
          total: 2,
          offset: 0,
          limit: 50,
          fields: ["_id", "name"],
        }),
      }),
    } as never;
    registry.register("mgo", "config", { type: "mongo" }, fakeMongo);
    const conns = await request(app).get("/api/db");
    const row = conns.body.connections.find((c: { name: string }) => c.name === "mgo");
    expect(row).toMatchObject({ dialect: "mongo", editable: false });

    const cols = await request(app).get("/api/db/mgo/collections?grep=user");
    expect(cols.status).toBe(200);
    expect(cols.body.collections).toHaveLength(1);
    expect(cols.body.collections[0]).toMatchObject({ name: "users", approxDocs: 12 });

    const docs = await request(app).get("/api/db/mgo/docs?collection=users&limit=50");
    expect(docs.status).toBe(200);
    expect(docs.body).toMatchObject({ collection: "users", total: 2 });
    expect(docs.body.fields).toEqual(["_id", "name"]);

    const tables = await request(app).get("/api/db/mgo/tables");
    expect(tables.status).toBe(404); // SQL-only route refuses a mongo connection
  });
  it("lists redis connections with dialect redis and editable false, and serves keys + key reads", async () => {
    const { registry, app } = setup();
    const fakeRedis = {
      type: "redis",
      build: async () => { throw new Error("not used"); },
      redisBrowser: () => ({
        readonly: false,
        label: "cache @ localhost:6379 db 0",
        listTables: undefined,
        listKeys: async (o: { pattern?: string; cursor?: string; count?: unknown; type?: string }) => ({
          keys: [{ key: "session:1", type: "string", ttl: -1 }, { key: "h:1", type: "hash", ttl: 60 }],
          cursor: "42",
          done: false,
          total: 2,
        }),
        readKey: async (key: string) => ({ key, type: "string", ttl: -1, value: "hello" }),
      }),
    } as never;
    registry.register("cache", "config", { type: "redis" }, fakeRedis);
    const conns = await request(app).get("/api/db");
    const row = conns.body.connections.find((c: { name: string }) => c.name === "cache");
    expect(row).toMatchObject({ dialect: "redis", editable: false, label: "cache @ localhost:6379 db 0" });

    const keys = await request(app).get("/api/db/cache/keys?pattern=session:*");
    expect(keys.status).toBe(200);
    expect(keys.body).toMatchObject({ cursor: "42", done: false, total: 2 });
    expect(keys.body.keys[0]).toEqual({ key: "session:1", type: "string", ttl: -1 });

    const key = await request(app).get("/api/db/cache/key?key=session:1");
    expect(key.status).toBe(200);
    expect(key.body).toEqual({ key: "session:1", type: "string", ttl: -1, value: "hello" });

    const noKey = await request(app).get("/api/db/cache/key");
    expect(noKey.status).toBe(400);
    // SQL-only routes 404 on a redis connection rather than half-working
    const tables = await request(app).get("/api/db/cache/tables");
    expect(tables.status).toBe(404);
  });
  it("lists only MCPs that have something to browse", async () => {
    const { registry, app } = setup();
    registry.register("db-one", "config", { type: "mysql" }, fakeAdapter(stubBrowser({})));
    registry.register("plain", "config", { type: "echo" }, fakeAdapter());
    const res = await request(app).get("/api/db");
    expect(res.status).toBe(200);
    expect(res.body.connections.map((c: { name: string }) => c.name)).toEqual(["db-one"]);
    expect(res.body.connections[0]).toMatchObject({ dialect: "mysql", label: "stub @ localhost" });
  });

  it("404s for an unknown MCP and a non-browsable MCP alike", async () => {
    const { registry, app } = setup();
    registry.register("plain", "config", { type: "echo" }, fakeAdapter());
    expect((await request(app).get("/api/db/nope/tables")).status).toBe(404);
    expect((await request(app).get("/api/db/plain/tables")).status).toBe(404);
  });

  it("serves a paged table list and a paged row page", async () => {
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser({})));
    const tables = await request(app).get("/api/db/db/tables?page=0&grep=us");
    expect(tables.status).toBe(200);
    expect(tables.body).toMatchObject({ total: 1, more: false });
    expect(tables.body.tables[0]).toMatchObject({ schema: "app", name: "users", approxRows: 12 });

    const data = await request(app).get("/api/db/db/data?table=users&limit=20&offset=0&order=id&dir=desc");
    expect(data.status).toBe(200);
    expect(data.body).toMatchObject({ table: "users", total: 2, primaryKey: ["id"], editable: true });
    expect(data.body.columns.map((c: BrowseColumn) => c.name)).toEqual(["id", "name"]);
  });

  it("forwards field filters as JSON and rejects malformed ones", async () => {
    const seen: { filters?: unknown } = {};
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser(seen)));
    const terms = JSON.stringify([{ column: "name", op: "like", value: "al" }]);
    const ok = await request(app).get("/api/db/db/data?table=users&filters=" + encodeURIComponent(terms));
    expect(ok.status).toBe(200);
    expect(seen.filters).toEqual([{ column: "name", op: "like", value: "al" }]);

    const bad = await request(app).get("/api/db/db/data?table=users&filters=not-json");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/JSON array/);
    const notArray = await request(app).get("/api/db/db/data?table=users&filters=%7B%7D"); // {}
    expect(notArray.status).toBe(400);
  });
  it("serves the structure detail for a table", async () => {
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser({})));
    const res = await request(app).get("/api/db/db/schema?table=users");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: "app", table: "users", primaryKey: ["id"], ddl: "CREATE TABLE stub" });
    expect(res.body.columns.map((c: BrowseColumn) => c.name)).toEqual(["id", "name"]);
    expect(res.body.indexes[0]).toMatchObject({ name: "PRIMARY", unique: true, columns: ["id"] });
  });
  it("streams a whole-table export with download headers", async () => {
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser({})));
    const csv = await request(app).get("/api/db/db/export?table=users&format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain('filename="csv-users"');
    expect(csv.headers["x-export-rows"]).toBe("2");
    expect(csv.text).toContain("id,name");
    const json = await request(app).get("/api/db/db/export?table=users&format=json");
    expect(json.headers["content-type"]).toContain("application/x-ndjson");
    expect(json.text.split("\n")).toHaveLength(2);
  });
  it("imports CSV rows through the mapping and rejects malformed payloads", async () => {
    const seen: { imported?: unknown } = {};
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser(seen)));
    const ok = await request(app).post("/api/db/db/import").send({
      table: "users",
      header: ["id", "name"],
      lines: ["1,alice", "2,bob"],
      mapping: ["id", "name"],
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ inserted: 2 });
    expect(seen.imported).toMatchObject({ mapping: ["id", "name"] });

    const bad = await request(app).post("/api/db/db/import").send({ table: "users", header: [], lines: [], mapping: [] });
    expect(bad.status).toBe(400);
    const noMapping = await request(app).post("/api/db/db/import").send({ table: "users", header: ["a"], lines: ["1"], mapping: [] });
    expect(noMapping.status).toBe(400);
    expect(noMapping.body.error).toMatch(/mapping/);
  });
  it("runs structure operations through the route and rejects unknown ops", async () => {
    const seen: { ddl?: unknown } = {};
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser(seen)));
    const ok = await request(app).post("/api/db/db/ddl").send({ op: "truncate", table: "users" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ran: "stub truncate" });
    expect(seen.ddl).toEqual({ op: "truncate", table: "users" });

    const bad = await request(app).post("/api/db/db/ddl").send({ op: "explode", table: "users" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/rename, truncate or drop/);
  });

  it("forwards an edit batch and rejects an empty one", async () => {
    const seen: { edits?: unknown } = {};
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser(seen)));
    const bad = await request(app).post("/api/db/db/edits").send({ table: "users", edits: [] });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/api/db/db/edits").send({
      table: "users",
      edits: [{ op: "update", pk: { id: 1 }, changes: { name: "x" } }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toEqual([{ op: "update", affected: 1 }]);
    expect(seen.edits).toEqual([{ op: "update", pk: { id: 1 }, changes: { name: "x" } }]);
  });

  it("runs the read-only SQL console through the browser", async () => {
    const seen: { query?: string } = {};
    const { registry, app } = setup();
    registry.register("db", "config", { type: "mysql" }, fakeAdapter(stubBrowser(seen)));
    const res = await request(app).post("/api/db/db/query").send({ sql: "SELECT 1", limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rowCount: 1 });
    expect(seen.query).toBe("SELECT 1");
  });
});

describe("numericBindValue (lossless numeric binding, shared by filters and import)", () => {
  it("binds safe integers as numbers and keeps snowflake ids as exact strings", () => {
    expect(numericBindValue("42")).toBe(42);
    expect(numericBindValue("-7")).toBe(-7);
    // 734023681584275456 does not fit a JS double: Number() would round it to …500.
    expect(numericBindValue("734023681584275456")).toBe("734023681584275456");
  });

  it("binds a decimal only when it round-trips exactly", () => {
    expect(numericBindValue("3.14")).toBe(3.14);
    expect(numericBindValue("1.10")).toBe("1.10"); // String(1.1) !== "1.10" — trailing zero matters
    expect(numericBindValue("0.100000000000000009")).toBe("0.100000000000000009"); // beyond double precision
  });

  it("passes non-numeric text through untouched", () => {
    expect(numericBindValue("abc")).toBe("abc");
    expect(numericBindValue("")).toBe("");
    expect(numericBindValue("12px")).toBe("12px");
  });
});

describe("mapImportRows precision (the CSV import must not round snowflake ids)", () => {
  const header = ["id", "qty", "note"];
  const mapping = ["id", "qty", "note"];

  it("keeps an 18-digit id an exact string and small numbers as numbers", () => {
    const rows = mapImportRows(header, ["734023681584275456,3,hello"], mapping);
    expect(rows).toEqual([{ id: "734023681584275456", qty: 3, note: "hello" }]);
  });

  it("keeps a beyond-double-precision decimal exact too", () => {
    const rows = mapImportRows(header, ["734023681584275456,0.100000000000000009,x"], mapping);
    expect(rows[0].qty).toBe("0.100000000000000009");
  });
});

describe("buildFilterWhere contains on typed columns", () => {
  const cols: BrowseColumn[] = [
    { name: "name", dataType: "character varying", nullable: true, isPrimaryKey: false },
    { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
    { name: "created", dataType: "timestamp without time zone", nullable: true, isPrimaryKey: false },
  ];

  it("casts non-text columns to text on Postgres (integer ~~ text is error 42883)", () => {
    const pg = buildFilterWhere("pg", cols, [{ column: "id", op: "like", value: "45" }]);
    expect(pg.frag).toContain('CAST("id" AS text) ILIKE');
    const ts = buildFilterWhere("pg", cols, [{ column: "created", op: "like", value: "2024" }]);
    expect(ts.frag).toContain('CAST("created" AS text) ILIKE');
  });

  it("leaves text columns bare on Postgres and everything bare on MySQL", () => {
    const bare = buildFilterWhere("pg", cols, [{ column: "name", op: "like", value: "al" }]);
    expect(bare.frag).toContain('"name" ILIKE');
    const my = buildFilterWhere("mysql", cols, [{ column: "id", op: "like", value: "45" }]);
    expect(my.frag).toContain("`id` LIKE");
    expect(my.frag).not.toContain("CAST");
  });

  it("still works with bare column names (no type info, no cast)", () => {
    const r = buildFilterWhere("pg", ["name", "id"], [{ column: "id", op: "like", value: "4" }]);
    expect(r.frag).toContain('"id" ILIKE');
  });
});

describe("clampBrowseLimit (the one table-list page clamp)", () => {
  it("falls back, clamps and rejects nonsense", () => {
    expect(clampBrowseLimit(undefined, 200, 1000)).toBe(200);
    expect(clampBrowseLimit(50, 200, 1000)).toBe(50);
    expect(clampBrowseLimit(99999, 200, 1000)).toBe(1000);
    expect(clampBrowseLimit("12", 200, 1000)).toBe(12);
    expect(clampBrowseLimit(0, 200, 1000)).toBe(200);
    expect(clampBrowseLimit("x", 200, 1000)).toBe(200);
  });
});
