import { $, DEFAULT_GROUP, api, apiJson, esc, saveTunCollapsed, state, toast } from "./util.js";
import { act } from "./detail.js";
import { popupMenu } from "./menu.js";
import { connRowHtml, loadTunnels, ruleRowHtml, tunData, tunGroupOf, tunGrouped, tunGroupsList, tunKind, tunRows, tunTab } from "./polling.js";
import { tunGroupHeadHtml } from "./traffic.js";
import { openConnSheet, openRuleSheet } from "./tunnel-sheets.js";

/* --- tunnels: groups and drag-to-reorder --------------------------------------------------------
   The MCP sidebar's model, ported: one flat order per list (array order in tunnels.json), a group
   name on each row, and a stored list of group names. Dragging onto a row re-orders and re-homes in
   one gesture; dropping on a header appends to that group — the only way into an empty one. */

/** Persist the current order of both lists. The server ranks /api/tunnels by it. */
function saveTunOrder() {
  var d = tunData();
  api("/api/tunnels/order", { method: "PUT", body: JSON.stringify({
    connections: d.connections.map(function (c) { return c.id; }),
    rules: d.rules.map(function (r) { return r.id; }),
  }) }).catch(function () { /* the next reorder retries; the list is already right locally */ });
}

/** Move one row to just before/after another in its list, re-render, persist. */
function moveTunRow(id, target, before) {
  if (!id || !target || id === target) return;
  var rows = tunRows();
  var item = rows.filter(function (r) { return r.id === id; })[0];
  if (!item) return;
  var to = rows.findIndex(function (r) { return r.id === target; });
  if (to < 0) return; // target vanished mid-drag — leave everything where it is
  rows.splice(rows.indexOf(item), 1);
  rows.splice(before ? to : to + 1, 0, item);
  renderTunnels();
  saveTunOrder();
}

/** Put one row in a group (kind is "rules" | "connections"). Applied locally first so the row jumps
 *  immediately, then persisted — a reject takes the server's word for it. */
async function assignTunGroup(kind, id, group) {
  var rows = kind === "rules" ? tunData().rules : tunData().connections;
  var row = rows.filter(function (r) { return r.id === id; })[0];
  if (!row) return;
  var want = group || DEFAULT_GROUP;
  if (tunGroupOf(row) === want) return;
  row.group = want === DEFAULT_GROUP ? null : want;
  renderTunnels();
  var j = await apiJson("/api/tunnels/groups/" + kind + "/" + encodeURIComponent(id),
    { method: "PUT", body: JSON.stringify({ group: group }) });
  if (!j) { await loadTunnels(); return; }
  row.group = j.group === DEFAULT_GROUP ? null : j.group;
  renderTunnels();
}

/** Land a dragged row at the end of a group: slot it after the group's last member so the flat order
 *  agrees with what the cards now show, then reassign. */
function dropTunInto(id, group) {
  var members = tunRows().filter(function (r) { return tunGroupOf(r) === group && r.id !== id; });
  if (members.length) moveTunRow(id, members[members.length - 1].id, false);
  void assignTunGroup(tunKind(), id, group);
}

/** Send the whole group list. Create, reorder and delete are all "here is the new list". */
async function saveTunGroups(next) {
  var j = await apiJson("/api/tunnels/groups/" + tunKind(), { method: "PUT", body: JSON.stringify({ groups: next }) });
  if (!j) return false;
  await loadTunnels();
  return true;
}

async function tunNewGroup() {
  var name = prompt("New group name:", "");
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  if (await saveTunGroups(tunGroupsList().concat([name]))) toast("Group " + name + " created");
}

async function tunRenameGroup(from) {
  var to = prompt("Rename group '" + from + "' to:", from);
  if (to === null || to.trim() === from) return;
  var j = await apiJson("/api/tunnels/groups/" + tunKind() + "/rename",
    { method: "POST", body: JSON.stringify({ from: from, to: to.trim() }) });
  if (!j) return;
  // The fold state is keyed by name; carry it across or a renamed group springs open.
  if (state.tun.collapsed[from]) { delete state.tun.collapsed[from]; state.tun.collapsed[to.trim()] = true; saveTunCollapsed(); }
  await loadTunnels();
  toast("Renamed " + from + " → " + to.trim() + " (" + j.moved + " moved)");
}

