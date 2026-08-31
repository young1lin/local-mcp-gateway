import { $, DEFAULT_GROUP, el, state } from "./util.js";
import { closeMenu } from "./pane.js";
import { assignGroup, groupNode, groupOf, groupedMcps, moveRow, rowOf, visibleMcps } from "./sidebar.js";

/* --- a menu anchored to a button ---------------------------------------------------------------
   The pane's overflow menu anchors to .pane-actions; menus raised from the sidebar have no such
   anchor, so they are positioned against the button that opened them. Items are
   { label, fn, danger, sep }. */
function popupMenu(anchor, items) {
  closeMenu();
  var node = el("div", "menu float");
  node.id = "menu";
  items.forEach(function (it) {
    if (it.sep) { node.appendChild(document.createElement("hr")); return; }
    var cls = (it.pick ? "pick" : "") + (it.on ? " on" : "") + (it.danger ? " danger" : "");
    var b = el("button", cls.trim(), it.label);
    b.type = "button";
    b.onclick = function (ev) { ev.stopPropagation(); closeMenu(); it.fn(); };
    node.appendChild(b);
  });
  document.body.appendChild(node);
  // Aligned to the button's LEFT edge and growing right, over the detail pane. Right-aligning it
  // instead pushed a sidebar menu back across the list it was opened from, hiding those rows.
  var r = node.getBoundingClientRect();
  node.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)) + "px";
  // Below the button, unless that would run off the bottom — then above it.
  var below = anchor.bottom + 4;
  node.style.top = (below + r.height > window.innerHeight - 8 ? Math.max(8, anchor.top - r.height - 4) : below) + "px";
  state.menuOpen = true;
}

/** Drag handlers for one sidebar row. The insertion point is the hovered row's half (top half =
 *  before it, bottom half = after it), shown as an accent edge. Dropping on a row in another group
 *  both moves the MCP there and places it at that spot. */
function wireDrag(row) {
  row.addEventListener("dragstart", function (e) {
    state.dragging = row.dataset.name;
    row.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", row.dataset.name); } catch (err) { /* old IE */ }
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragover", function (e) {
    if (!state.dragging || state.dragging === row.dataset.name) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    var before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.classList.toggle("drop-before", before);
    row.classList.toggle("drop-after", !before);
  });
  row.addEventListener("dragleave", function () {
    row.classList.remove("drop-before", "drop-after");
  });
  row.addEventListener("drop", function (e) {
    e.preventDefault();
    var before = e.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2;
    var dragged = state.dragging;
    var target = rowOf(row.dataset.name);
    // Order first, then membership: moveRow re-renders from the flat list, and doing it after the
    // reassignment would drop the row into the new group at whatever slot it happened to hold.
    moveRow(dragged, row.dataset.name, before);
    if (target) assignGroup(dragged, groupOf(target) === DEFAULT_GROUP ? null : groupOf(target));
  });
  row.addEventListener("dragend", function () {
    state.dragging = null; // lets the deferred rebuild run — see patchSidebar
    row.classList.remove("dragging");
    document.querySelectorAll(".drop-before, .drop-after").forEach(function (r) {
      r.classList.remove("drop-before", "drop-after");
    });
    patchSidebar();
  });
}
/** A sidebar row is one line, so everything that used to be crammed onto a second one — the
 *  description, the source, the latency, the reason a row is red — lives here, and in the pane
 *  header for the selected MCP. */
function tooltipOf(m) {
  var bits = ["/" + m.name, m.type, m.source, state.busy[m.name] ? state.busy[m.name] + "…" : m.state];
  if (m.latencyMs != null) bits.push(m.latencyMs + " ms");
  if (m.description) bits.unshift(m.description);
  if (m.reason) bits.push(m.reason);
  return bits.join("  ·  ");
}

/** Patch existing rows in place; only rebuild when the visible set changes. Keeps scroll, keeps
 *  focus, and stops the whole list flashing on every poll.
 *
 *  While a drag is in flight (state.dragging) the rebuild is DEFERRED: a poll landing mid-drag would
 *  replace the DOM under the pointer and silently cancel it. Attribute patching never moves nodes,
 *  so rows stay live; dragend triggers one catch-up rebuild. */
function patchSidebar() {
  var list = $("list");
  var groups = groupedMcps();
  var rows = visibleMcps();
  // The rebuild key covers everything structural: which groups exist, what is in each, and which are
  // folded shut. Dot colour, latency and selection are patched below and stay out of it on purpose.
  var sig = groups.map(function (g) {
    return g.name + "\u0001" + (state.collapsed[g.name] ? "c" : "o") + "\u0001" +
      g.rows.map(function (m) { return m.name; }).join("\u0000");
  }).join("\u0002");

  if (list.dataset.sig !== sig && !state.dragging) {
    list.innerHTML = "";
    groups.forEach(function (g) { list.appendChild(groupNode(g)); });
    list.dataset.sig = sig;
  }
  rows.forEach(function (m) {
    var node = list.querySelector('[data-name="' + (window.CSS && CSS.escape ? CSS.escape(m.name) : m.name) + '"]');
    if (!node) return;
    var busyVerb = state.busy[m.name];
    node.querySelector(".dot").className = "dot " + (busyVerb ? "starting" : m.state);
    // Patched rather than set at build time: an Edit that switches an MCP from npx to http keeps the
    // same name, so the row is never rebuilt and the trailing label would otherwise go stale.
    var tagEl = node.querySelector(".side-type");
    var tag = m.tag || m.type || "";
    tagEl.textContent = tag;
    if (tag) tagEl.setAttribute("data-tag", tag);
    else tagEl.removeAttribute("data-tag");
    node.title = tooltipOf(m);
    node.setAttribute("aria-selected", state.selected === m.name ? "true" : "false");
  });

  var up = 0, bad = 0;
  state.mcps.forEach(function (m) {
    if (m.state === "up") up++;
    else if (m.state === "down" || m.state === "error") bad++;
  });
  // The chip belongs to whichever view is on screen; in the tunnel view it counts rules.
  if (state.view !== "tunnels") {
    $("countChip").textContent = state.mcps.length + " MCPs · " + up + " up" + (bad ? " · " + bad + " down" : "");
  }
  // Group headers name the sections now, so the standing "MCPS" caption is noise; it earns its line
  // only while a search is on, where the match count is the useful part.
  var cap = $("sideCap");
  cap.textContent = rows.length + " matching";
  cap.hidden = !state.filter;
}

export { patchSidebar, popupMenu, tooltipOf, wireDrag };
