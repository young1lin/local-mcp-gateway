import { $, DEFAULT_GROUP, KINDS, esc, state } from "./util.js";
import { copyConn, copyText, endpointUrl, tabBody } from "./connect.js";
import { act, removeMcp, renameMcp, showTab, startEdit } from "./detail.js";
import { wireTabBody } from "./run-history.js";
import { assignGroup, groupOf, rowOf, saveGroups } from "./sidebar.js";

/* --- rendering: detail pane ------------------------------------------------------------------- */
/** True when the user is typing inside the pane; a poll must never re-render over that. */
function paneHasFocus() {
  var a = document.activeElement;
  return !!a && $("pane").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

function patchDetailHead() {
  var d = state.detail;
  if (!d) return;
  var m = rowOf(d.name);
  var dot = document.querySelector("#pane .pane-sub .dot");
  var txt = document.querySelector("#pane .pane-sub .sub-text");
  var primary = $("primaryBtn");
  if (!m || !dot || !txt) return;
  var busyVerb = state.busy[d.name];
  dot.className = "dot " + (busyVerb ? "starting" : m.state);
  txt.textContent = headSubtitle(m);
  if (primary) {
    var started = m.lifecycle === "started";
    primary.textContent = busyVerb ? "…" : (started ? "Stop" : "Start");
    primary.disabled = !!busyVerb;
    primary.onclick = function () { act(d.name, started ? "stop" : "start"); };
  }
}

function headSubtitle(m) {
  var bits = [];
  if (state.busy[m.name]) bits.push(state.busy[m.name] + "…");
  else bits.push(m.state);
  bits.push(m.type);
  bits.push(m.source);
  if (m.state === "up" && m.latencyMs != null) bits.push(m.latencyMs + " ms");
  if (m.startedAt) bits.push("since " + new Date(m.startedAt).toLocaleTimeString());
  return bits.join("  ·  ");
}

function renderPane() {
  // The tunnel view owns the pane while it is on screen. Without this, the 6s poll's loadList()
  // would reach its "nothing selected" branch and replace the tunnel list with the MCP empty state.
  if (state.view === "tunnels" || state.view === "traffic" || state.view === "data") return;
  var pane = $("pane");
  var d = state.detail;
  if (!d) {
    pane.innerHTML =
      '<div class="empty"><div><h2>' + (state.mcps.length ? "Select an MCP" : "No MCPs registered") + "</h2>" +
      '<p class="hint">' + (state.mcps.length ? "Its tools, resources and configuration appear here." : "Add one with the + on a group header.") + "</p></div></div>";
    return;
  }
  var m = rowOf(d.name) || { name: d.name, state: "unknown", type: "?", source: "?", lifecycle: "stopped" };
  var started = m.lifecycle === "started";
  var busyVerb = state.busy[d.name];
  var menuWasOpen = state.menuOpen; // reopened at the end; see the note there
  // The history popover lives on <body>, so a pane rebuild leaves it stranded over whatever tab
  // replaced Run. wireTabBody reopens it when the rebuilt pane IS the Run tab; otherwise drop it.
  if (d.tab !== "run" && d.run && d.run.histOpen) { d.run.histOpen = false; var stray = $("r-hist-pop"); if (stray) stray.remove(); }

  // The title is the MCP's identity, so it is set in the sans face. The mount path is a value you
  // copy, so it keeps the monospace one — down in the status line, where it costs nothing.
  var head =
    '<div class="pane-head">' +
      "<div>" +
        '<h1 class="pane-title">' + esc(d.name) + "</h1>" +
        (m.description ? '<div class="pane-desc">' + esc(m.description) + "</div>" : "") +
        '<div class="pane-sub"><span class="dot ' + esc(busyVerb ? "starting" : m.state) + '"></span>' +
          '<span class="sub-path">/' + esc(d.name) + "</span>" +
          '<span class="sub-text">' + esc(headSubtitle(m)) + "</span></div>" +
      "</div>" +
      '<div class="pane-actions">' +
        // Tinted only for Start: blue is the affirmative action, and a header full of blue Stop
        // buttons on six healthy MCPs says nothing. Stop is a plain button with the same footprint.
        '<button class="btn' + (started ? "" : " primary") + '" id="primaryBtn"' + (busyVerb ? " disabled" : "") + ">" +
          (busyVerb ? "…" : started ? "Stop" : "Start") + "</button>" +
        '<button class="btn icon" id="menuBtn" aria-label="More actions" title="More actions">&#183;&#183;&#183;</button>' +
      "</div>" +
    "</div>";

  var tabs = KINDS.concat(["run", "config", "logs"]);
  var seg = '<div class="seg" role="tablist">' + tabs.map(function (t) {
    var kd = KINDS.indexOf(t) >= 0 ? d[t] : null;
    var count = kd && kd.loaded ? '<span class="seg-n">' + (kd.total != null ? kd.total : kd.items.length) + "</span>" : "";
    var label = t.charAt(0).toUpperCase() + t.slice(1);
    return '<button role="tab" data-tab="' + t + '" aria-selected="' + (d.tab === t ? "true" : "false") + '">' + label + count + "</button>";
  }).join("") + "</div>";

  var reason = m.reason ? '<div class="note err">' + esc(m.reason) + "</div>" : "";
  var la = state.lastAction[d.name];
  var actionNote = la ? '<div class="note' + (la.err ? " err" : "") + '">' + esc(la.at + " · " + la.msg) + "</div>" : "";

  // One column holds the lot — header, tab bar, body, notes — so the measure is applied once and
  // they all share a left edge. Capping each of them individually looked identical until the pane
  // started centring: .seg is inline-flex, and an inline-level box ignores the auto margins that
  // centre a block, so the tab bar stayed at the pane's padding edge ~240px left of the card it
  // labels.
  //
  // One width for every tab, too. Logs used to opt into --measure-wide for its arguments column;
  // once the column is centred that widening moves BOTH edges, so switching Config <-> Logs slid the
  // whole page ~220px sideways and back. Changing tabs must not resize the page. The log rows lose
  // nothing structural at the standard measure — .call-arg is a truncating preview, so it just
  // ellipsises earlier, and the full request and reply are one click away in the expanded row.
  pane.innerHTML = '<div class="col">' + head + seg +
    '<div id="tabbody">' + tabBody(d, m) + "</div>" + reason + actionNote + "</div>";

  // Wire up (no inline handlers — names can contain characters that break string-built onclicks).
  $("primaryBtn").onclick = function () { act(d.name, started ? "stop" : "start"); };
  $("menuBtn").onclick = function (ev) { ev.stopPropagation(); toggleMenu(d, m); };
  pane.querySelectorAll(".seg button").forEach(function (b) {
    b.onclick = function () { showTab(b.dataset.tab); };
  });
  wireTabBody(d, m);
  // A late tools/list response re-renders the pane; without this the ... menu you opened a moment
  // ago would just disappear. The menu is state, so it is restored like any other.
  if (menuWasOpen) openMenu(d, m);
}

/** The overflow menu is attached and removed on its own, without re-rendering the pane — otherwise
 *  opening it would rebuild (and clear) a config form that was mid-edit. */
function toggleMenu(d, m) {
  var wasOpen = state.menuOpen;
  closeMenu();
  if (wasOpen) return;
  openMenu(d, m);
}
function openMenu(d, m) {
  var host = document.querySelector("#pane .pane-actions");
  if (!host) return;
  // Re-resolve the row from live state instead of trusting the one renderPane closed over. The 6s
  // poll's loadList() REPLACES state.mcps wholesale, and it only patches the header afterwards — so
  // the captured object is orphaned from that moment on. The menu reads two things off it that
  // change (which group the MCP is in, and whether it is config-sourced), and with a stale object
  // the group tick stayed on whatever it was when the pane was last rendered.
  var live = rowOf(d.name) || m;
  host.insertAdjacentHTML("beforeend", menuHtml(live));
  state.menuOpen = true;
  wireMenu(d, live);
}
function closeMenu() {
  var node = $("menu");
  if (node) node.remove();
  document.querySelectorAll(".ctx-menu").forEach(function (m) { m.remove(); });
  state.menuOpen = false;
}

/** Grouped like a macOS menu: connect, then which group it is in, then manage, then the destructive
 *  one on its own. The group section is a pick list with a tick, not a submenu — a submenu built from
 *  a string is more machinery than four lines of choices are worth. */
function menuHtml(m) {
  var current = groupOf(m);
  var picks = [DEFAULT_GROUP].concat(state.groups).map(function (g) {
    return '<button class="pick' + (g === current ? " on" : "") + '" data-grp="' + esc(g) + '">' + esc(g) + "</button>";
  }).join("");
  return '<div class="menu" id="menu">' +
    '<div class="menu-cap">Connect a client</div>' +
    '<button data-act="cp-claude">Copy Claude Code command</button>' +
    '<button data-act="cp-codex">Copy Codex command</button>' +
    '<button data-act="cp-json">Copy .mcp.json entry</button>' +
    '<button data-act="cp-url">Copy endpoint URL</button>' +
    "<hr>" +
    '<div class="menu-cap">Group</div>' +
    picks +
    '<button data-act="new-group">New group…</button>' +
    "<hr>" +
    '<button data-act="restart">Restart</button>' +
    '<button data-act="edit">Edit configuration…</button>' +
    '<button data-act="rename">Rename…</button>' +
    '<hr><button class="danger" data-act="delete">Delete</button>' +
    "</div>";
}
function wireMenu(d, m) {
  $("menu").querySelectorAll("button").forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      closeMenu();
      if (b.dataset.grp !== undefined) {
        assignGroup(d.name, b.dataset.grp === DEFAULT_GROUP ? null : b.dataset.grp);
        return;
      }
      var a = b.dataset.act;
      if (a === "new-group") {
        // Make the group, then put this MCP straight into it — otherwise "New group…" from an MCP's
        // own menu would create an empty group and leave the MCP where it was.
        (async function () {
          var name = prompt("New group name:", "");
          if (name === null || !name.trim()) return;
          if (await saveGroups(state.groups.concat([name.trim()]))) assignGroup(d.name, name.trim());
        })();
        return;
      }
      if (a === "restart") act(d.name, "restart");
      else if (a === "rename") renameMcp(d.name);
      else if (a === "delete") removeMcp(d.name);
      else if (a === "edit") { d.tab = "config"; startEdit(); }
      else if (a === "cp-url") copyText(endpointUrl(d.name), "Endpoint URL");
      else if (a === "cp-claude") copyConn(d.name, "claude");
      else if (a === "cp-codex") copyConn(d.name, "codex");
      else if (a === "cp-json") copyConn(d.name, "json");
    };
  });
}

export { closeMenu, headSubtitle, menuHtml, openMenu, paneHasFocus, patchDetailHead, renderPane, toggleMenu, wireMenu };
