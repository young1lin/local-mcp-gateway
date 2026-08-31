/**
 * The data-browser model behind the admin panel's "Data" view — a small DBeaver-style table
 * browser layered on the SAME driver pools the mysql/pg MCP adapters already own.
 *
 * Two contracts matter here:
 *
 * - PAGING IS SERVER-SIDE, ALWAYS. The table list and the row grid both page at the database
 *   (LIMIT/OFFSET with a counted total), so an instance with thousands of tables or a
 *   million-row table costs one bounded page per click, never a full dump.
 *
 * - EDITS ARE TRANSACTIONAL. Cell edits, inserts and deletes arrive as a buffered edit list and
 *   touch the database only when the panel posts them to applyEdits, which runs every statement
 *   on ONE connection inside BEGIN ... COMMIT and rolls the whole batch back on the first
 *   failure. "Discard" never reaches the database at all — it only drops the client-side buffer.
 */
import { assertIdent } from "./adapters/resources.js";
import { likeContains } from "./adapters/sql.js";

export type DbDialect = "mysql" | "pg";

/** Row-count options the panel offers. 50 is the default: enough to scan, small enough that a
 *  wide table paints instantly; anything bigger is an explicit choice. */
export const BROWSE_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const;
/** Rows fetched per page when the caller sends no (or a nonsense) limit. */
export const BROWSE_DEFAULT_PAGE = 50;
/** Ceiling on a requested page — one grid may never ask for the whole table. */
export const BROWSE_MAX_PAGE = 500;
/** Tables per page in the lazy table list (mirrors DEFAULT_TABLE_LIMIT of the MCP tools). */
export const BROWSE_TABLES_PAGE = 200;
export const BROWSE_TABLES_MAX = 1000;

/** Clamp a requested page size to a sane positive int bounded by BROWSE_MAX_PAGE. */
export function browsePageSize(requested: unknown, fallback = BROWSE_DEFAULT_PAGE): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, BROWSE_MAX_PAGE);
}

/** Clamp a non-negative offset. */
export function browseOffset(requested: unknown): number {
  const n = Math.floor(Number(requested));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Clamp a table-list page-size request: a positive int when the caller sent one, capped at
 *  `max`, `fallback` otherwise. Shared by the mysql/pg listTables browsers so the Data view clamps
 *  one shape only (sql.ts keeps its own tablePageArgs for the MCP tools — same rule, args object). */
export function clampBrowseLimit(raw: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

// --- shapes -------------------------------------------------------------------------------------

export interface BrowseTableInfo {
  schema: string;
  name: string;
  type: string;
  approxRows: number | null;
  size: string;
}

export interface BrowseTables {
  tables: BrowseTableInfo[];
  total: number;
  page: number;
  limit: number;
  more: boolean;
}

export interface BrowseColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string | null;
  /** The column's COMMENT text — MySQL information_schema or pg col_description. Null when the
   *  column carries none; the panel surfaces it in the grid header tooltip and Columns tab. */
  comment?: string | null;
}

export interface BrowseDataPage {
  schema: string;
  table: string;
  columns: BrowseColumn[];
  rows: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  primaryKey: string[];
  /** False when the connection is readonly or the table has no primary key — the grid disables
   *  editing and editNote says why, so the panel never has to guess the rule. */
  editable: boolean;
  editNote?: string;
}

/** One buffered change, as the panel posts it. pk maps primary-key column -> value; a null or
 *  string value is passed through to the driver as a bound parameter (both drivers cast). */
export type BrowseEdit =
  | { op: "update"; pk: Record<string, unknown>; changes: Record<string, unknown> }
  | { op: "insert"; values: Record<string, unknown> }
  | { op: "delete"; pk: Record<string, unknown> };

export interface BrowseEditResult {
  op: "update" | "insert" | "delete";
  affected: number;
}

export interface BrowseQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  note?: string;
}

/** What an adapter exposes for the browser. Constructed on demand; the heavy thing (the driver
 *  pool) is the adapter's own Lazy, shared with the MCP tools. */
