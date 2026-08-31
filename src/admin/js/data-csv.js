import { $, apiJson, el, esc, state, toast } from "./util.js";
import { closeSheet } from "./add-sheet.js";
import { dbLoadData, renderDbGrid, renderDbToolbar } from "./data-grid.js";
import { dbClearSel, dbDropEdits, dbOkToDrop, dbPending, dbPkKey } from "./data-view.js";

/* --- CSV import wizard -------------------------------------------------------------------------- */
/* Paste or upload CSV, map its columns to table columns, preview the first rows, then commit.
   The INSERT batch runs server-side in ONE transaction; a failure rolls the whole file back. */
function dbParseCsvLine(line) {
  var out = [], cur = "", inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (inQ) {
      if (c === String.fromCharCode(34) && line[i + 1] === String.fromCharCode(34)) { cur += c; i++; }
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

function dbOpenImport() {
  var d = state.db;
  if (!d.conn || !d.table || !d.data) { toast("Open a table first", true); return; }
  if (!d.data.editable) { toast("This table is not editable (" + (d.data.editNote || "read-only") + ")", true); return; }
  if (dbPending() && !dbOkToDrop()) return;
  var header = [], lines = [], mapping = [];
  $("sheet").innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Import CSV">' +
      '<div class="sheet-head"><h2>Import CSV into ' + esc((d.schema ? d.schema + "." : "") + d.table) + "</h2></div>" +
      '<div class="sheet-body">' +
        '<div class="db-console-row" style="margin-bottom:var(--s2)">' +
          '<input type="file" id="dbImpFile" accept=".csv,text/csv" style="width:auto">' +
          '<span class="hint">…or paste below (first row = header)</span>' +
        "</div>" +
        '<textarea id="dbImpText" placeholder="id,name\n1,alice\n2,bob" style="min-height:120px"></textarea>' +
        '<div id="dbImpMap" style="margin-top:var(--s3)"></div>' +
        '<div id="dbImpPreview" style="margin-top:var(--s3)"></div>' +
      "</div>" +
      '<div class="sheet-foot"><span class="grow"></span>' +
        '<button class="btn" id="dbImpCancel">Cancel</button>' +
        '<button class="btn primary" id="dbImpRun">Import (one transaction)</button></div>' +
    "</div>";
  $("sheet").hidden = false;

  function parse() {
    var text = $("dbImpText").value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var rows = text.split("\n").filter(function (l) { return l.trim() !== ""; });
    if (!rows.length) { header = []; lines = []; mapping = []; paint(); return; }
    header = dbParseCsvLine(rows[0]);
    lines = rows.slice(1, 10001); // cap mirrors IMPORT_ROW_CAP
    // default mapping: match by name, skip otherwise
    var names = d.data.columns.map(function (c) { return c.name; });
    mapping = header.map(function (h) { return names.indexOf(h) >= 0 ? h : null; });
    paint();
  }

  function paint() {
    var mapBox = $("dbImpMap");
    mapBox.innerHTML = "";
    if (!header.length) return;
    var names = d.data.columns.map(function (c) { return c.name; });
    header.forEach(function (h, i) {
      var row = el("div", "db-console-row");
      row.style.marginBottom = "2px";
      row.appendChild(el("span", "db-filter-hint", "CSV " + String.fromCharCode(34) + h + String.fromCharCode(34) + " \u2192 "));
      var sel = el("select");
      sel.style.width = "auto";
      var skip = el("option", "", "(skip)");
      skip.value = "";
      sel.appendChild(skip);
      names.forEach(function (n) {
        var o = el("option", "", n);
        o.value = n;
        o.selected = n === mapping[i];
        sel.appendChild(o);
      });
      sel.onchange = function () { mapping[i] = this.value || null; preview(); };
      row.appendChild(sel);
      mapBox.appendChild(row);
    });
    preview();
  }

  function preview() {
    var box = $("dbImpPreview");
    box.innerHTML = "";
    if (!header.length) return;
    var mapped = mapping.filter(Boolean).length;
    if (!mapped) { box.appendChild(el("div", "hint", "No columns mapped — pick at least one target column.")); return; }
    var sample = lines.slice(0, 3).map(function (l) {
      var cells = dbParseCsvLine(l);
      var o = {};
      mapping.forEach(function (m, i) { if (m) o[m] = cells[i] === "" ? null : cells[i]; });
      return o;
    });
    box.appendChild(el("div", "hint", lines.length.toLocaleString() + " row" + (lines.length > 1 ? "s" : "") +
      " \u00b7 " + mapped + " of " + header.length + " CSV columns mapped. First rows as they will be inserted:"));
    var pre = el("pre", "db-ddl");
    pre.style.position = "static";
    pre.style.margin = "var(--s1) 0 0";
    pre.textContent = sample.map(function (o) { return JSON.stringify(o); }).join("\n");
    box.appendChild(pre);
  }

  $("dbImpText").oninput = parse;
  $("dbImpFile").onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { $("dbImpText").value = String(rd.result); parse(); };
    rd.readAsText(f);
  };
  $("dbImpCancel").onclick = closeSheet;
  $("dbImpRun").onclick = async function () {
    if (!header.length || !lines.length) { toast("Paste or upload a CSV first", true); return; }
    if (!mapping.some(Boolean)) { toast("Map at least one column", true); return; }
    if (!confirm("Insert " + lines.length.toLocaleString() + " rows into " +
        (d.schema ? d.schema + "." : "") + d.table + " in ONE transaction? A failure rolls the whole file back.")) return;
    this.disabled = true;
    this.textContent = "Importing\u2026";
    var j = await apiJson("/api/db/" + encodeURIComponent(d.conn) + "/import", {
      method: "POST",
      body: JSON.stringify({ table: d.table, schema: d.schema, header: header, lines: lines, mapping: mapping }),
    });
    var btn = $("dbImpRun");
    if (btn) { btn.disabled = false; btn.textContent = "Import (one transaction)"; }
    if (!j) return; // server rolled back; the sheet stays for fixing
    toast("Imported " + j.inserted + " row" + (j.inserted > 1 ? "s" : ""));
    closeSheet();
    dbDropEdits();
    dbLoadData(true);
  };
  $("sheet").onclick = function (e) { if (e.target === $("sheet")) closeSheet(); };
}
/* --- copy to clipboard -------------------------------------------------------------------------- */
/* Right-click a cell: copy the value, or the whole row as JSON / CSV / INSERT. Values are taken
   from the CURRENT BUFFER when the cell has a pending edit, so what you copy is what you see. */
function dbCopyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { dbCopyFallback(text); });
  } else dbCopyFallback(text);
}

