/** Statement keywords that write, in any dialect we speak here. */
const WRITE_RE =
  /\b(insert|update|delete|truncate|drop|alter|create|rename|replace|grant|revoke|copy|vacuum|analyze|merge|call|do|refresh|lock|set|reset|comment|cluster|reindex|import|load|handler)\b/i;
/** Statement shapes that only read. */
const READ_FIRST = new Set(["select", "with", "show", "explain", "describe", "desc", "table", "values"]);

/**
 * Best-effort check that a statement only reads.
 *
 * This is a guard that produces a clear error message, NOT a security boundary — the real boundary
 * is the database session itself (Postgres `default_transaction_read_only`, or a user granted only
 * SELECT). Use both.
 *
 * Every decision here is made on MASKED text (string literals, quoted identifiers and comments
 * blanked out, leading comments among them), so neither `WHERE note = 'delete me'` nor a keyword in
 * a comment can change the answer.
 */
export function isReadOnlySql(sql: string): boolean {
  // Drop a single trailing terminator first: `SELECT 1;` is one statement, not two.
  const s = maskLiterals(sql).replace(/\s+$/, "").replace(/;\s*$/, "").trim();
  if (!s) return false;
  const first = (s.match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
  if (!READ_FIRST.has(first)) return false;
  // A second statement rides along for free on the simple query protocol — node-postgres uses it for
  // any query passed as a bare string, so `SELECT 1; DROP TABLE users` would execute both. Refuse
  // anything that still holds a separator once literals and comments are out of the way.
  if (s.includes(";")) return false;
  // `WITH x AS (...) DELETE ...` and `EXPLAIN ANALYZE INSERT ...` read like reads but are not.
  if (first === "with" || first === "explain") return !WRITE_RE.test(s.slice(first.length));
  return true;
}

/** Reject a statement that writes when the MCP is marked readonly. */
export function assertReadOnly(sql: string, label: string): void {
  if (isReadOnlySql(sql)) return;
  throw new Error(`refused: this ${label} MCP is configured readonly, and the statement is not a plain read`);
}

/**
 * Drop the columns that are NULL in each row.
 *
 * A `SELECT *` on a wide table spends most of its reply saying nothing: one row of a 65-column
 * table is ~2 KB, and a third of the columns can be `"col": null`. An absent key carries the same
 * information for free, so a single-row answer roughly halves (together with compact rendering).
 * Both query tools state this in their description, and `pg_describe_table` / `DESCRIBE` remain the
 * way to see the full column list.
 */
export function dropNullColumns<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out as T;
  });
}

// --- automatic row limits -------------------------------------------------------------------------

/** Default rows returned when a SELECT arrives without a LIMIT of its own. */
export const DEFAULT_ROW_LIMIT = 200;
/** Ceiling on an explicitly requested limit, so the output budget stays meaningful. */
export const MAX_ROW_LIMIT = 10000;

export function clampRowLimit(requested: unknown, fallback = DEFAULT_ROW_LIMIT): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_ROW_LIMIT);
}

/**
 * Blank out string literals, quoted identifiers and comments, preserving length so offsets into the
 * original stay valid. Keyword scanning must not be fooled by `WHERE note = 'limit 5'`.
 */
function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && quote !== "`") { out += "  "; i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += "  "; i += 2; continue; } // doubled = escaped quote
          out += " ";
          i++;
          break;
        }
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blank anything nested in parentheses, so only top-level clauses remain. Length is preserved. */
function blankParens(masked: string): string {
  let out = "";
  let depth = 0;
  for (const ch of masked) {
    if (ch === "(") { depth++; out += " "; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); out += " "; continue; }
    out += depth > 0 ? " " : ch;
  }
  return out;
}

/** Row-returning statement shapes that accept a trailing LIMIT in both MySQL and Postgres. */
const LIMITABLE = new Set(["select", "with", "table", "values"]);
/** A locking clause must stay last: `... LIMIT n FOR UPDATE`, never `... FOR UPDATE LIMIT n`. */
const LOCK_TAIL_RE = /\b(for\s+(no\s+key\s+)?update|for\s+(key\s+)?share|lock\s+in\s+share\s+mode)\b/i;
/** A data-modifying CTE (`WITH x AS (DELETE … RETURNING *) SELECT * FROM x`) writes every row no
 *  matter what the outer LIMIT says, so limiting it would make the reported output look bounded when
 *  the write was not. Leave those statements exactly as written. */
const CTE_WRITE_RE = /\b(insert|update|delete|merge)\b/i;
const HAS_LIMIT_RE = /\blimit\b/i;
const HAS_FETCH_RE = /\bfetch\s+(first|next)\b/i;
const INTO_FILE_RE = /\binto\s+(outfile|dumpfile)\b/i;

export interface LimitedSql {
  sql: string;
  /** Set when this function added a limit that the caller did not write. */
  limitApplied?: number;
  /** Short explanation to hand back with the rows, so partial results are never mistaken for all of them. */
  note?: string;
}

/**
 * The `limitApplied` / `note` fields to return alongside a row set, if any.
 *
 * Two rules, both about not wasting the caller's attention:
 * - only when the cap actually bit — "LIMIT 200 was applied" under a three-row answer invites a retry
 *   of a query that was already complete;
 * - prose only when the caller did not choose the limit. Someone who passed `limit: 1` does not need
 *   the reply to explain their own boundary back to them; `limitApplied` alone confirms it was reached.
 */
export function limitReport(
  prepared: LimitedSql,
  rowCount: number,
  requestedLimit: unknown,
): { limitApplied?: number; note?: string } {
  if (prepared.limitApplied == null) return prepared.note ? { note: prepared.note } : {};
  if (rowCount < prepared.limitApplied) return {};
  if (requestedLimit != null) return { limitApplied: prepared.limitApplied };
  return { limitApplied: prepared.limitApplied, note: prepared.note };
}

/**
 * Add `LIMIT n` to a row-returning statement that has none.
 *
 * The point is to stop the database from doing the work at all: `SELECT * FROM big_table`
 * (459k rows) spent 24 seconds building a result set before the server-side execution cap killed it.
 * A statement that already limits itself, writes, or contains several statements is left untouched.
 */
export function withRowLimit(sql: string, limit = DEFAULT_ROW_LIMIT): LimitedSql {
  const trimmed = sql.replace(/\s+$/, "").replace(/;\s*$/, "").replace(/\s+$/, "");
  const masked = maskLiterals(trimmed);
  const top = blankParens(masked);

  const first = (masked.trim().match(/^[a-z]+/i)?.[0] ?? "").toLowerCase();
  if (!LIMITABLE.has(first)) return { sql: trimmed };
  if (first === "with" && (!/\bselect\b/i.test(top) || CTE_WRITE_RE.test(masked))) return { sql: trimmed };
  if (top.includes(";")) {
    return { sql: trimmed, note: "several statements were sent, so no row limit was added — add LIMIT yourself." };
  }
  if (HAS_LIMIT_RE.test(top) || HAS_FETCH_RE.test(top)) return { sql: trimmed };
  if (INTO_FILE_RE.test(top)) return { sql: trimmed };

  const clause = `LIMIT ${limit}`;
  const lock = LOCK_TAIL_RE.exec(top);
  const out = lock
    ? `${trimmed.slice(0, lock.index).replace(/\s+$/, "")} ${clause} ${trimmed.slice(lock.index)}`
    : `${trimmed} ${clause}`;
  return {
    sql: out,
    limitApplied: limit,
    note: `no LIMIT in the statement, so ${clause} was applied — there may be more rows.`,
  };
}