export interface DbBrowser {
  readonly dialect: DbDialect;
  /** True when the underlying MCP def is readonly — the panel shows a read-only banner. */
  readonly readonly: boolean;
  /** Where this connection points ("app @ localhost:3306"). Never a password. */
  readonly label: string;
  listTables(opts: { grep?: string; page?: unknown; limit?: unknown }): Promise<BrowseTables>;
  readTable(opts: {
    table: string;
    schema?: string;
    offset?: unknown;
    limit?: unknown;
    order?: string;
    dir?: string;
    filters?: readonly BrowseFilter[];
  }): Promise<BrowseDataPage>;
  /** Columns, indexes, foreign keys and DDL for one table — the Structure tabs. */
  describeTable(opts: { table: string; schema?: string }): Promise<BrowseTableDetail>;
  /** Apply a buffered edit list in ONE transaction: all of it, or none of it. */
  applyEdits(opts: { table: string; schema?: string; edits: BrowseEdit[] }): Promise<{ results: BrowseEditResult[] }>;
  /** The SQL console: read-only by construction, so a paste can never write. */
  runQuery(sql: string, limit?: unknown): Promise<BrowseQueryResult>;
  /** Stream a whole table (capped at EXPORT_ROW_CAP) out as CSV or newline JSON. */
  exportTable(opts: { table: string; schema?: string; format: "csv" | "json"; limit?: unknown }): Promise<ExportResult>;
  /** Insert mapped CSV rows in ONE transaction (all-or-nothing), via the same statement
   *  builders the edit grid uses. Returns rows written. */
  importTable(opts: {
    table: string;
    schema?: string;
    header: string[];
    lines: string[];
    mapping: ImportMapping;
  }): Promise<{ inserted: number }>;
  /** Rename / truncate / drop a table. Refused outright on a readonly connection. */
  ddlOp(opts: { op: DdlOp; table: string; schema?: string; to?: string }): Promise<{ ran: string }>;
}

// --- identifier quoting -------------------------------------------------------------------------

/**
 * Quote one identifier for the dialect, after assertIdent has vetted it.
 *
 * The browser interpolates table/column names into SQL (LIMIT/OFFSET paging cannot bind them), so
 * every identifier passes the same SAFE_IDENT gate the resource URIs use — then it is quoted
 * anyway. Schema-qualified names are quoted per part by qualified().
 */
export function quoteIdent(dialect: DbDialect, name: string): string {
  assertIdent(name, dialect === "mysql" ? "MySQL identifier" : "Postgres identifier");
  return dialect === "mysql" ? "`" + name + "`" : '"' + name + '"';
}

/** A quoted, schema-qualified table reference (backticks for MySQL, double quotes for PG). */
export function qualified(dialect: DbDialect, ref: { schema?: string; table: string }): string {
  return ref.schema
    ? quoteIdent(dialect, ref.schema) + "." + quoteIdent(dialect, ref.table)
    : quoteIdent(dialect, ref.table);
}

// --- read paging --------------------------------------------------------------------------------

/**
 * A vetted ORDER BY clause, or null when the caller asked for none. Unknown columns and unknown
 * directions are refused rather than ignored — a silently dropped sort changes what the grid
 * shows page to page, which looks like a bug in the paging instead of the sort.
 */
export function browseOrder(
  columns: readonly string[],
  order: string | undefined,
  dir: string | undefined,
  dialect: DbDialect,
): string | null {
  if (!order) return null;
  if (!columns.includes(order)) throw new Error("cannot sort by unknown column: " + order);
  const d = dir === "desc" ? "DESC" : dir === "asc" || dir == null ? "ASC" : "";
  if (!d) throw new Error("sort direction must be asc or desc, not '" + dir + "'");
  return quoteIdent(dialect, order) + " " + d;
}


// --- mongo collection browser ----------------------------------------------------------------------

export interface MongoCollectionInfo {
  name: string;
  type: string;
  approxDocs: number;
  size: string;
}

export interface MongoDocsPage {
  collection: string;
  documents: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  /** The union of field names across the page, _id first — the grid's columns. */
  fields: string[];
}

/** The mongo flavour of the Data view: list collections, find with a JSON filter. Read-only —
 *  writes stay on the MCP's mongo_insert/update/delete tools. */