async function tunDeleteGroup(name) {
  var n = tunRows().filter(function (r) { return tunGroupOf(r) === name; }).length;
  if (n && !confirm("Delete group '" + name + "'?\n\nIts " + n + " row" + (n === 1 ? "" : "s") +
      " move to '" + DEFAULT_GROUP + "'. Nothing is removed.")) return;
  if (await saveTunGroups(tunGroupsList().filter(function (g) { return g !== name; }))) toast("Deleted group " + name);
}

/** Drag handlers for one tunnel row — the sidebar's wireDrag, adapted to the pane's wider rows. */
function wireTunDrag(row) {
  var idOf = function () { return row.dataset.rule || row.dataset.conn; };
  row.addEventListener("dragstart", function (e) {
    state.tun.dragging = idOf();
    row.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", state.tun.dragging); } catch (err) { /* old IE */ }
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragover", function (e) {
    if (!state.tun.dragging || state.tun.dragging === idOf()) return;
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
    var dragged = state.tun.dragging;
    var target = tunRows().filter(function (r) { return r.id === row.dataset.rule || r.id === row.dataset.conn; })[0];
    // Order first, then membership: moveTunRow re-renders from the flat list, and doing it after the
    // reassignment would drop the row into the new group at whatever slot it happened to hold.
    moveTunRow(dragged, idOf(), before);
    if (target) void assignTunGroup(tunKind(), dragged, tunGroupOf(target) === DEFAULT_GROUP ? null : tunGroupOf(target));
  });
  row.addEventListener("dragend", function () {
    state.tun.dragging = null; // lets a deferred rebuild run again
    row.classList.remove("dragging");
    document.querySelectorAll(".drop-before, .drop-after").forEach(function (r) {
      r.classList.remove("drop-before", "drop-after");
    });
  });
}

