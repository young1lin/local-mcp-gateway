import { describe, it, expect } from "vitest";
import {
  isReadOnlySql, assertReadOnly, withRowLimit, clampRowLimit, dropNullColumns, limitReport,
  DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT,
} from "../src/adapters/sql.js";

describe("isReadOnlySql", () => {
  it("accepts plain reads", () => {
    for (const sql of [
      "SELECT 1",
      "  select * from users where id = 3",
      "SHOW TABLES",
      "DESCRIBE users",
      "TABLE users",
      "VALUES (1)",
      "EXPLAIN SELECT * FROM users",
      "WITH recent AS (SELECT * FROM posts) SELECT * FROM recent",
      "-- a leading comment\nSELECT 1",
      "/* block */ SELECT 1",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(true);
    }
  });

  it("rejects writes, including ones disguised as reads", () => {
    for (const sql of [
      "INSERT INTO users VALUES (1)",
      "update users set name = 'x'",
      "DELETE FROM users",
      "DROP TABLE users",
      "TRUNCATE users",
      "ALTER TABLE users ADD c int",
      "WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone",
      "EXPLAIN ANALYZE INSERT INTO users VALUES (1)",
      "",
      "-- only a comment",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });

  it("assertReadOnly names the MCP kind in its error", () => {
    expect(() => assertReadOnly("DELETE FROM users", "Postgres")).toThrow(/Postgres MCP is configured readonly/);
    expect(() => assertReadOnly("SELECT 1", "Postgres")).not.toThrow();
  });
});

describe("withRowLimit", () => {
  it("adds a limit to a bare SELECT", () => {
    const r = withRowLimit("SELECT * FROM users");
    expect(r.sql).toBe(`SELECT * FROM users LIMIT ${DEFAULT_ROW_LIMIT}`);
    expect(r.limitApplied).toBe(DEFAULT_ROW_LIMIT);
    expect(r.note).toMatch(/no LIMIT/);
  });

  it("uses the requested limit and drops a trailing semicolon", () => {
    expect(withRowLimit("SELECT * FROM users;", 50).sql).toBe("SELECT * FROM users LIMIT 50");
  });

  it("keeps a limit the caller already wrote", () => {
    for (const sql of [
      "SELECT * FROM users LIMIT 10",
      "SELECT * FROM users limit 10 offset 5",
      "SELECT * FROM users ORDER BY id FETCH FIRST 5 ROWS ONLY",
    ]) {
      const r = withRowLimit(sql);
      expect(r.limitApplied, sql).toBeUndefined();
      expect(r.sql, sql).toBe(sql);
    }
  });

  it("adds a limit after ORDER BY, and before a locking clause", () => {
    expect(withRowLimit("SELECT * FROM t ORDER BY id DESC", 5).sql).toBe("SELECT * FROM t ORDER BY id DESC LIMIT 5");
    expect(withRowLimit("SELECT * FROM t WHERE x = 1 FOR UPDATE", 5).sql).toBe("SELECT * FROM t WHERE x = 1 LIMIT 5 FOR UPDATE");
    expect(withRowLimit("SELECT * FROM t LOCK IN SHARE MODE", 5).sql).toBe("SELECT * FROM t LIMIT 5 LOCK IN SHARE MODE");
  });

  it("is not fooled by the word limit inside a string or a comment", () => {
    expect(withRowLimit("SELECT * FROM t WHERE note = 'limit 5'", 7).sql)
      .toBe("SELECT * FROM t WHERE note = 'limit 5' LIMIT 7");
    expect(withRowLimit("SELECT * FROM t -- limit 5\n", 7).sql).toBe("SELECT * FROM t -- limit 5 LIMIT 7");
  });

  it("only counts a LIMIT at the top level, not one inside a subquery", () => {
    const r = withRowLimit("SELECT * FROM (SELECT id FROM t LIMIT 3) x", 9);
    expect(r.limitApplied).toBe(9);
    expect(r.sql).toBe("SELECT * FROM (SELECT id FROM t LIMIT 3) x LIMIT 9");
  });

  it("limits a CTE that ends in a SELECT, but leaves a CTE that writes alone", () => {
    expect(withRowLimit("WITH r AS (SELECT * FROM posts) SELECT * FROM r", 4).sql)
      .toBe("WITH r AS (SELECT * FROM posts) SELECT * FROM r LIMIT 4");
    expect(withRowLimit("WITH gone AS (DELETE FROM t RETURNING *) SELECT 1", 4).limitApplied).toBeUndefined();
  });

  it("leaves writes, DDL and multi-statement input untouched", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "SHOW TABLES",
      "DESCRIBE users",
      "EXPLAIN SELECT * FROM t",
    ]) {
      expect(withRowLimit(sql).limitApplied, sql).toBeUndefined();
    }
    const multi = withRowLimit("SELECT 1; SELECT 2");
    expect(multi.limitApplied).toBeUndefined();
    expect(multi.note).toMatch(/several statements/);
  });

  it("clamps a requested limit into range", () => {
    expect(clampRowLimit(undefined)).toBe(DEFAULT_ROW_LIMIT);
    expect(clampRowLimit(0)).toBe(DEFAULT_ROW_LIMIT);
    expect(clampRowLimit(-5)).toBe(DEFAULT_ROW_LIMIT);
    expect(clampRowLimit("abc")).toBe(DEFAULT_ROW_LIMIT);
    expect(clampRowLimit(25)).toBe(25);
    expect(clampRowLimit(10_000_000)).toBe(MAX_ROW_LIMIT);
    expect(clampRowLimit(undefined, 500)).toBe(500);
  });

  // The case that started this: 459k rows spent 24s building a result set before the server-side
  // execution cap killed it. The point is that the database never starts that work.
  it("caps the query that used to take 24 seconds", () => {
    expect(withRowLimit("SELECT * FROM customers_detail").sql)
      .toBe(`SELECT * FROM customers_detail LIMIT ${DEFAULT_ROW_LIMIT}`);
  });
});