export interface MongoBrowser {
  readonly readonly: boolean;
  readonly label: string;
  listCollections(opts: { grep?: string }): Promise<MongoCollectionInfo[]>;
  readCollection(opts: {
    collection: string;
    filterJson?: string; // a JSON query document; "{}" when empty
    offset?: unknown;
    limit?: unknown;
  }): Promise<MongoDocsPage>;
}

// --- redis key browser ---------------------------------------------------------------------------

export interface RedisKeyInfo {
  key: string;
  type: string;
  ttl: number; // seconds; -1 = no expiry
}

export interface RedisKeysPage {
  keys: RedisKeyInfo[];
  cursor: string; // pass back to continue the SCAN
  done: boolean;
  total?: number; // dbsize, for the pager label only
}

/** The redis flavour of the Data view: page keys by SCAN, read one key type-aware. */
export interface RedisBrowser {
  readonly readonly: boolean;
  readonly label: string;
  listKeys(opts: { pattern?: string; cursor?: string; count?: unknown; type?: string }): Promise<RedisKeysPage>;
  readKey(key: string): Promise<Record<string, unknown>>;
  /** Run ONE command from the console: GET, HGETALL, LRANGE, TTL, TYPE, SCAN… Read-only
   *  enforced by the adapter's own command guard (assertCommandAllowed + READ_COMMANDS). */
  runCommand(line: string): Promise<unknown>;
}

// --- CSV import ----------------------------------------------------------------------------------

/** Parse ONE line of CSV honoring RFC 4180 quoting (a quoted field may span lines is NOT
 *  supported here — the panel splits on physical newlines, and quoted newlines inside a field
 *  are the importer's job to have escaped or avoided; fields with them arrive via JSON upload). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === String.fromCharCode(34) && line[i + 1] === String.fromCharCode(34)) { cur += String.fromCharCode(34); i++; }
      else if (c === String.fromCharCode(34)) inQ = false;
      else cur += c;
    } else {
      if (c === ",") { out.push(cur); cur = ""; }
      else if (c === String.fromCharCode(34) && cur === "") inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** An import mapping: CSV header index -> table column (null = skip this CSV column). */
export type ImportMapping = Array<string | null>;

/** Cap on rows in one import batch — one transaction, one bounded payload. */
export const IMPORT_ROW_CAP = 10_000;

/**
 * Turn CSV lines into insert values using the mapping. Coercion is deliberately thin: empty
 * string becomes NULL, numeric-looking strings become numbers ONLY when Number() is lossless
 * (numericBindValue — a 19-digit snowflake ID or a beyond-double-precision decimal stays a string
 * so the driver casts it against the column exactly), everything else stays a string and the
 * driver casts. A row whose mapped cells are ALL empty is dropped rather than inserted as NULLs.
 */
export function mapImportRows(
  header: readonly string[],
  lines: readonly string[],
  mapping: ImportMapping,
): Array<Record<string, unknown>> {
  if (mapping.length !== header.length) {
    throw new Error(`mapping covers ${mapping.length} of ${header.length} CSV columns`);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const row: Record<string, unknown> = {};
    let any = false;
    for (let i = 0; i < header.length; i++) {
      const col = mapping[i];
      if (!col) continue;
      const raw = cells[i] ?? "";
      if (raw === "") continue;
      any = true;
      row[col] = numericBindValue(raw);
    }
    if (any) out.push(row);
  }
  return out;
}

// --- full-table export ---------------------------------------------------------------------------

/** Hard ceiling on one export. A table bigger than this needs a filtered query, not a download —
 *  the browser would happily try to hold a 4 GB string. */
export const EXPORT_ROW_CAP = 100_000;
/** Rows fetched per chunk while paging through an export. */
export const EXPORT_CHUNK = 5_000;

export interface ExportOptions {
  format: "csv" | "json";
  limit?: unknown;
}

export interface ExportResult {
  format: "csv" | "json";
  columns: string[];
  rows: number;
  capped: boolean;
  body: string;
}

/** Clamp an export row cap request. */
export function exportRowLimit(requested: unknown): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return EXPORT_ROW_CAP;
  return Math.min(n, EXPORT_ROW_CAP);
}