/** A group header is a drop target too: the only way into a group with no rows yet. */
function wireTunGroupHead(head) {
  var group = head.dataset.tg;
  head.addEventListener("dragover", function (e) {
    if (!state.tun.dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    head.classList.add("drop-into");
  });
  head.addEventListener("dragleave", function () { head.classList.remove("drop-into"); });
  head.addEventListener("drop", function (e) {
    e.preventDefault();
    head.classList.remove("drop-into");
    var id = state.tun.dragging;
    state.tun.dragging = null;
    if (id) dropTunInto(id, group);
  });
}

function renderTunnels() {
  var d = tunData();
  var isConns = state.tun.tab === "conns";
  // One header row like the Traffic view's: tabs on the left, this tab's actions on the right.
  var acts = '<span style="display:flex;gap:var(--s2)">' +
    '<button class="btn primary" id="' + (isConns ? "tNewConn" : "tNewRule") + '">New</button>' +
    '<button class="btn" id="tNewGroup">New group</button>';
  if (!isConns) {
    acts += '<button class="btn" id="tStartAll">Start all</button>' +
      '<button class="btn" id="tStopAll">Stop all</button>';
  }
  acts += "</span>";
  var ctrl =
    '<div class="sec-head"><div class="seg" role="tablist">' +
      '<button role="tab" data-tab="conns" aria-selected="' + isConns + '">SSH Connections</button>' +
      '<button role="tab" data-tab="rules" aria-selected="' + !isConns + '">Port Forwards</button>' +
    "</div>" + acts + "</div>";

  // One section per group — a .sec-head caption over a .group card, the pane's own idiom. Empty
  // groups keep their caption: that is how you drag the first row into one (or use its +).
  var grouped = tunGrouped();
  var rowHtml = isConns ? connRowHtml : ruleRowHtml;
  function groupHtml(g) {
    return '<div class="tun-group' + (state.tun.collapsed[g.name] ? " collapsed" : "") +
      '" data-tgroup="' + esc(g.name) + '">' + tunGroupHeadHtml(g.name, g.rows.length) +
      (g.rows.length ? '<div class="group">' + g.rows.map(rowHtml).join("") + "</div>" : "") +
      "</div>";
  }
  var body, foot;
  if (isConns) {
    body = d.connections.length
      ? grouped.map(groupHtml).join("")
      : '<div class="empty"><div><h2>No SSH connections</h2><p class="hint">Add one with New, then point a forwarding rule at it.</p></div></div>';
    var connected = d.connections.filter(function (c) { return c.state === "connected"; }).length;
    foot = d.connections.length + " connection" + (d.connections.length === 1 ? "" : "s") + ", " + connected + " connected";
  } else {
    body = d.rules.length
      ? grouped.map(groupHtml).join("")
      : '<div class="empty"><div><h2>No forwarding rules</h2><p class="hint">Add one with New. Each rule binds a local port and forwards it over SSH.</p></div></div>';
    var active = d.rules.filter(function (r) { return r.state === "up"; }).length;
    foot = d.rules.length + " rule" + (d.rules.length === 1 ? "" : "s") + ", " + active + " active";
  }

  // .wide for the same reason as the traffic log: a rule row is name + route + who it serves +
  // three buttons. .pane-desc keeps its own 60ch cap, so the prose does not stretch with it.
  $("pane").innerHTML = '<div class="wide">' +
    '<div class="pane-head"><div><h1 class="pane-title">Tunnels</h1>' +
      '<div class="pane-desc">SSH connections and the local ports forwarded over them. A local port stays bound only while its tunnel can carry traffic.</div>' +
    "</div></div>" + ctrl + body + '<div class="tun-foot">' + esc(foot) + "</div>" +
  "</div>";
  wireTunnels();
}

/** Poll-safe update: dots, reasons, button labels and the footer. Never structure. */
function patchTunnels() {
  if (state.view !== "tunnels") return;
  var d = tunData();
  var rows = state.tun.tab === "conns" ? d.connections : d.rules;
  var attr = state.tun.tab === "conns" ? "data-conn" : "data-rule";
  var nodes = $("pane").querySelectorAll("[" + attr + "]");
  // A row appeared or vanished (another tab, or a reconnect that deleted nothing) — structure
  // changed, so a patch cannot express it. Never mid-drag: a rebuild there cancels the gesture.
  if (nodes.length !== rows.length) { if (!state.tun.dragging) renderTunnels(); return; }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var node = $("pane").querySelector("[" + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(row.id) : row.id) + '"]');
    if (!node) { if (!state.tun.dragging) renderTunnels(); return; }
    var busy = state.tun.busy[row.id];
    var dot = node.querySelector("[data-dot]");
    var live = state.tun.tab === "conns" ? (row.state === "connected" ? "up" : row.state) : row.state;
    if (dot) dot.className = "dot " + (busy ? "starting" : live);
    var reason = node.querySelector("[data-reason]");
    if (reason && reason.textContent !== (row.reason || "")) reason.textContent = row.reason || "";
    var act = node.querySelector("[data-act]");
    if (act) {
      var running = row.state === "up" || row.state === "starting" || row.state === "reconnecting";
      var label = busy ? "…" : running ? "Stop" : "Start";
      if (act.textContent !== label) {
        act.textContent = label;
        act.className = "btn" + (running ? "" : " primary");
        act.dataset.act = running ? "stop" : "start";
      }
      act.disabled = !!busy;
    }
  }
  Array.prototype.forEach.call($("pane").querySelectorAll("[data-tgroup]"), function (card) {
    var n = rows.filter(function (r) { return tunGroupOf(r) === card.dataset.tgroup; }).length;
    var badge = card.querySelector(".tun-count");
    if (badge) badge.textContent = String(n);
  });
  var foot = $("pane").querySelector(".tun-foot");
  if (foot) {
    if (state.tun.tab === "conns") {
      var connected = d.connections.filter(function (c) { return c.state === "connected"; }).length;
      foot.textContent = d.connections.length + " connection" + (d.connections.length === 1 ? "" : "s") + ", " + connected + " connected";
    } else {
      var active = d.rules.filter(function (r) { return r.state === "up"; }).length;
      foot.textContent = d.rules.length + " rule" + (d.rules.length === 1 ? "" : "s") + ", " + active + " active";
    }
  }
}

