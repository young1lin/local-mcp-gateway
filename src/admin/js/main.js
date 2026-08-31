/* ================================================================================================
   Rendering contract, and the reason this panel is not one big innerHTML template any more:
   the old panel rebuilt the whole table from a string every 6 seconds, which flickered, dropped text
   selection and scroll position, and — a real bug — wiped whatever you had typed into the edit form.

   So: the 6s poll may ONLY patch the sidebar rows and the detail header (dot, subtitle, primary
   action). The tab body is rebuilt only in response to an explicit load or user action, never by the
   poll, and never while it holds focus.

   This is the entry module: boot, appearance, the toolbar/keyboard wiring, and the poll. Every view
   lives in its own module next to this one; /admin/js/* is served with no-store, so editing any of
   them reaches the browser on the next reload — no build, no gateway restart.
   ================================================================================================ */
import { $, KINDS, THEME_KEY, api, loadCollapsed, loadTunCollapsed, state, toast } from "./util.js";
import { closeSheet } from "./add-sheet.js";
import { initSelects } from "./dropdown.js";
import { dbPending, loadDbView } from "./data-view.js";
import { loadCalls, loadMeta, loadPage, openDetail, pageState } from "./detail.js";
import { patchSidebar } from "./menu.js";
import { closeMenu } from "./pane.js";
import { loadList, loadMemory, loadTunnels, setView } from "./polling.js";
import { histClose } from "./run-history.js";
import { navRows, nudgeSelected } from "./sidebar.js";
import { openTokensView } from "./tokens.js";
import { loadTraffic } from "./traffic.js";

/** A new panel build has landed. Reload in place — the same tab, never a new one — but only
 *  when the reload cannot destroy work: no buffered data-view edits, no open sheet, nothing
 *  being typed. Otherwise say so once and keep checking on later polls. */
function maybeReloadPanel(newVersion) {
  var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  var busy = !$("sheet").hidden || state.menuOpen;
  var edits = state.view === "data" && typeof dbPending === "function" && dbPending() > 0;
  if (typing || busy || edits) {
    if (!maybeReloadPanel._warned) {
      maybeReloadPanel._warned = true;
      toast("A new panel version is ready — it will load once you finish editing");
    }
    return;
  }
  state.panelVersion = newVersion; // remember before reload so a fast retry does not loop
  location.reload();
}

/* --- boot -------------------------------------------------------------------------------------- */
/** The panel has no login: the gateway only ever accepts loopback requests, so reaching this page
 *  at all already means you are on the machine it serves. Nothing to sign in to — just start. */
function showApp() {
  loadList();
  loadInfo();
}

/** Gateway facts the panel needs once: the token's env var name, and the named-token list (no
 *  secrets) for the management view. */
async function loadInfo() {
  try {
    var r = await api("/api/info");
    if (r.ok) {
      state.info = await r.json();
      // First sight records the stamp; a LATER, DIFFERENT one means the panel was rebuilt —
      // reload in place when nothing unsaved would be lost (checked in maybeReloadPanel).
      if (state.panelVersion === null) state.panelVersion = state.info.panelVersion || null;
      else if (state.info.panelVersion && state.info.panelVersion !== state.panelVersion) {
        maybeReloadPanel(state.info.panelVersion);
      }
    }
    var t = await api("/api/tokens");
    if (t.ok) state.tokens = (await t.json()).tokens || [];
  } catch (e) { /* the token list just stays empty */ }
}
$("tokenBtn").onclick = openTokensView;

/* --- appearance ------------------------------------------------------------------------------- */
/* Three choices, not a two-state switch: "auto" has to stay reachable, because on a machine that
   turns dark at sunset the right answer changes twice a day and a toggle can only ever be wrong
   half of it. The preference is per-browser (localStorage), not gateway state — it describes this
   screen, and the same gateway is read from other screens with other lighting. */
function themePref() {
  try { var v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "auto"; }
  catch (e) { return "auto"; }
}
function prefersDark() {
  return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
}
function applyTheme() {
  var p = themePref();
  document.documentElement.setAttribute("data-theme", p === "dark" || (p === "auto" && prefersDark()) ? "dark" : "light");
}
function setTheme(p) {
  try { if (p === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, p); }
  catch (e) { /* the choice still applies to this page load */ }
  applyTheme();
}
/* One click, one flip: the button shows what clicking switches TO — a moon on the light theme
   (click → dark), a sun on the dark one (click → light). "Auto" stays the untouched default (no
   stored preference): the first explicit click pins the choice for this browser. */
