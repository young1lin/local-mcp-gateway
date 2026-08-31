import { $, apiJson, el, state } from "./util.js";
import { dbIsMongo, dbIsRedis } from "./data-browsers.js";
import { dbTableMenu } from "./data-edit.js";
import { dbHighlightSql, renderDbFilters } from "./data-filters.js";
import { renderDbGrid, renderDbToolbar } from "./data-grid.js";
import { renderDbBar } from "./data-sql.js";

/* --- structure tabs (columns / indexes / DDL / foreign keys) ------------------------------------ */

var DB_TABS = [
  { id: "data", label: "Data" },
  { id: "columns", label: "Columns" },
  { id: "indexes", label: "Indexes" },
  { id: "fks", label: "Foreign Keys" },
  { id: "ddl", label: "DDL" },
];

function dbSetTab(t) {
  var d = state.db;
  if (d.tab === t) return;
  d.tab = t;
  renderDbToolbar();
  renderDbFilters();
  renderDbGrid();
  renderDbBar();
  if (t !== "data" && d.conn && d.table) dbLoadDetail();
}

async function dbLoadDetail() {
  var d = state.db;
  if (!d.conn || !d.table) return;
  d.detailBusy = true;
  renderDbGrid();
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/schema?table=" + encodeURIComponent(d.table);
  if (d.schema) q += "&schema=" + encodeURIComponent(d.schema);
  var j = await apiJson(q);
  d.detailBusy = false;
  if (!j) { d.detail = null; renderDbGrid(); return; }
  d.detail = j;
  d.schema = j.schema;
  renderDbGrid();
}

function dbRenderTabs(ctl) {
  var d = state.db;
  var seg = el("div", "db-tabs");
  seg.setAttribute("role", "tablist");
  DB_TABS.forEach(function (t) {
    var b = el("button", "", t.label);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(d.tab === t.id));
    b.onclick = function () { dbSetTab(t.id); };
    seg.appendChild(b);
  });
  ctl.appendChild(seg);
  // The Table menu: rename / truncate / drop, guarded by typed confirms server- AND client-side.
  if (!dbIsRedis() && !dbIsMongo()) {
    var tblBtn = el("button", "btn", "Table \u25be");
    tblBtn.title = "Rename, truncate or drop this table";
    tblBtn.onclick = function (e) { e.stopPropagation(); dbTableMenu(tblBtn); };
    ctl.appendChild(tblBtn);
  }
}

/** The Structure tabs reuse the grid wrapper: Columns/Indexes/FKs render as plain tables,
 *  DDL as a monospace block. */