function wireTunnels() {
  var pane = $("pane");
  Array.prototype.forEach.call(pane.querySelectorAll("[data-tab]"), function (b) {
    b.onclick = function () { tunTab(b.dataset.tab); };
  });
  if ($("tNewConn")) $("tNewConn").onclick = function () { state.tun.pendingGroup = null; openConnSheet(null); };
  if ($("tNewRule")) $("tNewRule").onclick = function () { state.tun.pendingGroup = null; openRuleSheet(null); };
  if ($("tNewGroup")) $("tNewGroup").onclick = tunNewGroup;

  Array.prototype.forEach.call(pane.querySelectorAll("[data-tg]"), function (head) {
    var name = head.dataset.tg;
    // The whole header toggles the fold; the + and ⋯ on its right are actions, not toggles, so
    // clicks that bubble out of them are stopped in their own handlers below.
    var toggle = function () {
      if (state.tun.collapsed[name]) delete state.tun.collapsed[name];
      else state.tun.collapsed[name] = true;
      saveTunCollapsed();
      renderTunnels();
    };
    head.onclick = function (ev) {
      if (ev.target.closest("[data-tgnoclick]")) return;
      toggle();
    };
    head.onkeydown = function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    };
    head.querySelector("[data-tgadd]").onclick = function (ev) {
      ev.stopPropagation();
      state.tun.pendingGroup = name === DEFAULT_GROUP ? null : name;
      if (state.tun.tab === "conns") openConnSheet(null); else openRuleSheet(null);
    };
    var more = head.querySelector("[data-tgmore]");
    if (more) more.onclick = function (ev) {
      ev.stopPropagation();
      popupMenu(more.getBoundingClientRect(), [
        { label: "Rename…", fn: function () { tunRenameGroup(name); } },
        { sep: true },
        { label: "Delete group", danger: true, fn: function () { tunDeleteGroup(name); } },
      ]);
    };
    wireTunGroupHead(head);
  });
  Array.prototype.forEach.call(pane.querySelectorAll("[data-rule], [data-conn]"), wireTunDrag);
  if ($("tStartAll")) $("tStartAll").onclick = startAllRules;
  if ($("tStopAll")) $("tStopAll").onclick = function () { stopAllRules(false); };

  Array.prototype.forEach.call(pane.querySelectorAll("[data-rule]"), function (node) {
    var id = node.dataset.rule;
    var rule = tunData().rules.filter(function (r) { return r.id === id; })[0];
    var act = node.querySelector("[data-act]");
    if (act) act.onclick = function () { ruleAct(id, act.dataset.act); };
    node.querySelector("[data-edit]").onclick = function () { openRuleSheet(rule); };
    node.querySelector("[data-del]").onclick = function () { deleteRule(rule, false); };
    var free = node.querySelector("[data-free]");
    if (free) free.onclick = function () { forceFreePort(Number(free.dataset.free), id); };
  });
  Array.prototype.forEach.call(pane.querySelectorAll("[data-conn]"), function (node) {
    var id = node.dataset.conn;
    var conn = tunData().connections.filter(function (c) { return c.id === id; })[0];
    node.querySelector("[data-test]").onclick = function () { testConn(id); };
    node.querySelector("[data-edit]").onclick = function () { openConnSheet(conn); };
    node.querySelector("[data-del]").onclick = function () { deleteConn(conn); };
  });
}

async function withTunBusy(id, verb, fn) {
  if (state.tun.busy[id]) return null;
  state.tun.busy[id] = verb;
  patchTunnels();
  try {
    return await fn();
  } finally {
    delete state.tun.busy[id];
    await loadTunnels();
  }
}

/* --- rule actions ----------------------------------------------------------------------------- */

async function ruleAct(id, verb) {
  await withTunBusy(id, verb, async function () {
    var r = await api("/api/tunnels/rules/" + encodeURIComponent(id) + "/" + verb, { method: "POST" });
    var j = await r.json().catch(function () { return {}; });
    // 409 means an MCP is using this tunnel. Tell the user who, then obey them.
    if (r.status === 409 && j.confirmRequired) {
      if (!confirm(j.dependents.join(", ") + " depend" + (j.dependents.length === 1 ? "s" : "") +
          " on this tunnel.\n\nStop it anyway?")) return;
      var forced = await apiJson("/api/tunnels/rules/" + encodeURIComponent(id) + "/stop?force=1", { method: "POST" });
      if (forced) toast("Stopped");
      return;
    }
    if (!r.ok) { toast(j.error || "HTTP " + r.status, true); return; }
    if (j.ok === false) { toast(j.error || "Start failed", true); return; }
    toast(verb === "start" ? "Started" : "Stopped");
  });
}

