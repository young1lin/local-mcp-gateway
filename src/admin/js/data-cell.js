import { $, esc, state, toast } from "./util.js";
import { closeSheet } from "./add-sheet.js";
import { renderDbGrid } from "./data-grid.js";
import { renderDbBar } from "./data-sql.js";

/* --- cell editor dialog ------------------------------------------------------------------------- */
/* Editing happens in a sheet, never inline: an inline input grows its row and reshuffles the
   whole grid mid-edit, and a 4 KB JSON cell has no business in a 30px row anyway. The dialog
   knows what it is editing (table, column, PK address), offers NULL / one-line / text / JSON,
   and Save only writes the LOCAL buffer — Commit is still the only door to the database. */
var dbCellEdit = null; // { kind: "update"|"insert", key, i, column, meta } while the sheet is open

function dbCellJsonLike(s) {
  var t = String(s == null ? "" : s).trim();
  return t.startsWith("{") || t.startsWith("[");
}

/** Try pretty-printing; on invalid JSON return null (the editor stays in plain-text mode). */
function dbCellPretty(s) {
  try { return JSON.stringify(JSON.parse(String(s)), null, 2); } catch (e) { return null; }
}

function dbOpenCellEditor(kind, key, i, column, meta) {
  var d = state.db;
  if (!d.data || !d.data.editable) return;
  var isNull = false;
  var text = "";
  if (kind === "update") {
    var e = d.updates[key];
    var pending = e && Object.prototype.hasOwnProperty.call(e.changes, column);
    var v = pending ? e.changes[column] : meta.orig;
    isNull = pending ? v === null : meta.orig === null || meta.orig === undefined;
    text = isNull ? "" : dbCellText(v);
  } else {
    var ins = d.inserts[i];
    var has = Object.prototype.hasOwnProperty.call(ins.values, column);
    isNull = has ? ins.values[column] === null : false;
    text = has && ins.values[column] !== null ? dbCellText(ins.values[column]) : "";
  }
  var pretty = dbCellJsonLike(text) ? dbCellPretty(text) : null;
  var colMeta = d.data.columns.find(function (c) { return c.name === column; }) || {};
  var isBool = /bool/i.test(colMeta.dataType || "");
  dbCellEdit = { kind: kind, key: key, i: i, column: column, meta: meta };

  $("sheet").innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Edit cell">' +
      '<div class="sheet-head"><div class="db-cell-head">' +
        "<h2>" + esc(column) + '</h2>' +
        '<span class="db-cell-where">' + esc((d.schema ? d.schema + "." : "") + d.table +
          (kind === "update" ? " · PK " + JSON.stringify(meta.pk) : " · new row")) + "</span>" +
      "</div></div>" +
      '<div class="sheet-body">' +
        '<div class="db-console-row" style="margin-bottom:var(--s2)">' +
          (isBool ? '<button class="btn" id="dbCellBool"></button>' : "") +
          '<button class="btn" id="dbCellNull"></button>' +
          (pretty ? '<button class="btn" id="dbCellJson">Format JSON</button>' : "") +
          '<span class="hint">saves to the local buffer — Commit writes it in one transaction</span>' +
        "</div>" +
        '<textarea id="dbCellText" spellcheck="false"></textarea>' +
      "</div>" +
      '<div class="sheet-foot"><span class="grow"></span>' +
        '<button class="btn" id="dbCellCancel">Cancel</button>' +
        '<button class="btn primary" id="dbCellSave">Save to buffer</button></div>' +
    "</div>";
  $("sheet").hidden = false;
  var ta = $("dbCellText");
  ta.value = pretty || text;
  var nullState = isNull;
  function paintNull() {
    // Never disable the textarea: a NULL cell once opened a dead editor ("cannot edit").
    // NULL is a visible overlay state that typing clears on its own.
    ta.disabled = false;
    ta.style.opacity = nullState ? ".5" : "1";
    ta.placeholder = nullState ? "NULL — type to replace, or toggle the button" : "";
    var b = $("dbCellNull");
    b.textContent = nullState ? "NULL (set)" : "Set NULL";
  }
  // Typing while NULL is set means replacing the NULL — clear the flag.
  ta.addEventListener("input", function () {
    if (nullState) { nullState = false; paintNull(); }
  });
  $("dbCellNull").onclick = function () {
    nullState = !nullState;
    paintNull();
    if (!nullState) ta.focus();
  };
  if (isBool) {
    var boolState = text === "1" || text.toLowerCase() === "true";
    var bb = $("dbCellBool");
    function paintBool() { bb.textContent = boolState ? "TRUE" : "FALSE"; }
    bb.onclick = function () {
      boolState = !boolState;
      nullState = false;
      ta.value = boolState ? "1" : "0";
      paintBool(); paintNull();
    };
    paintBool();
  }
  if (pretty) {
    $("dbCellJson").onclick = function () {
      var p = dbCellPretty(ta.value);
      if (p != null) { ta.value = p; ta.classList.add("json"); }
      else toast("Not valid JSON — left as-is", true);
    };
  }
  paintNull();
  $("dbCellCancel").onclick = dbCloseCellEditor;
  $("dbCellSave").onclick = function () {
    var v;
    if (nullState) v = null;
    else {
      var raw = ta.value;
      // A JSON-shaped text in a JSON-ish column is stored as the string it is; the driver casts.
      v = raw === "" && kind === "update" && meta.orig !== "" ? null : raw;
      if (raw === "" && kind === "insert") v = undefined; // empty insert cell = use column default
    }
    dbSaveCellEdit(v);
  };
  $("sheet").onclick = function (e) { if (e.target === $("sheet")) dbCloseCellEditor(); };
  ta.focus();
  if (!pretty) ta.select();
}

function dbCloseCellEditor() {
  closeSheet();
  dbCellEdit = null;
}

/** Write the dialog result into the local buffer and repaint the grid + bar. */
function dbSaveCellEdit(v) {
  var d = state.db;
  var ed = dbCellEdit;
  if (!ed || !d.data) return;
  if (ed.kind === "insert") {
    var ins = d.inserts[ed.i];
    if (v === undefined) delete ins.values[ed.column];
    else ins.values[ed.column] = v;
  } else {
    var e = d.updates[ed.key] || (d.updates[ed.key] = { pk: ed.meta.pk, changes: {} });
    var backToOriginal = v === ed.meta.orig || (v === null && (ed.meta.orig === null || ed.meta.orig === undefined));
    if (backToOriginal) {
      delete e.changes[ed.column];
      if (!Object.keys(e.changes).length) delete d.updates[ed.key];
    } else e.changes[ed.column] = v;
  }
  dbCloseCellEditor();
  renderDbGrid();
  renderDbBar();
}

/** The text a cell shows and the editor starts from. null stays null. */
function dbCellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

export { dbCellEdit, dbCellJsonLike, dbCellPretty, dbCellText, dbCloseCellEditor, dbOpenCellEditor, dbSaveCellEdit };