function dbCopyFallback(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed", true); }
  ta.remove();
}

function dbRowForCopy(row, key) {
  var d = state.db;
  var upd = d.updates[key];
  var out = {};
  d.data.columns.forEach(function (c) {
    out[c.name] = upd && Object.prototype.hasOwnProperty.call(upd.changes, c.name) ? upd.changes[c.name] : row[c.name];
  });
  return out;
}

function dbCopyCsvCell(v) {
  if (v === null || v === undefined) return "";
  var s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return String.fromCharCode(34) + s.split(String.fromCharCode(34)).join(String.fromCharCode(34) + String.fromCharCode(34)) + String.fromCharCode(34);
}

function dbCellMenu(e, row, key, column, editInDialog) {
  e.preventDefault();
  var d = state.db;
  if (!d.data) return;
  var upd = d.updates[key];
  var pending = !!upd && Object.prototype.hasOwnProperty.call(upd.changes, column);
  var value = pending ? upd.changes[column] : row ? row[column] : undefined;
  var full = row ? dbRowForCopy(row, key) : null;
  var names = d.data.columns.map(function (c) { return c.name; });
  var dialect = (d.conns.find(function (c) { return c.name === d.conn; }) || {}).dialect || "mysql";

  var menu = el("div", "ctx-menu");
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  function item(label, fn) {
    var b = el("button", "", label);
    b.onclick = function () { closeMenu2(); fn(); };
    menu.appendChild(b);
  }
  item("Copy value", function () { dbCopyText(value === null || value === undefined ? "NULL" : String(value)); });
  if (editInDialog) {
    item("Edit in dialog\u2026", editInDialog); // long text / JSON: the user-chosen dialog path
  }
  // Checked-row copies live in the SAME menu — one right-click reaches every format.
  if (!d.sqlResult) {
    var hint = dbAppendSelItems(item, dbSelectedForCopy());
    if (hint) menu.appendChild(hint);
    item("Select all on page", function () { dbSelAll(true); });
    if (Object.keys(d.sel).length) item("Clear selection", function () { dbSelAll(false); });
  }
  if (full) {
    item("Copy row as JSON", function () { dbCopyText(JSON.stringify(full, null, 2)); });
    item("Copy row as CSV", function () { dbCopyText(names.map(function (n) { return dbCopyCsvCell(full[n]); }).join(",")); });
    item("Copy row as INSERT", function () {
      try {
        var q = function (n) { return dialect === "mysql" ? "`" + n + "`" : String.fromCharCode(34) + n + String.fromCharCode(34); };
        var cols = names.filter(function (n) { return full[n] !== undefined; });
        var lit = function (v) {
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number" || typeof v === "boolean") return String(v);
          var qq = String.fromCharCode(39);
          return qq + String(v).split(qq).join(qq + qq) + qq;
        };
        var table = (d.schema ? q(d.schema) + "." : "") + q(d.table);
        dbCopyText("INSERT INTO " + table + " (" + cols.map(q).join(", ") + ") VALUES (" +
          cols.map(function (n) { return lit(full[n]); }).join(", ") + ");");
      } catch (err) { toast(String(err), true); }
    });
  }
  document.body.appendChild(menu);
  state.menuOpen = true;
  function closeMenu2() { menu.remove(); state.menuOpen = false; }
  setTimeout(function () {
    document.addEventListener("mousedown", function h(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); state.menuOpen = false; document.removeEventListener("mousedown", h); }
    });
  }, 0);
}

