import { apiJson, el, state, toast } from "./util.js";
import { renderDbFilters } from "./data-filters.js";
import { renderDbGrid, renderDbToolbar } from "./data-grid.js";
import { renderDbTables } from "./data-view.js";

/* --- redis key browser -------------------------------------------------------------------------- */
/* A redis connection in the picker swaps the table list for a SCAN-paged key list, and the
   right pane for a type-aware value view. Read-only: writes belong to redis_command. */

function dbIsRedis() {
  var d = state.db;
  var c = d.conns.find(function (x) { return x.name === d.conn; });
  return !!c && c.dialect === "redis";
}

async function dbLoadKeys(reset) {
  var d = state.db;
  if (!d.conn) return;
  if (reset) { d.redis = null; d.redisKey = null; }
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/keys?count=200";
  if (d.grep) q += "&pattern=" + encodeURIComponent(d.grep);
  if (d.redis && d.redis.cursor && d.redis.cursor !== "0") q += "&cursor=" + encodeURIComponent(d.redis.cursor);
  var j = await apiJson(q);
  if (!j) return;
  d.redis = {
    keys: (d.redis && !reset ? d.redis.keys : []).concat(j.keys || []),
    cursor: j.cursor,
    done: !!j.done,
    total: j.total,
  };
  renderDbTables();
  renderDbFilters(); // the shown/keyspace readout rides on the pattern bar
}

async function dbLoadRedisValue(key) {
  var d = state.db;
  // A fresh key selection is a navigation: drop the command result that owned the pane,
  // or the grid guard would keep rendering it and the value would never show.
  d.sqlResult = null;
  d.sqlBusy = false;
  d.redisKey = key;
  d.redisValue = null; // drop the previous key's value — never flash stale data
  renderDbGrid();
  var j = await apiJson("/api/db/" + encodeURIComponent(d.conn) + "/key?key=" + encodeURIComponent(key));
  if (!j) { d.redisKey = null; renderDbGrid(); return; }
  d.redisValue = j;
  renderDbGrid();
}

function dbRenderRedisValue(wrap) {
  var d = state.db;
  if (!d.redisKey) {
    wrap.appendChild(el("div", "db-hint", "Select a key on the left to view its value."));
    return;
  }
  var v = d.redisValue;
  if (!v) { wrap.appendChild(el("div", "db-hint", "Loading " + d.redisKey + "…")); return; }
  wrap.appendChild(el("div", "db-detail-meta",
    v.key + " · " + v.type + " · TTL " + (v.ttl < 0 ? "none" : v.ttl + "s") +
    (v.length != null ? " · " + v.length + " entries" : "") +
    (v.truncated ? " · truncated" : "")));
  var pre = el("pre", "db-ddl");
  pre.style.position = "static";
  pre.style.margin = "var(--s2)";
  pre.textContent = typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2);
  wrap.appendChild(pre);
}
/* --- mongo collection browser -------------------------------------------------------------------- */

function dbIsMongo() {
  var d = state.db;
  var c = d.conns.find(function (x) { return x.name === d.conn; });
  return !!c && c.dialect === "mongo";
}

async function dbLoadCollections() {
  var d = state.db;
  if (!d.conn) return;
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/collections";
  if (d.grep) q += "?grep=" + encodeURIComponent(d.grep);
  var j = await apiJson(q);
  if (!j) return;
  d.mongo = { collections: j.collections || [], docs: null, docTotal: 0, docOffset: 0, filter: (d.mongo && d.mongo.filter) || "" };
  renderDbTables();
}

async function dbLoadDocs(reset) {
  var d = state.db;
  if (!d.conn || !d.table) return;
  if (reset) d.mongo.docOffset = 0;
  var q = "/api/db/" + encodeURIComponent(d.conn) + "/docs?collection=" + encodeURIComponent(d.table) +
    "&offset=" + d.mongo.docOffset + "&limit=" + d.pageSize;
  if (d.mongo.filter && d.mongo.filter.trim()) q += "&filter=" + encodeURIComponent(d.mongo.filter);
  var j = await apiJson(q);
  if (!j) return;
  d.mongo.docs = j.documents || [];
  d.mongo.docTotal = j.total || 0;
  d.mongo.fields = j.fields || ["_id"];
  renderDbToolbar();
  renderDbGrid();
}

function dbRenderMongoDocs(wrap) {
  var d = state.db;
  if (!d.table) {
    wrap.appendChild(el("div", "db-hint", "Select a collection on the left."));
    return;
  }
  var m = d.mongo || {};
  if (!m.docs) { wrap.appendChild(el("div", "db-hint", "Loading…")); return; }
  // The filter box rides above the grid — one JSON input, Enter applies.
  var bar = el("div", "db-detail-meta");
  var inp = el("input");
  inp.placeholder = '{"status":"active"} — JSON filter, Enter applies';
  inp.value = m.filter || "";
  inp.style.fontFamily = "var(--mono)";
  inp.style.marginRight = "var(--s2)";
  inp.onkeydown = function (e) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      var v = this.value.trim();
      if (v) { try { JSON.parse(v); } catch (err) { toast("Invalid JSON filter", true); return; } }
      d.mongo.filter = v;
      dbLoadDocs(true);
    }
  };
  bar.appendChild(inp);
  bar.appendChild(el("span", "", m.docTotal.toLocaleString() + " documents · read-only"));
  wrap.appendChild(bar);

  var tbl = el("table", "db-grid");
  var thead = el("thead");
  var hr = el("tr");
  (m.fields || ["_id"]).forEach(function (f) { hr.appendChild(el("th", "db-col", f)); });
  thead.appendChild(hr);
  tbl.appendChild(thead);
  var tbody = el("tbody");
  m.docs.forEach(function (doc) {
    var tr = el("tr");
    (m.fields || ["_id"]).forEach(function (f) {
      var td = el("td", "db-cell");
      var v = doc[f];
      if (v === undefined) td.appendChild(el("span", "db-null", "·"));
      else if (v === null) td.appendChild(el("span", "db-null", "NULL"));
      else if (typeof v === "object") td.textContent = JSON.stringify(v);
      else td.textContent = String(v);
      td.title = td.textContent;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
}
function dbOpenMongo(name) {
  var d = state.db;
  if (name === d.table) return;
  d.table = name;
  d.schema = null;
  d.mongo = d.mongo || { collections: [], docs: null, docTotal: 0, docOffset: 0, filter: "" };
  d.mongo.docs = null;
  d.mongo.docOffset = 0;
  d.sqlResult = null;
  renderDbTables();
  dbLoadDocs(true);
}

export { dbIsMongo, dbIsRedis, dbLoadCollections, dbLoadDocs, dbLoadKeys, dbLoadRedisValue, dbOpenMongo, dbRenderMongoDocs, dbRenderRedisValue };