async function startAllRules() {
  var j = await apiJson("/api/tunnels/start-all", { method: "POST" });
  await loadTunnels();
  if (!j) return;
  var failed = (j.results || []).filter(function (x) { return !x.ok; });
  toast(failed.length
    ? (j.results.length - failed.length) + " started, " + failed.length + " failed: " + failed[0].name + " — " + failed[0].error
    : j.results.length + " tunnels started", failed.length > 0);
}

async function stopAllRules(force) {
  var r = await api("/api/tunnels/stop-all" + (force ? "?force=1" : ""), { method: "POST" });
  var j = await r.json().catch(function () { return {}; });
  if (r.status === 409 && j.confirmRequired) {
    if (!confirm("These MCPs are using tunnels you are about to stop:\n\n" + j.dependents.join(", ") +
        "\n\nStop them anyway?")) return;
    return stopAllRules(true);
  }
  await loadTunnels();
  if (!r.ok) { toast(j.error || "HTTP " + r.status, true); return; }
  toast((j.results || []).length + " tunnels stopped");
}

async function deleteRule(rule, force) {
  if (!force && !confirm('Delete forwarding rule "' + rule.name + '"?')) return;
  var r = await api("/api/tunnels/rules/" + encodeURIComponent(rule.id) + (force ? "?force=1" : ""), { method: "DELETE" });
  var j = await r.json().catch(function () { return {}; });
  if (r.status === 409 && j.confirmRequired) {
    if (!confirm(j.dependents.join(", ") + " depend on this tunnel.\n\nDelete it anyway?")) return;
    return deleteRule(rule, true);
  }
  await loadTunnels();
  if (!r.ok) { toast(j.error || "HTTP " + r.status, true); return; }
  toast("Deleted " + rule.name);
}

/** Kill whatever holds a local port. Confirmed here because it can kill a process doing real work. */
async function forceFreePort(port, ruleId) {
  var d = tunData();
  var rule = d.rules.filter(function (r) { return r.id === ruleId; })[0];
  var owner = rule && rule.portOwner;
  if (!confirm("Port " + port + " is held by pid " + (owner ? owner.pid + " (" + owner.name + ")" : "?") +
      ".\n\nForce-kill that process? It may be doing real work.")) return;
  var j = await apiJson("/api/tunnels/port/" + port + "/free", { method: "POST" });
  if (!j) { await loadTunnels(); return; }
  toast("Killed pid " + j.killed.pid + " (" + j.killed.name + ")");
  await ruleAct(ruleId, "start");
}

/* --- connection actions ------------------------------------------------------------------------ */

async function testConn(id) {
  await withTunBusy(id, "test", async function () {
    var j = await apiJson("/api/tunnels/connections/" + encodeURIComponent(id) + "/test", { method: "POST" });
    if (!j) return;
    if (j.ok) { toast("Connected in " + j.ms + " ms" + (j.banner ? " — " + j.banner : "")); return; }
    // A changed host key is the one failure with an action attached.
    if (j.kind === "hostkey" && j.fingerprint) {
      if (confirm(j.error + "\n\nTrust the new key?")) {
        var t = await apiJson("/api/tunnels/connections/" + encodeURIComponent(id) + "/trust", { method: "POST" });
        if (t) toast("Host key trusted — test again");
      }
      return;
    }
    toast(j.error + " (" + j.kind + ")", true);
  });
}

async function deleteConn(conn) {
  if (!confirm('Delete SSH connection "' + conn.name + '"?')) return;
  var j = await apiJson("/api/tunnels/connections/" + encodeURIComponent(conn.id), { method: "DELETE" });
  await loadTunnels();
  if (j) toast("Deleted " + conn.name);
}

export { assignTunGroup, deleteConn, deleteRule, dropTunInto, forceFreePort, moveTunRow, patchTunnels, renderTunnels, ruleAct, saveTunGroups, saveTunOrder, startAllRules, stopAllRules, testConn, tunDeleteGroup, tunNewGroup, tunRenameGroup, wireTunDrag, wireTunGroupHead, wireTunnels, withTunBusy };