describe("limitReport", () => {
  const noLimit = withRowLimit("SELECT * FROM users", 200);

  it("says nothing when the cap did not bite", () => {
    expect(limitReport(noLimit, 3, undefined)).toEqual({});
    expect(limitReport(noLimit, 199, undefined)).toEqual({});
  });

  it("explains the cap only when the caller did not choose it", () => {
    // Default applied and reached: the model has to be told, or 200 rows read as the whole table.
    const auto = limitReport(noLimit, 200, undefined);
    expect(auto.limitApplied).toBe(200);
    expect(auto.note).toMatch(/no LIMIT/);

    // The caller passed `limit: 1` — explaining their own boundary back to them is noise.
    const asked = limitReport(withRowLimit("SELECT * FROM users", 1), 1, 1);
    expect(asked).toEqual({ limitApplied: 1 });
    expect(asked.note).toBeUndefined();
  });

  it("still passes through a note that is not about a cap", () => {
    const multi = withRowLimit("SELECT 1; SELECT 2");
    expect(limitReport(multi, 1, 5).note).toMatch(/several statements/);
  });
});

describe("dropNullColumns", () => {
  it("removes null and undefined columns, keeping every other falsy value", () => {
    const rows = [{ id: 1, name: "a", mobile: null, note: undefined, empty: "", zero: 0, no: false }];
    expect(dropNullColumns(rows)).toEqual([{ id: 1, name: "a", empty: "", zero: 0, no: false }]);
  });

  it("halves a wide sparse row", () => {
    // A 65-column row of which 23 are null: 2054 chars pretty-printed before, ~1.1k compact after.
    const row: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) row[`column_number_${i}`] = i % 3 === 0 ? null : `value-${i}`;
    const before = JSON.stringify([row]).length;
    const after = JSON.stringify(dropNullColumns([row])).length;
    expect(after).toBeLessThan(before * 0.8);
  });

  it("leaves non-object rows alone", () => {
    expect(dropNullColumns([1, "a", null, [{ id: 1, x: null }]])).toEqual([1, "a", null, [{ id: 1, x: null }]]);
  });
});

describe("statement stacking", () => {
  it("rejects a read with a write stacked behind a semicolon", () => {
    // pg.ts passes the statement to pool.query() as a bare string, which node-postgres runs with the
    // simple query protocol — every `;`-separated statement executes.
    for (const sql of [
      "SELECT 1; DROP TABLE users",
      "SHOW TABLES; DELETE FROM t",
      "select 1;update t set a=1",
      "TABLE t; TRUNCATE t",
    ]) {
      expect(isReadOnlySql(sql), sql).toBe(false);
    }
  });

  it("allows a semicolon that only terminates the one statement", () => {
    expect(isReadOnlySql("SELECT 1;")).toBe(true);
    expect(isReadOnlySql("SELECT 1;  \n ")).toBe(true);
  });

  it("is not fooled by a semicolon inside a string or a comment", () => {
    expect(isReadOnlySql("SELECT * FROM t WHERE note = 'a;b'")).toBe(true);
    expect(isReadOnlySql("SELECT 1 -- ; DROP TABLE t\n")).toBe(true);
  });
});

describe("isReadOnlySql literal handling", () => {
  it("does not treat a write keyword inside a string literal as a write", () => {
    expect(isReadOnlySql("EXPLAIN SELECT * FROM t WHERE note = 'insert something'")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x WHERE s = 'delete me'")).toBe(true);
  });

  it("still rejects a real write behind WITH or EXPLAIN", () => {
    expect(isReadOnlySql("WITH gone AS (DELETE FROM t RETURNING *) SELECT 1")).toBe(false);
    expect(isReadOnlySql("EXPLAIN ANALYZE INSERT INTO t VALUES (1)")).toBe(false);
  });
});