function paintThemeBtn() {
  var dark = document.documentElement.getAttribute("data-theme") === "dark";
  var b = $("themeBtn");
  b.innerHTML = dark ? "&#9728;" : "&#9790;"; // sun / moon
  b.title = dark ? "Switch to light" : "Switch to dark";
}
$("themeBtn").onclick = function (e) {
  e.stopPropagation();
  var dark = document.documentElement.getAttribute("data-theme") === "dark";
  setTheme(dark ? "light" : "dark");
  paintThemeBtn();
};
paintThemeBtn();
// Every dropdown in the panel becomes the shared custom control: what is in the DOM now, plus
// whatever the views create later (observed), so no view ever opts in or out.
initSelects();
// Only matters while the preference is "auto"; a fixed choice is not the OS's business.
if (window.matchMedia) {
  var mq = matchMedia("(prefers-color-scheme: dark)");
  var onOsChange = function () { if (themePref() === "auto") { applyTheme(); paintThemeBtn(); } };
  if (mq.addEventListener) mq.addEventListener("change", onOsChange);
  else if (mq.addListener) mq.addListener(onOsChange);   // Safari < 14
}


Array.prototype.forEach.call($("viewSeg").querySelectorAll("button"), function (b) {
  b.onclick = function () { setView(b.dataset.view); };
});
/* #tunnels / #data / #traffic in the URL opens that view directly — a deep link is the only way a
   screenshot, a bookmark or a refresh lands where the reader meant to be. Unknown hashes stay on
   the MCP list. */
(function () {
  var v = (location.hash || "").replace(/^#/, "");
  if (v === "tunnels" || v === "traffic" || v === "data") setView(v);
})();

/* Polling is cheap: /api/mcps is status-only, and /api/memory reads process.memoryUsage() in-process.
   The child-subtree walk asked for below is the one costly part, and the server bounds it — cached for
   20s, deduped while in flight, and skipped outright when no proc MCP is running — so a 6s poll costs
   at most one transient powershell per 20s, and nothing at all when there are no children. Polling
   still pauses when the tab is hidden: nobody is looking. */
function poll() {
  if (document.visibilityState !== "visible") return;
  loadMemory(true);
  loadInfo(); // carries the panel stamp — a new build reloads the page by itself
  if (state.view === "tunnels") {
    // The tunnel rows are the live thing here; the MCP list is still refreshed because the rows show
    // each linked MCP's own health dot.
    loadList();
    loadTunnels(true);
    return;
  }
  loadList();
  if (state.view === "traffic") { loadTraffic(); return; }
  // The call log is live only while you are looking at it.
  if (state.detail && state.detail.tab === "logs") loadCalls(state.detail.name);
}
setInterval(poll, 6000);
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") poll(); });
// Closing the page with buffered (uncommitted) edits would lose them silently; the native
// dialog is the only hook available for beforeunload, so it is plain by necessity.
window.addEventListener("beforeunload", function (e) {
  if (state.view === "data" && typeof dbPending === "function" && dbPending()) {
    e.preventDefault(); // Chrome needs this; the returnValue fallback covers the rest
    e.returnValue = "";
  }
});

$("refreshBtn").onclick = function () {
  if (state.view === "data") { loadDbView(); return; }
  if (state.view === "tunnels") { loadTunnels(); loadMemory(true); return; }
  if (state.view === "traffic") { state.trafficSig = null; loadTraffic(); loadMemory(true); return; }
  poll();
  var d = state.detail;
  if (d) {
    loadMeta(d.name);
    if (d.tab === "logs") loadCalls(d.name);
    if (KINDS.indexOf(d.tab) >= 0) { d[d.tab] = pageState(); loadPage(d.name, d.tab); }
  }
};
$("filter").oninput = function () { state.filter = this.value; patchSidebar(); };

/* Keyboard: arrows move through the sidebar, / focuses search, Escape closes the sheet/menu. */
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    if (!$("sheet").hidden) { closeSheet(); return; }
    if (state.menuOpen) { closeMenu(); return; }
    var hd = state.detail;
    if (hd && hd.run && hd.run.histOpen) { histClose(); return; }
  }
  var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (typing) return;
  if (e.key === "r") { $("refreshBtn").click(); return; }
  if (state.view === "tunnels" || state.view === "data") return; // no sidebar on screen in these views
  if (e.key === "/") { e.preventDefault(); $("filter").focus(); return; }
  // Alt+arrows move the selected MCP through the list (the drag-free path to the same reorder).
  if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    nudgeSelected(e.key === "ArrowUp");
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  // navRows, not visibleMcps: the arrows walk what is actually on screen, so a folded group is
  // stepped over rather than selected into.
  var rows = navRows();
  if (!rows.length) return;
  e.preventDefault();
  var i = rows.findIndex(function (m) { return m.name === state.selected; });
  var nextIndex = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
  if (i < 0) nextIndex = 0;
  openDetail(rows[nextIndex].name);
});

state.collapsed = loadCollapsed(); // before the first paint, so folded groups never flash open
state.tun.collapsed = loadTunCollapsed(); // same for the tunnel groups
showApp();
// Ask for the child walk on the very first paint too, so the chip never shows a gateway-only total
// that a poll silently corrects 6s later.
loadMemory(true);
