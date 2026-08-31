/**
 * The /api/db routes behind the panel's Data view: which connections can be browsed, their
 * (paged, greppable) table lists, one bounded page of rows per table, the read-only SQL console,
 * and the transactional edit commit.
 *
 * Same boundary as the rest of /api: the router's loopback guard is the only gate. Errors from
 * the database are handed back verbatim (driver messages never embed credentials) with a 400,
 * because for someone staring at a grid the driver's "Data too long for column 'x'" IS the
 * useful answer.
 */
import type { Registry } from "./registry.js";
import { stateOf } from "./adminapi.js";
import { sendJson, sendText, type Router } from "./http.js";
import { log } from "./log.js";
import { IMPORT_ROW_CAP } from "./dbbrowser.js";
import type { BrowseEdit, BrowseFilter, ImportMapping, DbBrowser, MongoBrowser, RedisBrowser } from "./dbbrowser.js";

/** One browsable connection row: everything the panel's picker needs, nothing secret. The
 *  redis flavour rides the same list with dialect "redis" and editable false (the key browser
 *  is read-only by design; writes go through the MCP's redis_command tool). */
export function browsableConnections(registry: Registry): Array<{
  name: string;
  dialect: string;
  label: string;
  readonly: boolean;
  state: string;
  editable: boolean;
}> {
  return registry.all()
    .map((e) => {
      const db = e.adapter.dbBrowser?.();
      if (db) {
        return { name: e.name, dialect: db.dialect, label: db.label, readonly: db.readonly, state: stateOf(e), editable: true };
      }
      const rb = e.adapter.redisBrowser?.();
      if (rb) {
        return { name: e.name, dialect: "redis", label: rb.label, readonly: rb.readonly, state: stateOf(e), editable: false };
      }
      const mb = e.adapter.mongoBrowser?.();
      if (mb) {
        return { name: e.name, dialect: "mongo", label: mb.label, readonly: mb.readonly, state: stateOf(e), editable: false };
      }
      return null;
    })
    .filter((row) => row !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function browserOf(registry: Registry, name: string): DbBrowser {
  const entry = registry.get(name);
  if (!entry) throw Object.assign(new Error(`unknown MCP: ${name}`), { status: 404 });
  const browser = entry.adapter.dbBrowser?.();
  if (!browser) {
    throw Object.assign(new Error(`MCP '${name}' (${entry.adapter.type}) has no database to browse`), { status: 404 });
  }
  return browser;
}

/** Reply with err's message, using its .status when it set one (404 for unknown MCPs). */
function fail(res: Parameters<typeof sendJson>[0], err: unknown): void {
  const status = (err as { status?: number }).status ?? 400;
  sendJson(res, status, { error: (err as Error).message });
}

/** A single edit batch is bounded so one commit stays one small transaction. */
const MAX_EDITS = 1000;

export function mountDbBrowseApi(r: Router, registry: Registry): void {
  // Which MCPs the Data view can browse (mysql/pg adapters only — anything else is absent).
  r.get("/api/db", (_req, res) => {
    sendJson(res, 200, { connections: browsableConnections(registry) });
  });

  // The lazy table list: one bounded page plus a counted total, with an optional name filter.
  r.get("/api/db/:name/tables", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      sendJson(res, 200, await b.listTables({
        grep: req.query.get("grep") || undefined,
        page: req.query.get("page"),
        limit: req.query.get("limit"),
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Cap on filters per page request — a picker the panel never exceeds, but a hand-written
   *  URL should not be able to ask for a 500-term WHERE either. */
  const MAX_FILTERS = 16;

  /** Parse the filters query param (a JSON array of {column, op, value}). Structural validation
   *  only — unknown columns/operators are refused by buildFilterWhere inside the adapter, which
   *  keeps the rule next to the SQL it guards. */
  function parseFilters(raw: string | null): BrowseFilter[] | undefined {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("filters must be a JSON array"), { status: 400 });
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_FILTERS) {
      throw Object.assign(new Error("filters must be an array of at most " + MAX_FILTERS + " terms"), { status: 400 });
    }
    return parsed as BrowseFilter[];
  }
  // One grid page: columns, rows, total, and whether (and why not) the table is editable.
  // `filters` carries the grid's field-level filters as JSON; the total counts the FILTERED set,
  // so the pager always describes what the grid is showing.
  r.get("/api/db/:name/data", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      sendJson(res, 200, await b.readTable({
        table: req.query.get("table") ?? "",
        schema: req.query.get("schema") || undefined,
        offset: req.query.get("offset"),
        limit: req.query.get("limit"),
        order: req.query.get("order") || undefined,
        dir: req.query.get("dir") || undefined,
        filters: parseFilters(req.query.get("filters")),
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  // The Structure tabs: columns, indexes, foreign keys and DDL for one table.
  r.get("/api/db/:name/schema", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      sendJson(res, 200, await b.describeTable({
        table: req.query.get("table") ?? "",
        schema: req.query.get("schema") || undefined,
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  // Whole-table export as a download (CSV or newline-JSON), capped at EXPORT_ROW_CAP rows.
  // The capped flag rides along as a header so the panel can warn without parsing the body.
  r.get("/api/db/:name/export", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      const format = req.query.get("format") === "json" ? "json" : "csv";
      const out = await b.exportTable({
        table: req.query.get("table") ?? "",
        schema: req.query.get("schema") || undefined,
        format,
        limit: req.query.get("limit"),
      });
      const name = `${out.format === "json" ? "json" : "csv"}-${req.query.get("table") ?? "table"}`;
      sendText(res, 200, out.body, out.format === "json" ? "application/x-ndjson; charset=utf-8" : "text/csv; charset=utf-8", {
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Export-Rows": String(out.rows),
        "X-Export-Capped": out.capped ? "1" : "0",
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // CSV import: header + lines + mapping arrive as JSON (the panel parsed and previewed them
  // already); the whole batch inserts inside ONE transaction on one connection.
  r.post("/api/db/:name/import", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      const body = req.body ?? {};
      const header = body.header;
      const lines = body.lines;
      const mapping = body.mapping;
      if (!Array.isArray(header) || !header.length || !header.every((h: unknown) => typeof h === "string")) {
        return sendJson(res, 400, { error: "header must be a non-empty array of column names" });
      }
      if (!Array.isArray(lines) || !lines.length || !lines.every((l: unknown) => typeof l === "string")) {
        return sendJson(res, 400, { error: "lines must be a non-empty array of CSV row strings" });
      }
      if (lines.length > IMPORT_ROW_CAP) {
        return sendJson(res, 400, { error: "too many rows for one import (max " + IMPORT_ROW_CAP + ")" });
      }
      if (!Array.isArray(mapping) || mapping.length !== header.length ||
          !mapping.every((m: unknown) => m === null || typeof m === "string")) {
        return sendJson(res, 400, { error: "mapping must be an array (one per CSV column) of column names or null" });
      }
      log("info", "data view import", { name: req.params.name, table: String(body.table ?? ""), rows: lines.length });
      const out = await b.importTable({
        table: String(body.table ?? ""),
        schema: typeof body.schema === "string" && body.schema ? body.schema : undefined,
        header,
        lines,
        mapping: mapping as ImportMapping,
      });
      sendJson(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  // --- mongo collection browser (same /api/db namespace; dialect "mongo") ------------------------

  function mongoOf(registry2: Registry, name: string): MongoBrowser {
    const entry = registry2.get(name);
    if (!entry) throw Object.assign(new Error(`unknown MCP: ${name}`), { status: 404 });
    const mb = entry.adapter.mongoBrowser?.();
    if (!mb) {
      throw Object.assign(new Error(`MCP '${name}' (${entry.adapter.type}) is not a mongo connection`), { status: 404 });
    }
    return mb;
  }

  r.get("/api/db/:name/collections", async (req, res) => {
    try {
      const mb = mongoOf(registry, req.params.name);
      sendJson(res, 200, { collections: await mb.listCollections({ grep: req.query.get("grep") || undefined }) });
    } catch (err) {
      fail(res, err);
    }
  });

  r.get("/api/db/:name/docs", async (req, res) => {
    try {
      const mb = mongoOf(registry, req.params.name);
      sendJson(res, 200, await mb.readCollection({
        collection: req.query.get("collection") ?? "",
        filterJson: req.query.get("filter") || undefined,
        offset: req.query.get("offset"),
        limit: req.query.get("limit"),
      }));
    } catch (err) {
      fail(res, err);
    }
  });
  // --- redis key browser (same /api/db namespace; dialect "redis") ------------------------------

  function redisOf(registry2: Registry, name: string): RedisBrowser {
    const entry = registry2.get(name);
    if (!entry) throw Object.assign(new Error(`unknown MCP: ${name}`), { status: 404 });
    const rb = entry.adapter.redisBrowser?.();
    if (!rb) {
      throw Object.assign(new Error(`MCP '${name}' (${entry.adapter.type}) is not a redis connection`), { status: 404 });
    }
    return rb;
  }

  // SCAN-paged key list with type + ttl per key.
  r.get("/api/db/:name/keys", async (req, res) => {
    try {
      const rb = redisOf(registry, req.params.name);
      sendJson(res, 200, await rb.listKeys({
        pattern: req.query.get("pattern") || undefined,
        cursor: req.query.get("cursor") || undefined,
        count: req.query.get("count"),
        type: req.query.get("type") || undefined,
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  // The redis command console: ONE command per call, validated by the adapter guard
  // (readonly, no KEYS, no connection/server-breaking commands) before the socket is touched.
  r.post("/api/db/:name/command", async (req, res) => {
    try {
      const rb = redisOf(registry, req.params.name);
      const line = String(req.body?.command ?? "");
      if (!line.trim()) return sendJson(res, 400, { error: "command is required" });
      sendJson(res, 200, { reply: await rb.runCommand(line) });
    } catch (err) {
      fail(res, err);
    }
  });

  // One key, read type-aware (the shape redis_read returns).
  r.get("/api/db/:name/key", async (req, res) => {
    try {
      const rb = redisOf(registry, req.params.name);
      const key = req.query.get("key") ?? "";
      if (!key) return sendJson(res, 400, { error: "key is required" });
      sendJson(res, 200, await rb.readKey(key));
    } catch (err) {
      fail(res, err);
    }
  });

  // Structure operations: rename / truncate / drop. Destructive by nature — the readonly
  // refusal happens inside the adapter, and the panel additionally demands a typed
  // confirmation before it ever posts here.
  r.post("/api/db/:name/ddl", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      const op = req.body?.op;
      if (op !== "rename" && op !== "truncate" && op !== "drop") {
        return sendJson(res, 400, { error: "op must be rename, truncate or drop" });
      }
      const name = req.params.name;
      const table = String(req.body?.table ?? "");
      log("warn", "data view ddl", { name, op, table, to: String(req.body?.to ?? "") });
      const out = await b.ddlOp({
        op,
        table,
        schema: typeof req.body?.schema === "string" && req.body.schema ? req.body.schema : undefined,
        to: typeof req.body?.to === "string" && req.body.to ? req.body.to : undefined,
      });
      sendJson(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });

  // The read-only SQL console. The browser itself enforces read-only-ness; the route just
  // forwards, so the rule cannot drift between transport and model.
  r.post("/api/db/:name/query", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      const sql = String(req.body?.sql ?? "");
      if (!sql.trim()) return sendJson(res, 400, { error: "sql is required" });
      sendJson(res, 200, await b.runQuery(sql, req.body?.limit));
    } catch (err) {
      fail(res, err);
    }
  });

  // Commit a buffered edit list. ALL statements run in one transaction on one connection —
  // the first failure rolls the whole batch back, so the grid never half-applies.
  r.post("/api/db/:name/edits", async (req, res) => {
    try {
      const b = browserOf(registry, req.params.name);
      const edits = req.body?.edits;
      if (!Array.isArray(edits) || !edits.length) {
        return sendJson(res, 400, { error: "edits must be a non-empty array" });
      }
      if (edits.length > MAX_EDITS) {
        return sendJson(res, 400, { error: `too many edits in one batch (max ${MAX_EDITS})` });
      }
      const name = req.params.name;
      const table = String(req.body?.table ?? "");
      log("info", "data view commit", { name, table, edits: edits.length });
      const out = await b.applyEdits({
        table,
        schema: typeof req.body?.schema === "string" && req.body.schema ? req.body.schema : undefined,
        edits: edits as BrowseEdit[],
      });
      sendJson(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  });
}
