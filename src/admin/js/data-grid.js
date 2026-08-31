import { $, apiJson, el, state, toast } from "./util.js";
import { dbIsMongo, dbIsRedis, dbLoadDocs, dbRenderMongoDocs, dbRenderRedisValue } from "./data-browsers.js";
import { dbCellMenu, dbExportCsv, dbOpenImport, dbResultCellMenu, dbSelAll } from "./data-csv.js";
import { dbOpenCellEditor, dbCellText } from "./data-cell.js";
import { dbEditCellEnter } from "./data-edit.js";
import { renderDbFilters } from "./data-filters.js";
import { renderDbBar } from "./data-sql.js";
import { dbRenderTabs, renderDbDetailGrid } from "./data-structure.js";
import { DB_PAGE_SIZES, dbClearSel, dbDropEdits, dbOkToDrop, dbPkKey, dbPkVals } from "./data-view.js";
import { act } from "./detail.js";

/* --- one page of rows --------------------------------------------------------------------------- */

async function dbLoadData(keepOffset) {
  var d = state.db;
  if (!d.conn || !d.table) return;
  if (!keepOffset) d.offset = 0;
  d.loading = true;
  renderDbToolbar(); renderDbGrid();
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/data?table=" + encodeURIComponent(d.table) +
    "&offset=" + d.offset + "&limit=" + d.pageSize;
  if (d.schema) q += "&schema=" + encodeURIComponent(d.schema);
  if (d.order) q += "&order=" + encodeURIComponent(d.order) + "&dir=" + d.dir;
  if (d.filters.length) q += "&filters=" + encodeURIComponent(JSON.stringify(d.filters));
  var j = await apiJson(q);
  d.loading = false;
  if (!j) { renderDbToolbar(); renderDbGrid(); return; }
  d.data = j;
  d.schema = j.schema;
  dbDropEdits(); // a fresh page is a fresh baseline — buffered edits never survive a reload
  // A filter naming a column that no longer exists would 400 on every reload — drop it instead.
  var names = d.data.columns.map(function (c) { return c.name; });
  d.filters = d.filters.filter(function (f) { return names.indexOf(f.column) >= 0; });
  renderDbToolbar(); renderDbGrid(); renderDbBar(); renderDbFilters();
}