/** Fold fetched rows into the final CSV text (RFC 4180, header row included). */
export function toCsv(columns: readonly string[], rows: Array<Record<string, unknown>>): string {
  const out = [columns.map(csvEscape).join(",")];
  for (const r of rows) out.push(columns.map((c) => csvEscape(r[c])).join(","));
  return out.join("\r\n");
}

/** Fold fetched rows into newline-delimited JSON (one object per line — splittable, streamable). */
export function toJsonLines(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

// --- copy-out helpers ----------------------------------------------------------------------------

/** One CSV cell, quoted per RFC 4180: quotes doubled, embedded separators/newlines survive. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

/** One SQL literal for the clipboard — never executed, so inlining is safe here. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const q = String.fromCharCode(39); // single quote
  return q + String(v).split(q).join(q + q) + q;
}

/** INSERT INTO t (a, b) VALUES (...); — mirrors buildEditStatements identifier rules
 *  (each column vetted + dialect-quoted) so what you copy matches what Commit would run. */
export function toInsertStatement(
  dialect: DbDialect,
  ref: { schema?: string; table: string },
  columnNames: readonly string[],
  row: Record<string, unknown>,
): string {
  const cols = columnNames.filter((c) => row[c] !== undefined);
  if (!cols.length) throw new Error("the row has no values to copy");
  return "INSERT INTO " + qualified(dialect, ref) + " (" +
    cols.map((c) => quoteIdent(dialect, c)).join(", ") + ") VALUES (" +
    cols.map((c) => sqlLiteral(row[c])).join(", ") + ");";
}

// --- structure operations --------------------------------------------------------------------------

export type DdlOp = "rename" | "truncate" | "drop";

/**
 * The statement behind a structure operation. Every identifier passes assertIdent + dialect
 * quoting on the way in (these statements bind nothing — the names ARE the payload).
 */
export function buildDdlOpSql(
  dialect: DbDialect,
  op: DdlOp,
  ref: { schema?: string; table: string },
  opts: { to?: string } = {},
): string {
  switch (op) {
    case "rename": {
      const to = String(opts.to ?? "");
      if (!to) throw new Error("rename needs the new table name");
      if (dialect === "mysql") {
        // Same-schema rename only — the panel never offered a cross-schema one.
        const target = ref.schema ? qualified(dialect, { schema: ref.schema, table: to }) : quoteIdent(dialect, to);
        return `RENAME TABLE ${qualified(dialect, ref)} TO ${target}`;
      }
      return `ALTER TABLE ${qualified(dialect, ref)} RENAME TO ${quoteIdent(dialect, to)}`;
    }
    case "truncate":
      return `TRUNCATE TABLE ${qualified(dialect, ref)}`;
    case "drop":
      return `DROP TABLE ${qualified(dialect, ref)}`;
    default:
      throw new Error(`unknown structure operation: ${String(op)}`);
  }
}
// --- table structure ---------------------------------------------------------------------------

export interface BrowseIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  /** MySQL: absent; PG: the full CREATE INDEX statement from pg_indexes. */
  definition?: string;
}

