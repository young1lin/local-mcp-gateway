var COLLAPSE_KEY = "mcp_gateway_collapsed";
var TUN_COLLAPSE_KEY = "mcp_gateway_tun_collapsed";
var TOKEN_ID_KEY = "mcp_gateway_token_id"; // which token copied connect commands embed
var THEME_KEY = "mcp_gateway_theme";       // auto | light | dark — the preference, not the result
var KINDS = ["tools", "resources", "prompts"];
/* Mirrors DEFAULT_GROUP in managed.ts. Every MCP is in a group; this is the one it is in until you
   move it, and the one members of a deleted group fall back to. The server never stores it. */
var DEFAULT_GROUP = "default";

var state = {
  mcps: [],          // rows from /api/mcps (each carries .group)
  groups: [],        // custom group names, in sidebar order; `default` is implicit and comes first
  collapsed: {},     // group name -> true. Panel-only, so it lives in localStorage, not managed.json
  selected: null,    // selected MCP name
  filter: "",
  detail: null,      // { name, tab, config, source, editing, editType, tools:{...}, calls, ... }
  busy: {},          // name -> verb in flight
  lastAction: {},    // name -> { msg, err, at }
  mem: null,
  menuOpen: false,
  info: null,        // { tokenEnv } from /api/info — the env var name
  tokens: [],        // named tokens from /api/tokens (no secrets) — the management list
  activeSecret: null, // most-recently shown token secret, embedded into copied connect commands
  traffic: [],       // ONE PAGE of interactions from /api/traffic — no .body/.response on a row
  trafficClients: [],       // every client in the ring, folded server-side (not just this page)
  trafficFilter: "actions", // "actions" (tools/call, resources/read, …) or "all" (incl. protocol)
  trafficClient: null,      // a clientKey to narrow the activity log, or null
  trafficPage: 0,           // 0-based, newest first
  trafficMore: false,       // is there an older page?
  trafficTotal: 0,          // rows matching the current filter, across all pages
  trafficAll: 0,            // rows in the ring before filtering — the "n of m" readout
  trafficOpen: {},          // seq -> expanded: shows the raw request JSON for that interaction
  trafficFull: {},          // seq -> { body, response }, fetched on first expand (cf. d.callsFull)
  trafficSig: null,         // data signature; a poll skips re-render when unchanged (keeps expansion)
  view: "mcps",      // "mcps" | "tunnels" | "traffic" | "data" — the toolbar switcher
  panelVersion: null, // admin.html mtime stamp from /api/info; a change means a new build landed
  addGroup: null,     // sidebar group a header "+" targets for the next created MCP (add-sheet.js)
  db: null,           // the whole Data view state (data-view.js builds/owns it; redisValue rides on it)
  tun: {             // tunnel view state; `data` is the last /api/tunnels response
    tab: "conns",    // "conns" | "rules"
    data: null,
    busy: {},        // id -> verb in flight
    keys: null,      // cached /api/tunnels/keys
    dragging: null,  // id of the row being dragged — polls must not rebuild under it
    collapsed: {},   // group name -> true, per tab view preference (localStorage, like the sidebar)
    pendingGroup: null, // group chosen via a header "+", applied to the row the next create lands in
  },
};

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function now() { return new Date().toLocaleTimeString(); }

/** One time format for row lists: time-of-day inside the last 24h, date+time beyond it (the
 *  pure time becomes ambiguous the moment a list spans midnight). Run-history had this logic as
 *  histWhen; Traffic rows now share it instead of printing bare times on pages days old. */
function whenLabel(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var day = 24 * 60 * 60 * 1000;
  return (Date.now() - d.getTime() >= day)
    ? d.toLocaleString()
    : d.toLocaleTimeString();
}

/** Which groups are folded shut. A view preference, not gateway state — it belongs to this browser. */
function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) { return {}; }
}
/** The tunnel groups fold independently of the sidebar's — same mechanism, its own keys, because a
 *  group named "prod" in each list folding together would be a coincidence, not a feature. */
function loadTunCollapsed() {
  try { return JSON.parse(localStorage.getItem(TUN_COLLAPSE_KEY)) || {}; } catch (e) { return {}; }
}
function saveTunCollapsed() {
  try { localStorage.setItem(TUN_COLLAPSE_KEY, JSON.stringify(state.tun.collapsed)); } catch (e) { /* full or blocked */ }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state.collapsed)); } catch (e) { /* full or blocked */ }
}

function toast(msg, isErr) {
  var t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, 3400);
}


async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  return fetch(path, opts);
}

/** Call the API and hand back the parsed body, or null once the failure has been reported. Every
 *  mutation repeated the same fetch → parse → toast dance, so the dance lives here once. */
async function apiJson(path, opts) {
  try {
    var r = await api(path, opts);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast(j.error || "HTTP " + r.status, true); return null; }
    return j;
  } catch (e) {
    // A network-level failure (gateway stopped mid-click) must be reported too: every caller is
    // `if (!j) return;`, and a silent null made clicking Commit do literally nothing after the
    // confirm dialog.
    toast("request failed — is the gateway running?", true);
    return null;
  }
}

export { $, COLLAPSE_KEY, DEFAULT_GROUP, KINDS, THEME_KEY, TOKEN_ID_KEY, TUN_COLLAPSE_KEY, api, apiJson, el, esc, loadCollapsed, loadTunCollapsed, now, saveCollapsed, saveTunCollapsed, state, toast, whenLabel };
