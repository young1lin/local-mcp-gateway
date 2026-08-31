import { $, apiJson, el, state } from "./util.js";
import { dbIsMongo, dbIsRedis, dbLoadCollections, dbLoadKeys, dbLoadRedisValue, dbOpenMongo } from "./data-browsers.js";
import { dbSqlPaint } from "./data-filters.js";
import { dbLoadData, renderDbGrid, renderDbToolbar } from "./data-grid.js";
import { dbHistoryLoad, dbHistoryRender, dbRunSql, renderDbBar } from "./data-sql.js";

/* ================================================================================================
   Data view — a DBeaver-style browser over the mysql/pg MCPs.
   Left: a lazy, greppable, paged table list (never the whole instance at once). Right: one
   bounded page of rows (10/20/50/100/200/500, default 500) with click-to-sort headers.
   Edits are buffered client-side — an amber bar counts them — and nothing reaches the database
   until Commit posts the whole buffer as ONE transaction; Discard drops it without a query.
   Same rendering contract as everywhere else: the 6s poll never rebuilds this view.
   ================================================================================================ */

var DB_PAGE_SIZES = [10, 20, 50, 100, 200, 500];
var DB_HISTORY_KEY = "mcp_gateway_db_sql_history";
var DB_HISTORY_MAX = 50;

state.db = {
  conns: [],            // rows from /api/db
  conn: null,           // selected connection (MCP name)
  tables: [],           // ONE page of the table list
  tablesTotal: 0, tablesPage: 0, tablesLimit: 200, more: false, grep: "",
  table: null, schema: null,
  data: null,           // last /api/db/:name/data page
  filters: [],          // [{ column, op, value }] — server-side WHERE terms (AND-ed)
  pageSize: 50, offset: 0, order: null, dir: "asc", loading: false,
  sqlPreview: false,    // pending bar: show the SQL Commit will run
  updates: {},          // pkKey -> { pk, changes: { col: value-or-null } }
  deletes: {},          // pkKey -> pk object
  inserts: [],          // [{ values: { col: value-or-null } }]
  sel: {},             // rowKey -> true — checked rows the next Copy pulls (grid or query result)
  selAnchor: -1,       // visible row index of the last checkbox click (Shift range start)
  sqlOpen: false, sqlText: "", sqlResult: null, sqlBusy: false,
  history: [],         // last-run console queries, newest first (per-browser, localStorage)
  tab: "data",        // data | columns | indexes | ddl | fks — the Structure tabs
  redis: null,         // { keys, cursor, done, total } while a redis connection is selected
  mongo: null,         // { collections, docs, docTotal, docOffset, filter } while mongo is selected
  redisKey: null,      // the key whose value is shown in the pane
  detail: null,       // last /api/db/:name/schema answer (BrowseTableDetail)
  detailBusy: false,
};

function dbPending() {
  var d = state.db;
  return Object.keys(d.updates).length + Object.keys(d.deletes).length + d.inserts.length;
}

/** Ask before an action would drop buffered edits; false when the user said no. */
function dbOkToDrop() {
  var n = dbPending();
  return !n || confirm("Discard " + n + " uncommitted change" + (n > 1 ? "s" : "") + "? Nothing has been written yet.");
}

function dbDropEdits() {
  var d = state.db;
  d.updates = {}; d.deletes = {}; d.inserts = [];
  dbClearSel(); // selection addresses rows of the OLD page — it never survives a reload
  d.sqlPreview = false;
}

/** Row selection is scoped to what is on screen: cleared whenever the grid identity changes. */
function dbClearSel() {
  var d = state.db;
  d.sel = {};
  d.selAnchor = -1;
}

function dbPkKey(pkCols, row) {
  return JSON.stringify(pkCols.map(function (c) { return row[c]; }));
}

function dbPkVals(pkCols, row) {
  var out = {};
  pkCols.forEach(function (c) { out[c] = row[c]; });
  return out;
}

/* --- view skeleton ------------------------------------------------------------------------------- */