export interface BrowseForeignKey {
  name: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface BrowseTableDetail {
  schema: string;
  table: string;
  columns: BrowseColumn[];
  primaryKey: string[];
  indexes: BrowseIndex[];
  foreignKeys: BrowseForeignKey[];
  /** The CREATE TABLE text — verbatim from MySQL SHOW CREATE TABLE, synthesized from the
   *  catalog for Postgres (which has no equivalent command). */
  ddl: string;
}

/** Fold raw index rows (one per indexed COLUMN, already aliased: name/unique(0|1)/primary/column,
 *  in index order) into one BrowseIndex per index, columns in arrival order. */
export function toBrowseIndexes(rows: Array<Record<string, unknown>>): BrowseIndex[] {
  const byName = new Map<string, BrowseIndex>();
  for (const r of rows) {
    const name = String(r.name);
    let idx = byName.get(name);
    if (!idx) {
      idx = {
        name,
        unique: Number(r.unique) !== 1,
        primary: r.primary === 1 || r.primary === true,
        columns: [],
        definition: r.definition == null ? undefined : String(r.definition),
      };
      byName.set(name, idx);
    }
    if (r.column != null) idx.columns.push(String(r.column));
  }
  return [...byName.values()];
}

/** Postgres has no SHOW CREATE TABLE. Rather than shell out to pg_dump (not installed, needs a
 *  password dance, version-matched), assemble a faithful sketch from the catalog pieces the
 *  detail view already fetched. Column types come out as information_schema spells them. */
export function buildPgDdl(
  ref: { schema: string; table: string },
  columns: readonly BrowseColumn[],
  primaryKey: readonly string[],
  foreignKeys: readonly BrowseForeignKey[] = [],
): string {
  const lines = columns.map((c) => {
    let line = "    " + quoteIdent("pg", c.name) + " " + c.dataType;
    if (!c.nullable) line += " NOT NULL";
    if (c.defaultValue != null && c.defaultValue !== "") line += " DEFAULT " + c.defaultValue;
    return line + ",";
  });
  if (primaryKey.length) {
    lines.push("    PRIMARY KEY (" + primaryKey.map((c) => quoteIdent("pg", c)).join(", ") + "),");
  }
  for (const fk of foreignKeys) {
    lines.push(
      "    FOREIGN KEY (" + quoteIdent("pg", fk.column) + ") REFERENCES " +
      quoteIdent("pg", fk.refSchema) + "." + quoteIdent("pg", fk.refTable) +
      " (" + quoteIdent("pg", fk.refColumn) + "),",
    );
  }
  const body = lines.length ? "\n" + lines.join("\n") + "\n" : "";
  return "CREATE TABLE " + quoteIdent("pg", ref.schema) + "." + quoteIdent("pg", ref.table) + " (" + body + ");";
}

// --- row filters ---------------------------------------------------------------------------------

/** The operators a grid filter may use. Deliberately a whitelist: the panel offers exactly these
 *  and anything else is refused, because the fragment is interpolated into SQL by identifier —
 *  every VALUE stays a bound parameter, but the operator slot must never be free text. */
export const BROWSE_FILTER_OPS = [
  "eq", "ne", "gt", "gte", "lt", "lte", "like", "notLike", "isNull", "isNotNull",
] as const;
export type BrowseFilterOp = (typeof BROWSE_FILTER_OPS)[number];

export interface BrowseFilter {
  column: string;
  op: BrowseFilterOp;
  /** Text from the grid's filter input. Numeric-looking text is bound as a number so Postgres
   *  compares it against numeric columns instead of erroring on `integer > text`. */
  value?: string | null;
}

/** Bind a numeric-looking string as a number only while Number() is lossless; otherwise bind the
 *  original string. Integers must fit a JS safe integer — a snowflake ID (19 digits) loses its low
 *  bits through Number() (734023681584275456 would arrive as …500 in every row) — and decimals
 *  must round-trip exactly (String(Number(s)) === s, so "3.14" binds as a number while "1.10" and
 *  beyond-double-precision decimals stay strings). String-bound values stay exact: MySQL coerces
 *  them against the column, and Postgres infers the parameter type from the comparison or the
 *  column, so neither dialect silently rounds.
 *
 *  Shared by the grid filters (buildFilterWhere) and CSV import (mapImportRows), because the two
 *  once drifted: filters already refused lossy integers while import rounded them into the table. */
export function numericBindValue(raw: string): number | string {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return raw;
  const n = Number(s);
  if (!s.includes(".")) return Number.isSafeInteger(n) ? n : s;
  return String(n) === s ? n : s;
}

/** information_schema data_types that are textual, so `col ILIKE $n` is valid on Postgres as-is.
 *  Anything else (numbers, dates, booleans, json, arrays, …) must be CAST to text first —
 *  `integer ILIKE text` is Postgres error 42883, operator does not exist. */
const PG_TEXTUAL_TYPES = new Set(["text", "character varying", "character", "name", "citext"]);

/** The left side of a contains-filter comparison. Postgres casts non-text columns to text
 *  explicitly; MySQL stays the bare column because its string context converts implicitly. */
function likeSubject(dialect: DbDialect, col: string, dataType: string | undefined): string {
  const quoted = quoteIdent(dialect, col);
  if (dialect !== "pg" || dataType == null || PG_TEXTUAL_TYPES.has(dataType.toLowerCase())) return quoted;
  return "CAST(" + quoted + " AS text)";
}

/**
 * Build the WHERE fragment for a grid page: every identifier vetted + quoted, every value a
 * bound parameter. `columns` may be bare names or full BrowseColumns — the type info is optional
 * and only feeds the contains-filter cast below (callers without it get the plain column).
 * "contains" matches as a substring — likeContains does the wildcard escaping, and the ESCAPE '!'
 * clause keeps a user's own % and _ literal — with ILIKE on Postgres (CAST to text on non-text
 * columns) so both dialects filter case-insensitively. Multiple filters stack with AND.
 */
export function buildFilterWhere(
  dialect: DbDialect,
  columns: readonly (string | BrowseColumn)[],
  filters: readonly BrowseFilter[],
): { frag: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return dialect === "mysql" ? "?" : "$" + String(params.length);
  };
  const typeOf = new Map(columns.map((c): [string, string | undefined] =>
    typeof c === "string" ? [c, undefined] : [c.name, c.dataType]));
  const known = new Set(typeOf.keys());
  const parts: string[] = [];
  for (const f of filters) {
    if (!f || typeof f.column !== "string" || !known.has(f.column)) {
      throw new Error("cannot filter by unknown column: " + String((f as BrowseFilter | undefined)?.column));
    }
    const col = quoteIdent(dialect, f.column);
    switch (f.op) {
      case "isNull":
        parts.push(col + " IS NULL");
        break;
      case "isNotNull":
        parts.push(col + " IS NOT NULL");
        break;
      case "like":
      case "notLike": {
        if (f.value == null || String(f.value) === "") throw new Error("a '" + f.op + "' filter needs a value");
        const neg = f.op === "notLike" ? "NOT " : "";
        const like = dialect === "pg" ? "ILIKE" : "LIKE";
        parts.push(likeSubject(dialect, f.column, typeOf.get(f.column)) + " " + neg + like + " " +
          bind(likeContains(String(f.value))) + " ESCAPE '!'");
        break;
      }
      case "eq":
      case "ne":
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (f.value == null || String(f.value) === "") throw new Error("a comparison filter needs a value");
        const sqlOp = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
        const v = String(f.value);
        parts.push(col + " " + sqlOp + " " + bind(numericBindValue(v)));
        break;
      }
      default:
        throw new Error("unknown filter operator: " + String(f.op));
    }
  }
  return { frag: parts.length ? " WHERE " + parts.join(" AND ") : "", params };
}