function renderDbToolbar() {
  var d = state.db;
  var head = $("dbHead");
  if (!head) return;
  head.innerHTML = "";
  var left = el("div", "db-head-left");
  if (d.sqlResult) {
    left.appendChild(el("h2", "db-title pane-title", d.sqlResult.explained ? "Execution plan" : "SQL results"));
    left.appendChild(el("div", "db-meta", d.sqlResult.rowCount + " row" + (d.sqlResult.rowCount === 1 ? "" : "s") +
      (d.sqlResult.note ? " · " + d.sqlResult.note : "")));
  } else if (d.data) {
    left.appendChild(el("h2", "db-title pane-title", (d.data.schema ? d.data.schema + "." : "") + d.data.table));
    var bits = [d.data.total.toLocaleString() + " rows"];
    bits.push(d.data.editable ? "editable — changes buffer until Commit" : "read-only · " + (d.data.editNote || "not editable"));
    left.appendChild(el("div", "db-meta", bits.join("  ·  ")));
  } else if (dbIsRedis()) {
    left.appendChild(el("h2", "db-title pane-title", d.redisKey ? d.redisKey : "Keys"));
    var conn2 = d.conns.find(function (c) { return c.name === d.conn; });
    left.appendChild(el("div", "db-meta",
      (conn2 ? conn2.label : "") +
      (d.redis && d.redis.total != null ? " · " + Number(d.redis.total).toLocaleString() + " keys" : "") +
      " · read-only view · Command for queries"));
  } else if (dbIsMongo()) {
    left.appendChild(el("h2", "db-title pane-title", d.table ? d.table : "Collections"));
    left.appendChild(el("div", "db-meta", d.table ? (d.mongo && d.mongo.docTotal ? d.mongo.docTotal.toLocaleString() + " documents" : "Loading…") : "Select a collection on the left"));
  } else {
    left.appendChild(el("h2", "db-title pane-title", "Data"));
    left.appendChild(el("div", "db-meta", d.conn ? (d.table ? "Loading…" : "Select a table on the left") : "No database MCP registered"));
  }
  head.appendChild(left);

  var ctl = el("div", "db-head-ctl");
  var nosql = dbIsRedis() || dbIsMongo();
  if (d.data && !d.sqlResult && !nosql) dbRenderTabs(ctl);
  if (dbIsMongo() && d.table && d.mongo && d.mongo.docs) {
    // The mongo pager: same shape as the SQL one, driving docOffset.
    var from = d.mongo.docOffset + 1;
    var to = d.mongo.docOffset + d.mongo.docs.length;
    ctl.appendChild(el("span", "db-pageinfo",
      d.mongo.docTotal ? from.toLocaleString() + "–" + to.toLocaleString() + " of " + d.mongo.docTotal.toLocaleString() : "0 documents"));
    var mp = el("button", "btn icon", "\u2039");
    mp.title = "Previous page";
    mp.disabled = d.mongo.docOffset === 0;
    mp.onclick = function () { d.mongo.docOffset = Math.max(0, d.mongo.docOffset - d.pageSize); dbLoadDocs(false); };
    var mn = el("button", "btn icon", "\u203a");
    mn.title = "Next page";
    mn.disabled = to >= d.mongo.docTotal;
    mn.onclick = function () { d.mongo.docOffset += d.pageSize; dbLoadDocs(false); };
    ctl.appendChild(mp);
    ctl.appendChild(mn);
  }
  if (d.sqlResult) {
    var back = el("button", "btn", "Back to table");
    back.onclick = function () {
      d.sqlResult = null;
      dbClearSel(); // "q"-prefixed query keys must not leak into the table grid
      renderDbToolbar(); renderDbGrid();
    };
    ctl.appendChild(back);
  } else if (d.data) {
    // Row-grid controls: page size, pager, refresh, insert, CSV. Rendered on EVERY tab but hidden
    // with visibility (keeps the width) off the Data tab, so the tab segment never shifts.
    var dataCtl = el("div", "db-data-ctl");
    if (d.tab !== "data") dataCtl.style.visibility = "hidden";
    var size = el("select", "db-pagesize");
    size.title = "Rows per page";
    DB_PAGE_SIZES.forEach(function (n) {
      var o = el("option", "", String(n));
      o.value = String(n);
      o.selected = n === d.pageSize;
      size.appendChild(o);
    });
    size.onchange = function () {
      if (!dbOkToDrop()) { this.value = String(d.pageSize); return; }
      d.pageSize = Number(this.value);
      d.offset = 0;
      dbDropEdits();
      dbLoadData(true);
    };
    dataCtl.appendChild(size);

    var first = d.offset + 1;
    var to = d.offset + d.data.rows.length;
    dataCtl.appendChild(el("span", "db-pageinfo",
      d.data.total ? first.toLocaleString() + "–" + to.toLocaleString() + " of " + d.data.total.toLocaleString() : "0 rows"));
    var prev = el("button", "btn icon", "‹");
    prev.title = "Previous page";
    prev.disabled = d.offset === 0;
    prev.onclick = function () {
      if (!dbOkToDrop()) return;
      d.offset = Math.max(0, d.offset - d.pageSize);
      dbDropEdits();
      dbLoadData(true);
    };
    var next = el("button", "btn icon", "›");
    next.title = "Next page";
    next.disabled = to >= d.data.total;
    next.onclick = function () {
      if (!dbOkToDrop()) return;
      d.offset += d.pageSize;
      dbDropEdits();
      dbLoadData(true);
    };
    dataCtl.appendChild(prev);
    dataCtl.appendChild(next);

    var refresh = el("button", "btn", "Refresh");
    refresh.title = "Reload this page (drops buffered edits)";
    refresh.onclick = function () {
      if (!dbOkToDrop()) return;
      dbDropEdits();
      dbLoadData(true);
    };
    dataCtl.appendChild(refresh);

    if (d.data.editable) {
      var addRow = el("button", "btn", "+ Row");
      addRow.title = "Buffer a new row — inserted only on Commit";
      addRow.onclick = function () {
        d.inserts.push({ values: {} });
        renderDbGrid(); renderDbBar();
      };
      dataCtl.appendChild(addRow);
    }

    var csv = el("button", "btn", "CSV");
    csv.title = "Download the current page as CSV";
    csv.onclick = dbExportCsv;
    dataCtl.appendChild(csv);

    var exp = el("button", "btn", "Export…");
    exp.title = "Export the whole table (capped at 100k rows)";
    exp.onclick = async function () {
      var d2 = state.db;
      var fmt = "csv";
      if (!confirm("Export " + (d2.schema ? d2.schema + "." : "") + d2.table + " as " + fmt.toUpperCase() +
          "?\nCapped at 100,000 rows — filter first if you need less.")) return;
      var q = "/api/db/" + encodeURIComponent(d2.conn) + "/export?table=" + encodeURIComponent(d2.table) +
        "&format=" + fmt;
      if (d2.schema) q += "&schema=" + encodeURIComponent(d2.schema);
      this.textContent = "Exporting\u2026";
      try {
        var resp = await fetch(q);
        if (!resp.ok) { toast("Export failed: HTTP " + resp.status, true); return; }
        var blob = await resp.blob();
        var disp = resp.headers.get("Content-Disposition") || "";
        var m = /filename="([^"]+)"/.exec(disp);
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : "export.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        var rows = resp.headers.get("X-Export-Rows");
        toast("Exported " + (rows != null ? Number(rows).toLocaleString() + " rows" : ""));
      } catch (e) {
        toast("Export failed", true);
      } finally {
        this.textContent = "Export\u2026";
      }
    };
    dataCtl.appendChild(exp);

    if (d.data.editable) {
      var imp = el("button", "btn", "Import\u2026");
      imp.title = "Insert CSV rows in one transaction";
      imp.onclick = dbOpenImport;
      dataCtl.appendChild(imp);
    }
    ctl.appendChild(dataCtl);
  }
  var sql = el("button", "btn", d.sqlOpen ? (nosql ? "Hide Command" : "Hide SQL") : (nosql ? "Command" : "SQL"));
  sql.title = nosql ? "Run a read-only command (GET, HGETALL, LRANGE, TTL, TYPE…)" : "Read-only SQL console";
  sql.onclick = function () {
    d.sqlOpen = !d.sqlOpen;
    var con = $("dbConsole");
    if (con) con.hidden = !d.sqlOpen;
    sql.textContent = d.sqlOpen ? (nosql ? "Hide Command" : "Hide SQL") : (nosql ? "Command" : "SQL");
    if (d.sqlOpen && $("dbSql")) $("dbSql").focus();
  };
  ctl.appendChild(sql);
  head.appendChild(ctl);
}