async function loadDbView() {
  renderDbView();
  var j = await apiJson("/api/db");
  if (!j) return;
  var d = state.db;
  d.conns = j.connections || [];
  var stillThere = d.conns.some(function (c) { return c.name === d.conn; });
  if (!stillThere) {
    d.conn = d.conns.length ? d.conns[0].name : null;
    d.table = null; d.schema = null; d.data = null; d.tables = [];
    d.redis = null; d.redisKey = null; d.redisValue = null; d.mongo = null;
    d.sqlResult = null;
    dbDropEdits();
  }
  renderDbSide();
  renderDbToolbar();
  // A refresh re-fetches what is MISSING, not what is already on screen — reloading keys would
  // throw away the pages the user paged in with "More".
  if (d.conn && dbIsRedis()) { if (!d.redis) dbLoadKeys(true); else renderDbTables(); }
  else if (d.conn && dbIsMongo()) { if (!d.mongo || !d.mongo.collections.length) dbLoadCollections(); else renderDbTables(); }
  else if (d.conn) { if (!d.tables.length) dbLoadTables(); else renderDbTables(); }
  else renderDbTables();
  if (d.table && !d.data && !dbIsRedis() && !dbIsMongo()) dbLoadData(true);
}

function renderDbView() {
  var pane = $("pane");
  pane.innerHTML = "";
  var root = el("div", "db-root");
  root.innerHTML =
    '<div class="db-side">' +
      '<select id="dbConn" aria-label="Connection"></select>' +
      '<input id="dbGrep" type="search" placeholder="Filter tables" aria-label="Filter tables">' +
      '<div class="db-tables" id="dbTables"><div class="db-hint">Loading…</div></div>' +
      '<div class="db-side-foot" id="dbTablesPager"></div>' +
    '</div>' +
    '<div class="db-main">' +
      '<div class="db-head" id="dbHead"></div>' +
      '<div class="db-filters" id="dbFilters"></div>' +
      '<div class="db-console" id="dbConsole" hidden>' +
        '<div class="db-sql-wrap">' +
          '<pre class="db-sql-hl db-sql-face" id="dbSqlHl" aria-hidden="true"></pre>' +
          '<textarea class="db-sql-face" id="dbSql" placeholder="SELECT … — read-only, results capped at the page size" spellcheck="false"></textarea>' +
        '</div>' +
        '<div class="db-console-row"><button class="btn" id="dbSqlRun">Run</button>' +
        '<button class="btn" id="dbSqlExplain">Explain</button>' +
        '<select id="dbSqlHistory" title="Query history"><option value="">History</option></select>' +
        '<span class="hint" id="dbSqlHint">read-only · Ctrl+Enter runs</span></div>' +
      '</div>' +
      '<div class="db-grid-wrap" id="dbGridWrap"></div>' +
      '<div class="db-bar" id="dbBar" hidden></div>' +
    '</div>';
  pane.appendChild(root);
  $("dbConn").onchange = function () {
    if (this.value === state.db.conn) return;
    if (!dbOkToDrop()) { this.value = state.db.conn; return; }
    var d = state.db;
    d.conn = this.value; d.table = null; d.schema = null; d.data = null;
    d.tables = []; d.tablesPage = 0; d.order = null; d.sqlResult = null;
    d.redis = null; d.redisKey = null; d.redisValue = null;
    d.mongo = null; d.filters = [];
    // A sidebar search is table-list-scoped: carrying "tsys_" from one connection into the next
    // silently filters the new list down to nothing. Reset it and the box that shows it.
    d.grep = "";
    var gb = $("dbGrep");
    if (gb) gb.value = "";
    dbDropEdits();
    renderDbTables(); renderDbToolbar(); renderDbGrid(); renderDbBar();
    if (dbIsRedis()) dbLoadKeys(true);
    else if (dbIsMongo()) dbLoadCollections();
    else dbLoadTables();
  };
  // The view is REBUILT on every entry, but d.grep persists for the same table — seed the box
  // from state, or the list stays filtered by a term the (fresh, empty) input no longer shows.
  $("dbGrep").value = state.db.grep || "";
  var t;
  $("dbGrep").oninput = function () {
    var v = this.value;
    clearTimeout(t);
    t = setTimeout(function () {
      state.db.grep = v; state.db.tablesPage = 0;
      if (dbIsRedis()) dbLoadKeys(true);
      else if (dbIsMongo()) dbLoadCollections();
      else dbLoadTables();
    }, 300);
  };
  $("dbSql").value = state.db.sqlText;
  $("dbSql").oninput = function () { state.db.sqlText = this.value; dbSqlPaint(); };
  $("dbSql").onscroll = function () {
    var hl = $("dbSqlHl");
    if (hl) { hl.scrollTop = this.scrollTop; hl.scrollLeft = this.scrollLeft; }
  };
  $("dbSql").onkeydown = function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); dbRunSql(); }
  };
  dbSqlPaint();
  var isRedis2 = dbIsRedis();
  if (isRedis2) {
    $("dbSql").placeholder = "GET mykey · HGETALL myhash · LRANGE mylist 0 -1 · TTL mykey — read-only";
    $("dbSqlExplain").hidden = true; // EXPLAIN is SQL; a redis command has no plan
    var hint = $("dbSqlHint");
    if (hint) hint.textContent = "read-only · KEYS is refused, use the key list · Ctrl+Enter runs";
  }
  // wrapped: onclick hands the handler the click EVENT, and dbRunSql's first parameter is
  // `explain` — an event object is truthy, so a plain Run has been quietly running EXPLAIN.
  $("dbSqlRun").onclick = function () { dbRunSql(false); };
  $("dbSqlExplain").onclick = function () { dbRunSql(true); };
  $("dbSqlHistory").onchange = function () {
    if (this.value === "") return;
    var sql = state.db.history[Number(this.value)];
    this.value = ""; // back to the label, so the same entry can be picked again
    if (sql == null) return;
    state.db.sqlText = sql;
    var ta = $("dbSql");
    if (ta) { ta.value = sql; dbSqlPaint(); ta.focus(); }
  };
  dbHistoryLoad();
  dbHistoryRender();
  renderDbToolbar(); renderDbGrid(); renderDbBar();
}