/** The bounded SELECT behind one grid page. LIMIT/OFFSET are clamped integers, so they are
 *  inlined rather than bound (both dialects accept that only for literal ints); the WHERE
 *  fragment's parameters are the statement's only bound values, so their numbering starts at 1. */
export function browseRowsSql(
  dialect: DbDialect,
  ref: { schema?: string; table: string },
  columnNames: readonly string[],
  order: string | null,
  offset: number,
  limit: number,
  whereFrag = "",
  whereParams: readonly unknown[] = [],
): BuiltStatement {
  const cols = columnNames.length
    ? columnNames.map((c) => quoteIdent(dialect, c)).join(", ")
    : "*";
  const orderBy = order ? " ORDER BY " + order : "";
  return {
    sql: "SELECT " + cols + " FROM " + qualified(dialect, ref) + whereFrag + orderBy +
      " LIMIT " + limit + " OFFSET " + offset,
    params: [...whereParams],
  };
}

export function browseCountSql(
  dialect: DbDialect,
  ref: { schema?: string; table: string },
  whereFrag = "",
  whereParams: readonly unknown[] = [],
): BuiltStatement {
  return {
    sql: "SELECT COUNT(*) AS total FROM " + qualified(dialect, ref) + whereFrag,
    params: [...whereParams],
  };
}

// --- edit statements ----------------------------------------------------------------------------

export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

/** A bound-parameter placeholder: "?" for MySQL, "$n" for Postgres (per statement, so n restarts). */
function ph(dialect: DbDialect, params: unknown[]): string {
  // bind() has already pushed the value, so the array length IS this parameter's 1-based number.
  return dialect === "mysql" ? "?" : "$" + String(params.length);
}