function renderDbDetailGrid(wrap) {
  var d = state.db;
  if (d.detailBusy) { wrap.appendChild(el("div", "db-hint", "Loading…")); return; }
  if (!d.detail) { wrap.appendChild(el("div", "db-hint", "Select a table on the left to see its structure.")); return; }
  var det = d.detail;
  if (d.tab === "ddl") {
    wrap.appendChild(el("div", "db-detail-meta",
      (d.conn && d.conns.some(function (c) { return c.name === d.conn && c.dialect === "pg"; })
        ? "Postgres keeps DDL in migration scripts — this sketch is assembled from the catalog."
        : "From SHOW CREATE TABLE.")));
    var pre = el("pre", "db-ddl db-sql-hl");
    pre.style.position = "static"; // undo the overlay absolute positioning — this is a plain block
    pre.innerHTML = dbHighlightSql(dbAlignDdl(det.ddl || "(no DDL)"));
    wrap.appendChild(pre);
    return;
  }
  var tbl = el("table", "db-grid");
  var thead = el("thead");
  var hr = el("tr");
  var spec;
  if (d.tab === "columns") {
    spec = {
      head: ["Column", "Type", "Nullable", "Default", "Key", "Comment"],
      row: function (c) {
        return [c.name, c.dataType, c.nullable ? "YES" : "NO",
          c.defaultValue == null ? "—" : String(c.defaultValue),
          c.isPrimaryKey ? "PRI" : "",
          // { text, cls } marks a cell that carries a class of its own: real comments join the
          // header caption's green, the "—" placeholder stays in the default cell color.
          c.comment == null ? "—" : { text: String(c.comment), cls: "db-det-comment" }];
      },
      rows: det.columns,
      meta: det.columns.length + " columns · primary key: " + (det.primaryKey.join(", ") || "none"),
    };
  } else if (d.tab === "indexes") {
    spec = {
      head: ["Index", "Unique", "Primary", "Columns"],
      row: function (x) {
        return [x.name, x.unique ? "yes" : "no", x.primary ? "yes" : "no",
          (x.columns && x.columns.length ? x.columns.join(", ") : "") || (x.definition || "")];
      },
      rows: det.indexes,
      meta: det.indexes.length + " indexes",
    };
  } else {
    spec = {
      head: ["Constraint", "Column", "References"],
      row: function (f) {
        return [f.name, f.column, f.refSchema + "." + f.refTable + " (" + f.refColumn + ")"];
      },
      rows: det.foreignKeys,
      meta: det.foreignKeys.length + " foreign keys",
    };
  }
  wrap.appendChild(el("div", "db-detail-meta", spec.meta));
  spec.head.forEach(function (h) { hr.appendChild(el("th", "db-col", h)); });
  thead.appendChild(hr);
  tbl.appendChild(thead);
  var tbody = el("tbody");
  spec.rows.forEach(function (r) {
    var tr = el("tr");
    spec.row(r).forEach(function (v) {
      var cell = v && typeof v === "object" ? v : { text: v, cls: "" };
      var td = el("td", "db-cell" + (cell.cls ? " " + cell.cls : ""));
      td.textContent = String(cell.text);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}
/* --- DDL pretty-printing ------------------------------------------------------------------------ */
/* Re-flow a CREATE TABLE into the aligned layout IDEA uses: every column on its own line,
   names padded to a common width, types padded to a common width, so NOT NULL / DEFAULT
   line up down the page. Works on MySQL SHOW CREATE TABLE output and the Postgres sketch
   alike — both are one-definition-per-line already; this only adds the alignment. */
var DDL_MOD_WORDS = new Set((
  "NOT NULL DEFAULT AUTO_INCREMENT PRIMARY UNIQUE REFERENCES COMMENT CHARACTER COLLATE " +
  "GENERATED CHECK CONSTRAINT NULLS FIRST AFTER STORAGE INVISIBLE VISIBLE ON USING WITH"
).split(" "));

/** One column-definition line: quoted name, then type tokens, then modifiers. Returns null
 *  for lines that are not column definitions (PRIMARY KEY, KEY, CONSTRAINT, tail, etc). */
function dbParseColumnLine(line) {
  var m = /^(\s*)([`"][^`"]+[`"])\s+(.*?)(,?)\s*$/.exec(line);
  if (!m) return null;
  var rest = m[3];
  var tokens = rest.split(/\s+/).filter(Boolean);
  var typeParts = [];
  var i = 0;
  while (i < tokens.length) {
    var t = tokens[i];
    var upper = t.toUpperCase().replace(/\(.*$/, "");
    if (typeParts.length && DDL_MOD_WORDS.has(upper)) break;
    typeParts.push(t);
    i++;
    // swallow a parenthesized argument list that follows the type word (varchar(32), decimal(10,2))
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && tokens[i] && /^\(/.test(tokens[i])) {
      // merge a split "(...)" spanning several tokens (spaces inside parens are rare but legal)
      var depth = 0, merged = "";
      while (i < tokens.length) {
        merged += tokens[i];
        depth += (tokens[i].match(/\(/g) || []).length - (tokens[i].match(/\)/g) || []).length;
        i++;
        if (depth === 0 && /\)/.test(merged)) break;
        if (depth === 0 && !/^\(/.test(merged)) break;
        merged += " ";
      }
      typeParts[typeParts.length - 1] = t + merged.replace(/\s+\)/g, ")").replace(/\(\s+/g, "(");
    }
  }
  var mods = tokens.slice(i).join(" ");
  if (!typeParts.length) return null;
  return { indent: m[1], name: m[2], type: typeParts.join(" "), mods: mods, comma: m[4] === "," };
}

function dbAlignDdl(ddl) {
  if (!ddl) return ddl;
  var lines = ddl.split(/\r?\n/);
  var parsed = lines.map(function (l) { return dbParseColumnLine(l); });
  var wName = 0, wType = 0;
  parsed.forEach(function (p) {
    if (!p) return;
    if (p.name.length > wName) wName = p.name.length;
    if (p.type.length > wType) wType = p.type.length;
  });
  if (!wName) return ddl; // nothing recognized — leave the DDL exactly as the server sent it
  return lines.map(function (l, i) {
    var p = parsed[i];
    if (!p) return l.replace(/^\s{4}/, "  "); // constraints and the tail: gentle 2-space re-indent
    var out = "  " + p.name.padEnd(wName + 2) + p.type.padEnd(wType + 2) + p.mods.replace(/\s+/g, " ").trim();
    return out.replace(/\s+$/, "") + ",";
  }).join("\n");
}

export { DB_TABS, DDL_MOD_WORDS, dbAlignDdl, dbLoadDetail, dbParseColumnLine, dbRenderTabs, dbSetTab, renderDbDetailGrid };