/* --- multi-row copy ------------------------------------------------------------------------------ */
/* Checked rows (the rowctl checkboxes) copied to the clipboard in a paste-anywhere format.
   The row list mirrors what the grid SHOWS: pending buffered edits ride along, deleted-buffered
   rows keep their original values. For a query-result grid the keys are "q" + row index. */
function dbSelectedForCopy() {
  var d = state.db;
  if (d.sqlResult) {
    var qrows = [];
    d.sqlResult.rows.forEach(function (r, i) { if (d.sel["q" + i]) qrows.push(r); });
    return { cols: d.sqlResult.columns, rows: qrows };
  }
  if (!d.data) return { cols: [], rows: [] };
  var pkCols = d.data.primaryKey || [];
  var cols = d.data.columns.map(function (c) { return c.name; });
  var rows = [];
  d.data.rows.forEach(function (row, i) {
    var key = pkCols.length ? dbPkKey(pkCols, row) : String(i);
    if (d.sel[key]) rows.push(dbRowForCopy(row, key));
  });
  return { cols: cols, rows: rows };
}

function dbFlatCell(v) {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function dbRowsCsv(sel) {
  var lines = [sel.cols.map(dbCopyCsvCell).join(",")];
  sel.rows.forEach(function (r) {
    lines.push(sel.cols.map(function (c) { return dbCopyCsvCell(r[c]); }).join(","));
  });
  return lines.join("\n");
}

function dbRowsTsv(sel) {
  var cell = function (v) { return dbFlatCell(v).replace(/\t/g, " ").replace(/\r?\n/g, " "); };
  var lines = [sel.cols.join("\t")];
  sel.rows.forEach(function (r) {
    lines.push(sel.cols.map(function (c) { return cell(r[c]); }).join("\t"));
  });
  return lines.join("\n");
}

function dbRowsMarkdown(sel) {
  var cell = function (v) { return dbFlatCell(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " "); };
  var lines = ["| " + sel.cols.join(" | ") + " |"];
  lines.push("|" + sel.cols.map(function () { return " --- |"; }).join(""));
  sel.rows.forEach(function (r) {
    lines.push("| " + sel.cols.map(function (c) { return cell(r[c]); }).join(" | ") + " |");
  });
  return lines.join("\n");
}

function dbRowsJson(sel) { return JSON.stringify(sel.rows, null, 2); }

/** Tick or clear every row on screen (the header checkbox). Keys match dbSelectedForCopy. */
function dbSelAll(on) {
  var d = state.db;
  if (d.sqlResult) {
    d.sqlResult.rows.forEach(function (r, i) {
      if (on) d.sel["q" + i] = true; else delete d.sel["q" + i];
    });
  } else if (d.data) {
    var pkCols = d.data.primaryKey || [];
    d.data.rows.forEach(function (row, i) {
      var key = pkCols.length ? dbPkKey(pkCols, row) : String(i);
      if (on) d.sel[key] = true; else delete d.sel[key];
    });
  }
  d.selAnchor = -1;
  renderDbToolbar(); renderDbGrid();
}

function dbAppendSelItems(item, sel) {
  var n = sel.rows.length;
  if (!n) {
    var hint = el("button", "ctx-hint", "No rows checked \u2014 tick boxes on the left");
    hint.disabled = true;
    // item() only makes enabled buttons; the hint is appended by the caller's menu directly
    return hint;
  }
  var noun = n + " checked row" + (n > 1 ? "s" : "");
  item("Copy " + noun + " as CSV", function () { dbCopyText(dbRowsCsv(sel)); });
  item("Copy " + noun + " as TSV", function () { dbCopyText(dbRowsTsv(sel)); });
  item("Copy " + noun + " as Markdown table", function () { dbCopyText(dbRowsMarkdown(sel)); });
  item("Copy " + noun + " as JSON", function () { dbCopyText(dbRowsJson(sel)); });
  return null;
}

/* Right-click a QUERY-RESULT cell: the value copy plus the same checked-row section.
   The row's checkbox can also be toggled from here — right-click needs no mouse travel. */
function dbResultCellMenu(e, row, column) {
  e.preventDefault();
  var d = state.db;
  var i = d.sqlResult ? d.sqlResult.rows.indexOf(row) : -1;
  var menu = el("div", "ctx-menu");
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";
  function item(label, fn) {
    var b = el("button", "", label);
    b.onclick = function () { closeMenu(); fn(); };
    menu.appendChild(b);
  }
  var v = row ? row[column] : undefined;
  item("Copy value", function () { dbCopyText(v === null || v === undefined ? "NULL" : String(v)); });
  if (i >= 0) {
    var on = !!d.sel["q" + i];
    item(on ? "Uncheck this row" : "Check this row", function () {
      if (on) delete d.sel["q" + i]; else d.sel["q" + i] = true;
      d.selAnchor = i;
      renderDbToolbar(); renderDbGrid();
    });
  }
  var hint = dbAppendSelItems(item, dbSelectedForCopy());
  if (hint) menu.appendChild(hint);
  item("Select all on page", function () { dbSelAll(true); });
  if (Object.keys(d.sel).length) item("Clear selection", function () { dbSelAll(false); });
  document.body.appendChild(menu);
  state.menuOpen = true;
  function closeMenu() { menu.remove(); state.menuOpen = false; }
  setTimeout(function () {
    document.addEventListener("mousedown", function h(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); state.menuOpen = false; document.removeEventListener("mousedown", h); }
    });
  }, 0);
}

/* --- CSV export of whatever the grid is showing --------------------------------------------------- */

function dbExportCsv() {
  var d = state.db;
  var cols, rows, name;
  if (d.sqlResult) {
    cols = d.sqlResult.columns;
    rows = d.sqlResult.rows;
    name = "query.csv";
  } else if (d.data) {
    cols = d.data.columns.map(function (c) { return c.name; });
    rows = d.data.rows;
    name = d.data.table + ".csv";
  } else return;
  function cell(v) {
    if (v === null || v === undefined) return "";
    var s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  var lines = [cols.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(",")];
  rows.forEach(function (r) {
    lines.push(cols.map(function (c) { return cell(r[c]); }).join(","));
  });
  var blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

export { dbCellMenu, dbCopyCsvCell, dbCopyFallback, dbCopyText, dbExportCsv, dbOpenImport, dbParseCsvLine, dbResultCellMenu, dbRowForCopy, dbSelAll, dbSelectedForCopy };