/**
 * Turn a buffered edit list into executable statements: one statement per edit, in order, with
 * every value bound and every identifier pre-vetted. Column names the table does not have are
 * dropped from SET/INSERT (a stale page may reference a dropped column); an edit that ends up
 * with nothing to do is an error, because "commit 3 changes" that silently did 2 is a lie.
 *
 * Updates and deletes address rows by the FULL primary key only — the DBeaver default — so an
 * edit can never fan out over more rows than the cell you changed.
 */
export function buildEditStatements(
  dialect: DbDialect,
  ref: { schema?: string; table: string },
  edits: readonly BrowseEdit[],
  columns: readonly BrowseColumn[],
  primaryKey: readonly string[],
): BuiltStatement[] {
  const table = qualified(dialect, ref);
  const known = new Set(columns.map((c) => c.name));
  const out: BuiltStatement[] = [];
  for (const edit of edits) {
    const params: unknown[] = [];
    const bind = (v: unknown): string => {
      params.push(v);
      return ph(dialect, params);
    };
    if (edit.op === "insert") {
      const cols = Object.keys(edit.values).filter((c) => known.has(c));
      if (!cols.length) throw new Error("insert names no column of this table");
      const values = cols.map((c) => bind(edit.values[c])).join(", ");
      out.push({
        sql: "INSERT INTO " + table + " (" + cols.map((c) => quoteIdent(dialect, c)).join(", ") + ") VALUES (" + values + ")",
        params,
      });
      continue;
    }
    // update / delete: the WHERE needs a value for every PK column, or the edit is unaddressable.
    if (!primaryKey.length) {
      throw new Error("table has no primary key — " + edit.op + " is not possible");
    }
    for (const c of primaryKey) {
      if (!(c in edit.pk)) throw new Error(edit.op + " needs a value for primary-key column " + c);
    }
    if (edit.op === "delete") {
      const where = primaryKey.map((c) => quoteIdent(dialect, c) + " = " + bind(edit.pk[c])).join(" AND ");
      out.push({ sql: "DELETE FROM " + table + " WHERE " + where, params });
      continue;
    }
    // Bind in SQL order — SET placeholders appear before the WHERE's, and a positional "?" driver
    // (mysql2) wires params strictly by position.
    const sets = Object.entries(edit.changes).filter(([c]) => known.has(c));
    if (!sets.length) throw new Error("update names no column of this table");
    const setSql = sets.map(([c, v]) => quoteIdent(dialect, c) + " = " + bind(v)).join(", ");
    const where = primaryKey.map((c) => quoteIdent(dialect, c) + " = " + bind(edit.pk[c])).join(" AND ");
    out.push({ sql: "UPDATE " + table + " SET " + setSql + " WHERE " + where, params });
  }
  return out;
}

/**
 * Prefix a statement with EXPLAIN for the console's plan view — idempotent, so a query that
 * already explains itself is not double-prefixed. The statement keeps its single trailing
 * terminator stripped (EXPLAIN accepts one statement, not one plus a dangling ";").
 *
 * Both dialects spell it the same way. Read-only-ness still gates the WHOLE statement inside
 * runQuery: EXPLAIN of an INSERT is refused there by the write-keyword scan, and EXPLAIN ANALYZE
 * of a SELECT is allowed (it executes the select — reads only).
 */
export function withExplain(sql: string): string {
  const s = sql.replace(/\s+$/, "").replace(/;\s*$/, "").replace(/\s+$/, "");
  if (/^explain\b/i.test(s)) return s;
  return "EXPLAIN " + s;
}

/** Shape raw information_schema column rows into BrowseColumn, marking PK membership. */
export function toBrowseColumns(
  rows: Array<Record<string, unknown>>,
  pk: readonly string[],
): BrowseColumn[] {
  const pkSet = new Set(pk);
  return rows.map((r) => ({
    name: String(r.column_name),
    dataType: String(r.data_type),
    nullable: String(r.is_nullable).toUpperCase() === "YES",
    isPrimaryKey: pkSet.has(String(r.column_name)),
    defaultValue: r.column_default == null ? null : String(r.column_default),
    comment: r.column_comment == null || r.column_comment === "" ? null : String(r.column_comment),
  }));
}