function dbPaintCell(td, v, has) {
  if (!has || v === undefined) return; // nothing set yet (an insert stub cell)
  if (v === null) { td.appendChild(el("span", "db-null", "NULL")); return; }
  td.textContent = dbCellText(v);
}

/* --- column header hover card -------------------------------------------------------------------- */

var dbTip = { node: null, timer: 0 };

function dbTipHide() {
  if (dbTip.node) { dbTip.node.remove(); dbTip.node = null; }
}

/** The header's hover card, in the panel's own chrome rather than the OS tooltip: name, the
 *  type/nullability line, the FULL comment (the header caption truncates; this never does) and
 *  the sort hint. Fixed under the th and clamped to the viewport; pointer-events none so it can
 *  never steal the hover it is explaining. */
function dbTipShow(th, c) {
  var tip = el("div", "db-tip");
  tip.appendChild(el("div", "t-name", c.name));
  tip.appendChild(el("div", "t-type", c.dataType + (c.nullable ? " · nullable" : " · not null") +
    (c.isPrimaryKey ? " · primary key" : "")));
  if (c.comment) tip.appendChild(el("div", "t-comment", c.comment));
  tip.appendChild(el("div", "t-hint", "Click sorts: ascending → descending → off"));
  document.body.appendChild(tip);
  var r = th.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8)) + "px";
  tip.style.top = (r.bottom + 6) + "px";
  dbTip.node = tip;
}

