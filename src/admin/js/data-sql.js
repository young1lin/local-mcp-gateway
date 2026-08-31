import { $, apiJson, el, state, toast } from "./util.js";
import { dbIsRedis } from "./data-browsers.js";
import { dbHighlightSql } from "./data-filters.js";
import { dbLoadData, renderDbGrid, renderDbToolbar } from "./data-grid.js";
import { DB_HISTORY_KEY, DB_HISTORY_MAX, dbClearSel, dbDropEdits, dbPending } from "./data-view.js";

/* --- pending-SQL preview ------------------------------------------------------------------------ */
/* The exact statements the server will run on Commit, mirrored from buildEditStatements
   (dbbrowser.ts) with values INLINED for display only — the real batch runs with bound
   parameters. Used by the bar's SQL button so "what will Commit do" is inspectable before
   it does it. */
function dbQuoteIdentSafe(name) {
  return /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : null; // same gate as the server
}

function dbSqlLiteral(v) {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function dbPendingSql() {
  var d = state.db;
  if (!d.data) return [];
  var dialect = (d.conns.find(function (c) { return c.name === d.conn; }) || {}).dialect || "mysql";
  var q = function (n) {
    var safe = dbQuoteIdentSafe(n);
    if (!safe) throw new Error("not a valid identifier: " + n);
    return dialect === "mysql" ? "`" + safe + "`" : '"' + safe + '"';
  };
  var table = (d.schema ? q(d.schema) + "." : "") + q(d.table);
  var pkCols = d.data.primaryKey || [];
  var out = [];
  Object.keys(d.deletes).forEach(function (k) {
    var pk = d.deletes[k];
    var where = pkCols.map(function (c) { return q(c) + " = " + dbSqlLiteral(pk[c]); }).join(" AND ");
    out.push("DELETE FROM " + table + " WHERE " + where + ";");
  });
  Object.keys(d.updates).forEach(function (k) {
    var e = d.updates[k];
    var set = Object.keys(e.changes).map(function (c) { return q(c) + " = " + dbSqlLiteral(e.changes[c]); }).join(", ");
    var where = pkCols.map(function (c) { return q(c) + " = " + dbSqlLiteral(e.pk[c]); }).join(" AND ");
    out.push("UPDATE " + table + " SET " + set + " WHERE " + where + ";");
  });
  d.inserts.forEach(function (ins) {
    var cols = Object.keys(ins.values);
    if (!cols.length) return;
    out.push("INSERT INTO " + table + " (" + cols.map(q).join(", ") + ") VALUES (" +
      cols.map(function (c) { return dbSqlLiteral(ins.values[c]); }).join(", ") + ");");
  });
  return out;
}
/* --- buffered edits: the commit / discard bar ---------------------------------------------------- */

function renderDbBar() {
  var d = state.db;
  var bar = $("dbBar");
  if (!bar) return;
  var n = dbPending();
  if (!n || !d.data) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.style.flexWrap = "nowrap";
  bar.innerHTML = "";
  var u = Object.keys(d.updates).length;
  var del = Object.keys(d.deletes).length;
  var ins = d.inserts.length;
  var parts = [];
  if (u) parts.push(u + " update" + (u > 1 ? "s" : ""));
  if (del) parts.push(del + " delete" + (del > 1 ? "s" : ""));
  if (ins) parts.push(ins + " insert" + (ins > 1 ? "s" : ""));
  bar.appendChild(el("span", "", parts.join(", ") + " — LOCAL ONLY, not yet in the database. Commit sends them as ONE transaction (rows addressed by primary key); Discard deletes them without a single query."));
  var sqlBtn = el("button", "btn", d.sqlPreview ? "Hide SQL" : "SQL");
  sqlBtn.title = "Show the exact statements Commit will run";
  sqlBtn.onclick = function () {
    d.sqlPreview = !d.sqlPreview;
    renderDbBar();
  };
  var discard = el("button", "btn", "Discard");
  discard.onclick = function () {
    if (!confirm("Discard " + n + " buffered change" + (n > 1 ? "s" : "") + "? Nothing has been written.")) return;
    dbDropEdits();
    renderDbGrid(); renderDbBar();
  };
  var commitBtn = el("button", "btn commit", "Commit (1 transaction)");
  commitBtn.onclick = dbCommit;
  bar.appendChild(sqlBtn);
  bar.appendChild(discard);
  bar.appendChild(commitBtn);
  if (d.sqlPreview) {
    var pre = el("pre", "db-ddl");
    pre.style.position = "static";
    pre.style.margin = "0";
    pre.style.marginTop = "var(--s2)";
    pre.style.width = "100%";
    try {
      var stmts = dbPendingSql();
      pre.innerHTML = dbHighlightSql("-- " + stmts.length + " statement" + (stmts.length > 1 ? "s" : "") +
        ", executed inside BEGIN ... COMMIT\n" + stmts.join("\n"));
    } catch (e) {
      pre.textContent = String(e && e.message ? e.message : e);
    }
    bar.style.flexWrap = "wrap";
    bar.appendChild(pre);
  }
}

async function dbCommit() {
  var d = state.db;
  if (!d.conn || !d.table || !d.data) return;
  var edits = [];
  Object.keys(d.deletes).forEach(function (k) { edits.push({ op: "delete", pk: d.deletes[k] }); });
  Object.keys(d.updates).forEach(function (k) {
    var e = d.updates[k];
    edits.push({ op: "update", pk: e.pk, changes: e.changes });
  });
  d.inserts.forEach(function (ins) { edits.push({ op: "insert", values: ins.values }); });
  if (!edits.length) return;
  // The explicit transaction gate: nothing leaves this browser until the user says so HERE too.
  // The summary names the table and counts, because "commit 3 changes" must be a decision, not a reflex.
  var ups = Object.keys(d.updates).length, dels = Object.keys(d.deletes).length, ins = d.inserts.length;
  var parts = [];
  if (ups) parts.push(ups + " update" + (ups > 1 ? "s" : ""));
  if (dels) parts.push(dels + " delete" + (dels > 1 ? "s" : ""));
  if (ins) parts.push(ins + " insert" + (ins > 1 ? "s" : ""));
  var tableLabel = (d.schema ? d.schema + "." : "") + d.table;
  if (!confirm("Commit " + parts.join(", ") + " to " + tableLabel + "?\n" +
      "One transaction: every row is addressed by its primary key, and any failure rolls the whole batch back.")) {
    return; // cancelled — the buffer stays, nothing was sent
  }
  var j = await apiJson("/api/db/" + encodeURIComponent(d.conn) + "/edits", {
    method: "POST",
    body: JSON.stringify({ table: d.table, schema: d.schema, edits: edits }),
  });
  if (!j) return; // the server rolled back; the buffer stays exactly as it was
  var affected = (j.results || []).reduce(function (a, r) { return a + (r.affected || 0); }, 0);
  toast("Committed " + edits.length + " change" + (edits.length > 1 ? "s" : "") + " · " + affected + " row" + (affected === 1 ? "" : "s") + " affected");
  dbDropEdits();
  dbLoadData(true);
}

/** EXPLAIN-prefix a console statement — same rules as withExplain on the server: idempotent,
    one trailing terminator stripped. Mirrored here because the server helper is TypeScript. */
function dbWithExplain(sql) {
  var s = sql.replace(/\s+$/, "").replace(/;\s+$/, "").replace(/\s+$/, "");
  return /^explain\b/i.test(s) ? s : "EXPLAIN " + s;
}

/* --- query history (per-browser) ---------------------------------------------------------------- */

function dbHistoryLoad() {
  try { state.db.history = JSON.parse(localStorage.getItem(DB_HISTORY_KEY)) || []; }
  catch (e) { state.db.history = []; }
}

function dbHistorySave() {
  try { localStorage.setItem(DB_HISTORY_KEY, JSON.stringify(state.db.history.slice(0, DB_HISTORY_MAX))); }
  catch (e) { /* full or blocked — history is a convenience, not state */ }
}

/** Record a successful run: newest first, a repeat of the current head is a no-op, and the
 *  list stays bounded. */
function dbHistoryPush(sql) {
  var d = state.db;
  if (d.history[0] === sql) return;
  d.history.unshift(sql);
  d.history = d.history.slice(0, DB_HISTORY_MAX);
  dbHistorySave();
  dbHistoryRender();
}

function dbHistoryRender() {
  var sel = $("dbSqlHistory");
  if (!sel) return;
  sel.innerHTML = "";
  var head = el("option", "", "History");
  head.value = "";
  sel.appendChild(head);
  state.db.history.forEach(function (sql, i) {
    var o = el("option", "", sql.replace(/\s+/g, " ").slice(0, 80));
    o.value = String(i);
    o.title = sql;
    sel.appendChild(o);
  });
}

/* --- read-only SQL console ----------------------------------------------------------------------- */

async function dbRunSql(explain) {
  var d = state.db;
  if (!d.conn) { toast("No database connection", true); return; }
  var sql = (d.sqlText || "").trim();
  if (!sql) { toast("Type a command first", true); return; }
  // The redis console: one command per run, read-only by the server-side guard.
  if (dbIsRedis()) {
    d.sqlBusy = true;
    renderDbToolbar();
    renderDbGrid();
    var cj = await apiJson("/api/db/" + encodeURIComponent(d.conn) + "/command", {
      method: "POST",
      body: JSON.stringify({ command: sql }),
    });
    d.sqlBusy = false;
    if (!cj) { d.sqlResult = null; renderDbToolbar(); renderDbGrid(); return; }
    dbClearSel(); // a new result grid starts unselected
    d.sqlResult = { columns: ["reply"], rows: [{ reply: cj.reply }], rowCount: 1, explained: false,
      note: typeof cj.reply === "object" && cj.reply && cj.reply.length != null ? cj.reply.length + " items" : undefined };
    dbHistoryPush(sql);
    renderDbToolbar();
    renderDbGrid();
    return;
  }
  // The plan view runs EXPLAIN on the same statement; withExplain is idempotent, so a query
  // that already explains itself is sent as-is.
  var toSend = explain ? dbWithExplain(sql) : sql;
  d.sqlBusy = true;
  renderDbToolbar();
  renderDbGrid();
  var j = await apiJson("/api/db/" + encodeURIComponent(d.conn) + "/query", {
    method: "POST",
    body: JSON.stringify({ sql: toSend, limit: d.pageSize }),
  });
  d.sqlBusy = false;
  if (!j) { d.sqlResult = null; renderDbToolbar(); renderDbGrid(); return; }
  dbClearSel(); // a new result grid starts unselected
  d.sqlResult = j;
  d.sqlResult.explained = !!explain;
  if (!explain) dbHistoryPush(sql); // the plan of a query is not a query — only runs are history
  renderDbToolbar();
  renderDbGrid();
}

export { dbCommit, dbHistoryLoad, dbHistoryPush, dbHistoryRender, dbHistorySave, dbPendingSql, dbQuoteIdentSafe, dbRunSql, dbSqlLiteral, dbWithExplain, renderDbBar };