function renderDbSide() {
  var d = state.db;
  var sel = $("dbConn");
  if (!sel) return;
  sel.innerHTML = "";
  if (!d.conns.length) {
    var none = el("option", "", "No database MCPs");
    none.value = "";
    sel.appendChild(none);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  d.conns.forEach(function (c) {
    var o = el("option", "", c.name + " · " + c.dialect + (c.readonly ? " · read-only" : ""));
    o.value = c.name;
    o.selected = c.name === d.conn;
    sel.appendChild(o);
  });
}

/* --- lazy table list ---------------------------------------------------------------------------- */

async function dbLoadTables() {
  var d = state.db;
  if (!d.conn) return;
  var box = $("dbTables");
  if (box) { box.innerHTML = ""; box.appendChild(el("div", "db-hint", "Loading…")); }
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/tables?page=" + d.tablesPage;
  if (d.grep) q += "&grep=" + encodeURIComponent(d.grep);
  var j = await apiJson(q);
  if (!j) { if ($("dbTables")) $("dbTables").innerHTML = ""; return; }
  d.tables = j.tables || [];
  d.tablesTotal = j.total || 0;
  d.tablesLimit = j.limit || 200;
  d.more = !!j.more;
  renderDbTables();
}

function renderDbTables() {
  var d = state.db;
  var box = $("dbTables");
  if (!box) return;
  box.innerHTML = "";
  if (!d.conn) {
    box.appendChild(el("div", "db-hint", "Add a mysql or pg MCP, then browse it here."));
    return;
  }
  if (dbIsMongo()) {
    var mo = d.mongo;
    if (!mo || !mo.collections.length) {
      box.appendChild(el("div", "db-hint", d.grep ? 'No collections match "' + d.grep + '"' : "No collections."));
    }
    (mo ? mo.collections : []).forEach(function (c) {
      var b = el("button", "db-table" + (c.name === d.table ? " sel" : ""));
      b.appendChild(el("div", "db-table-name", c.name));
      b.appendChild(el("div", "db-table-meta",
        c.type + (c.approxDocs != null ? " · ~" + Number(c.approxDocs).toLocaleString() + " docs" : "") +
        (c.size ? " · " + c.size : "")));
      b.onclick = function () { dbOpenMongo(c.name); };
      box.appendChild(b);
    });
    var foot3 = $("dbTablesPager");
    if (foot3) {
      foot3.innerHTML = "";
      foot3.appendChild(el("span", "", (mo ? mo.collections.length : 0) + " collections"));
    }
    return;
  }
  if (dbIsRedis()) {
    var rr = d.redis;
    if (!rr || !rr.keys.length) {
      box.appendChild(el("div", "db-hint", d.grep ? 'No keys match "' + d.grep + '"' : "No keys yet — scan returned none."));
    }
    (rr ? rr.keys : []).forEach(function (k) {
      var b = el("button", "db-table" + (k.key === d.redisKey ? " sel" : ""));
      b.appendChild(el("div", "db-table-name", k.key));
      var meta = k.type;
      if (k.ttl >= 0) meta += " · ttl " + k.ttl + "s";
      b.appendChild(el("div", "db-table-meta", meta));
      b.onclick = function () { dbLoadRedisValue(k.key); };
      box.appendChild(b);
    });
    var foot2 = $("dbTablesPager");
    if (foot2) {
      foot2.innerHTML = "";
      var shown = rr ? rr.keys.length : 0;
      foot2.appendChild(el("span", "", shown.toLocaleString() + (rr && rr.total != null ? " of " + Number(rr.total).toLocaleString() + " keys" : " keys")));
      if (rr && !rr.done) {
        var more = el("button", "btn", "More");
        more.title = "Continue the SCAN";
        more.onclick = function () { dbLoadKeys(false); };
        foot2.appendChild(more);
      }
    }
    return;
  }
  if (!d.tables.length) {
    box.appendChild(el("div", "db-hint", d.grep ? 'No tables match "' + d.grep + '".' : "No tables."));
  }
  d.tables.forEach(function (t) {
    var b = el("button", "db-table" + (t.name === d.table && t.schema === d.schema ? " sel" : ""));
    b.appendChild(el("div", "db-table-name", t.name));
    b.appendChild(el("div", "db-table-meta",
      t.type + (t.approxRows != null ? " · ~" + Number(t.approxRows).toLocaleString() + " rows" : "") +
      (t.size ? " · " + t.size : "")));
    b.onclick = function () { dbOpenTable(t); };
    box.appendChild(b);
  });
  var foot = $("dbTablesPager");
  if (!foot) return;
  foot.innerHTML = "";
  var from = d.tablesTotal ? d.tablesPage * d.tablesLimit + 1 : 0;
  var to = d.tablesPage * d.tablesLimit + d.tables.length;
  foot.appendChild(el("span", "", from.toLocaleString() + "–" + to.toLocaleString() + " of " + d.tablesTotal.toLocaleString()));
  var prev = el("button", "btn icon", "‹");
  prev.title = "Previous page of tables";
  prev.disabled = d.tablesPage === 0;
  prev.onclick = function () { d.tablesPage--; dbLoadTables(); };
  var next = el("button", "btn icon", "›");
  next.title = "Next page of tables";
  next.disabled = !d.more;
  next.onclick = function () { d.tablesPage++; dbLoadTables(); };
  foot.appendChild(prev);
  foot.appendChild(next);
}

function dbOpenTable(t) {
  var d = state.db;
  if (t.name === d.table && t.schema === d.schema) return;
  if (!dbOkToDrop()) return;
  d.table = t.name; d.schema = t.schema;
  d.offset = 0; d.order = null; d.dir = "asc"; d.filters = [];
  d.tab = "data"; d.detail = null;
  d.sqlResult = null;
  dbDropEdits();
  renderDbTables();
  dbLoadData();
}

export { DB_HISTORY_KEY, DB_HISTORY_MAX, DB_PAGE_SIZES, dbClearSel, dbDropEdits, dbLoadTables, dbOkToDrop, dbOpenTable, dbPending, dbPkKey, dbPkVals, loadDbView, renderDbSide, renderDbTables, renderDbView };