// The card is fixed to the viewport, so a scrolled grid leaves it pointing nowhere — dismiss on
// any scroll, capture phase, once for the module's lifetime.
document.addEventListener("scroll", dbTipHide, true);


function renderDbGrid() {
  var d = state.db;
  var wrap = $("dbGridWrap");
  if (!wrap) return;
  var con = $("dbConsole");
  if (con) con.hidden = !d.sqlOpen;
  wrap.innerHTML = "";
  dbTipHide(); // a rebuilt grid invalidates any header card still open

  if (d.sqlResult || d.sqlBusy) { renderDbResultGrid(wrap); return; }
  if (dbIsRedis()) { dbRenderRedisValue(wrap); return; }
  if (dbIsMongo()) { dbRenderMongoDocs(wrap); return; }
  if (d.tab !== "data") { renderDbDetailGrid(wrap); return; }
  if (!d.conn) { wrap.appendChild(el("div", "db-hint", "No database MCP registered — add a mysql or pg MCP first.")); return; }
  if (!d.table || !d.data) {
    wrap.appendChild(el("div", "db-hint", d.table ? "Loading…" : "Select a table on the left to browse its rows."));
    return;
  }
  if (d.loading) { wrap.appendChild(el("div", "db-hint", "Loading…")); return; }

  var pkCols = d.data.primaryKey || [];
  var editable = d.data.editable;

  var tbl = el("table", "db-grid");
  var thead = el("thead");
  var hr = el("tr");
  var keyOf = function (row, i) { return pkCols.length ? dbPkKey(pkCols, row) : String(i); };
  var thAll = el("th", "db-rowctl");
  var allOn = d.data.rows.length > 0 && d.data.rows.every(function (row, i) { return !!d.sel[keyOf(row, i)]; });
  var cbAll = document.createElement("input");
  cbAll.type = "checkbox";
  cbAll.className = "db-selbox";
  cbAll.checked = allOn;
  cbAll.title = "Select every row on this page (for copy)";
  cbAll.onclick = function (e) { e.stopPropagation(); };
  cbAll.onchange = function () { dbSelAll(this.checked); };
  thAll.appendChild(cbAll);
  hr.appendChild(thAll);
  // One caption line under every column name when ANY column carries a comment: the meaning is
  // then ON the grid instead of hidden behind a hover, and giving every header the line (empty
  // where there is nothing to say) keeps the header row one even height.
  var hasComments = d.data.columns.some(function (c) { return !!c.comment; });
  d.data.columns.forEach(function (c) {
    var sorted = c.name === d.order;
    var th = el("th", "db-col" + (sorted ? " db-sorted" + (d.dir === "desc" ? " db-sorted-desc" : "") : ""));
    var main = el("div", "db-col-main");
    main.appendChild(el("span", "db-col-name", c.name));
    if (c.isPrimaryKey) main.appendChild(el("span", "db-key", "⚿"));
    main.appendChild(el("span", "db-col-type", c.dataType));
    if (sorted) main.appendChild(el("span", "db-sort"));
    th.appendChild(main);
    if (hasComments) th.appendChild(el("div", "db-col-comment", c.comment || ""));
    th.onmouseenter = function () {
      clearTimeout(dbTip.timer);
      dbTip.timer = setTimeout(function () { dbTipShow(th, c); }, 260);
    };
    th.onmouseleave = function () { clearTimeout(dbTip.timer); dbTipHide(); };
    th.onclick = function () {
      dbTipHide();
      if (!dbOkToDrop()) return;
      var next = dbNextSort(d.order, d.dir, c.name);
      d.order = next ? next.order : null;
      d.dir = next ? next.dir : "asc";
      d.offset = 0;
      dbDropEdits();
      dbLoadData(true);
    };
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  tbl.appendChild(thead);

  var tbody = el("tbody");

  // Buffered inserts first, so they read as "the row you are about to add".
  d.inserts.forEach(function (ins, i) {
    var tr = el("tr", "db-ins");
    var rc = el("td", "db-rowctl");
    var rm = el("button", "db-act", "✕");
    rm.title = "Remove this buffered insert";
    rm.onclick = function () {
      d.inserts.splice(i, 1);
      renderDbGrid(); renderDbBar();
    };
    rc.appendChild(rm);
    tr.appendChild(rc);
    d.data.columns.forEach(function (c) {
      var has = Object.prototype.hasOwnProperty.call(ins.values, c.name);
      var td = el("td", "db-cell");
      dbPaintCell(td, has ? ins.values[c.name] : undefined, has);
      if (editable) {
        td.classList.add("db-cell-edit");
        td.title = "Double-click to edit · right-click for dialog/copy";
        (function (col, present) {
          td.ondblclick = function () {
            var cur = present ? dbCellText(ins.values[col]) : "";
            dbEditCellEnter("insert", null, i, col, {}, td, cur == null ? "" : cur);
          };
          td.oncontextmenu = function (e) { dbCellMenu(e, null, null, col, null, function () { dbOpenCellEditor("insert", null, i, col, {}); }); };
        })(c.name, has);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  d.data.rows.forEach(function (row, rowIdx) {
    var key = keyOf(row, rowIdx);
    var deleted = !!d.deletes[key];
    var upd = d.updates[key];
    var tr = el("tr", (deleted ? "db-del " : "") + (d.sel[key] ? "db-sel" : ""));
    var rc = el("td", "db-rowctl");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "db-selbox";
    cb.checked = !!d.sel[key];
    cb.title = "Select row for copy (Shift-click for a range)";
    cb.onclick = function (e) { e.stopPropagation(); };
    cb.onchange = function (ev) {
      if (ev.shiftKey && d.selAnchor >= 0 && d.selAnchor !== rowIdx) {
        var a = Math.min(d.selAnchor, rowIdx);
        var b2 = Math.max(d.selAnchor, rowIdx);
        for (var k = a; k <= b2; k++) d.sel[keyOf(d.data.rows[k], k)] = true;
      } else if (this.checked) d.sel[key] = true;
      else delete d.sel[key];
      d.selAnchor = rowIdx;
      renderDbToolbar(); renderDbGrid();
    };
    rc.appendChild(cb);
    if (editable) {
      var b = el("button", "db-act", deleted ? "↩" : "✕");
      b.title = deleted ? "Undo this buffered delete" : "Buffer a delete — applied only on Commit";
      b.onclick = function () {
        if (deleted) delete d.deletes[key];
        else {
          d.deletes[key] = dbPkVals(pkCols, row);
          delete d.updates[key]; // a deleted row's cell edits are moot
        }
        renderDbGrid(); renderDbBar();
      };
      rc.appendChild(b);
    }
    tr.appendChild(rc);
    d.data.columns.forEach(function (c) {
      var orig = row[c.name];
      var pending = !!upd && Object.prototype.hasOwnProperty.call(upd.changes, c.name);
      var v = pending ? upd.changes[c.name] : orig;
      var td = el("td", "db-cell" + (pending ? " db-dirty" : ""));
      dbPaintCell(td, v, true);
      if (editable && !deleted) {
        td.classList.add("db-cell-edit");
        td.title = "Double-click to edit · right-click for dialog/copy";
        (function (col, orig) {
          var meta = { pk: dbPkVals(pkCols, row), orig: orig };
          td.ondblclick = function () {
            var cur = dbCellText(orig);
            dbEditCellEnter("update", key, -1, col, meta, td, cur == null ? "" : cur);
          };
          td.oncontextmenu = function (e) {
            dbCellMenu(e, row, key, col, function () { dbOpenCellEditor("update", key, -1, col, meta); });
          };
        })(c.name, orig);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}

function renderDbResultGrid(wrap) {
  var d = state.db;
  if (d.sqlBusy) { wrap.appendChild(el("div", "db-hint", "Running…")); return; }
  var res = d.sqlResult;
  if (!res) { wrap.appendChild(el("div", "db-hint", "Run a query to see rows here.")); return; }
  var tbl = el("table", "db-grid");
  var thead = el("thead");
  var hr = el("tr");
  var thAll2 = el("th", "db-rowctl");
  var allOn2 = res.rows.length > 0 && res.rows.every(function (_, i) { return !!d.sel["q" + i]; });
  var cbAll2 = document.createElement("input");
  cbAll2.type = "checkbox";
  cbAll2.className = "db-selbox";
  cbAll2.checked = allOn2;
  cbAll2.title = "Select every result row (for copy)";
  cbAll2.onclick = function (e) { e.stopPropagation(); };
  cbAll2.onchange = function () { dbSelAll(this.checked); };
  thAll2.appendChild(cbAll2);
  hr.appendChild(thAll2);
  res.columns.forEach(function (c) { hr.appendChild(el("th", "db-col", c)); });
  thead.appendChild(hr);
  tbl.appendChild(thead);
  var tbody = el("tbody");
  res.rows.forEach(function (row, i) {
    var qkey = "q" + i;
    var tr = el("tr", d.sel[qkey] ? "db-sel" : "");
    var rc2 = el("td", "db-rowctl");
    var cb2 = document.createElement("input");
    cb2.type = "checkbox";
    cb2.className = "db-selbox";
    cb2.checked = !!d.sel[qkey];
    cb2.title = "Select row for copy (Shift-click for a range)";
    cb2.onclick = function (e) { e.stopPropagation(); };
    cb2.onchange = function (ev) {
      if (ev.shiftKey && d.selAnchor >= 0 && d.selAnchor !== i) {
        var a2 = Math.min(d.selAnchor, i);
        var b3 = Math.max(d.selAnchor, i);
        for (var k2 = a2; k2 <= b3; k2++) d.sel["q" + k2] = true;
      } else if (this.checked) d.sel[qkey] = true;
      else delete d.sel[qkey];
      d.selAnchor = i;
      renderDbToolbar(); renderDbGrid();
    };
    rc2.appendChild(cb2);
    rc2.appendChild(document.createTextNode(String(i + 1)));
    tr.appendChild(rc2);
    res.columns.forEach(function (c) {
      var td = el("td", "db-cell");
      td.oncontextmenu = function (e) { dbResultCellMenu(e, row, c); };
      var v = row[c];
      if (v === null || v === undefined) td.appendChild(el("span", "db-null", "NULL"));
      else td.textContent = dbCellText(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}

/** The three-state cycle a header click walks: a fresh column sorts ascending, the next click
    flips to descending, and a third click clears the order (null) back to the table's natural
    order. Pure so the cycle can be tested without a DOM. */
function dbNextSort(order, dir, name) {
  if (order !== name) return { order: name, dir: "asc" };
  if (dir === "desc") return null;
  return { order: name, dir: "desc" };
}

export { dbLoadData, dbNextSort, dbPaintCell, renderDbGrid, renderDbResultGrid, renderDbToolbar };
