import { $, DEFAULT_GROUP, apiJson, esc, state, whenLabel } from "./util.js";
import { fmtJson } from "./logs.js";

/* --- traffic: who (token + self-reported client) asked what, across every MCP -----------------
   Two sections: a "Clients" summary (who has been talking to the gateway, and which MCPs), and an
   "Activity" log underneath. The log defaults to "Actions" (tools/call, resources/read, …) so the
   protocol handshake stops drowning out the things you actually want to see. Click a client to filter
   the log to it.

   The gateway speaks stateless HTTP — there is no session table, so "clients" is folded from recorded
   interaction traffic: last-seen is the honest signal. The newest entries are tailed to disk and
   restored on boot, so a gateway restart no longer blanks this view. */
/** Identity for grouping moved server-side (traffic.ts folds clients itself); the panel-side
 *  copy had no callers left. */
/** Relative "x ago"; refreshes every poll (6s) because renderTraffic re-runs while the view is open. */
function ago(iso) {
  var ms = Date.now() - new Date(iso).getTime();
  if (ms < 5000) return "just now";
  if (ms < 60000) return Math.round(ms / 1000) + "s ago";
  if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
  return new Date(iso).toLocaleTimeString();
}

/**
 * Fetch one page of the activity log.
 *
 * Filtering, paging and the client fold all happen on the server now. They used to happen here, over
 * a 200-entry dump that carried every entry's raw request and reply (8 KB each) — up to megabytes on
 * a 6-second poll, to draw a dozen lines whose JSON was hidden behind a chevron. Two consequences to
 * keep in mind while reading the rest of this section: a row has no `.body`/`.response` until it is
 * expanded (see toggleTraffic), and `state.trafficClients` is the whole ring's fold, not this page's.
 */
async function loadTraffic() {
  var q = "/api/traffic?page=" + (state.trafficPage || 0) +
    (state.trafficFilter !== "all" ? "&actions=1" : "") +
    (state.trafficClient ? "&client=" + encodeURIComponent(state.trafficClient) : "");
  var j = await apiJson(q);
  if (!j) return;
  state.traffic = j.entries || [];
  state.trafficClients = j.clients || [];
  state.trafficTotal = j.total || 0;
  state.trafficAll = j.totalUnfiltered || 0;
  state.trafficMore = !!j.more;
  if (state.view !== "traffic") return;
  // Skip the rebuild when nothing changed: a 6s poll would otherwise collapse every expanded row and
  // reset scroll while you are reading one. Filter/refresh/view-entry call renderTraffic() directly.
  var sig = (state.traffic.length ? state.traffic[0].seq : 0) + ":" + state.traffic.length +
    ":" + state.trafficTotal + ":" + state.trafficClients.length;
  if (state.trafficSig === sig) return;
  state.trafficSig = sig;
  renderTraffic();
}

/** Re-query after anything that changes which rows the server should return. */
function trafficReload(resetPage) {
  if (resetPage) state.trafficPage = 0;
  state.trafficSig = null;
  void loadTraffic();
}
function trafficPageStep(delta) {
  var next = (state.trafficPage || 0) + delta;
  if (next < 0 || (delta > 0 && !state.trafficMore)) return;
  state.trafficPage = next;
  trafficReload(false);
}
function trafficRow(e) {
  var meta = (e.clientName ? e.clientName + (e.clientVersion ? " " + e.clientVersion : "") : "—") +
    "  ·  /" + e.mcp + "  ·  " + (e.ok ? "ok" : "err") + "  ·  " + e.ms + "ms  ·  " + whenLabel(e.at);
  // Collapsed: method + a one-line params preview + meta. Expanded (chevron): the raw request JSON.
  return '<div class="call' + (state.trafficOpen[e.seq] ? " open" : "") + '" data-tseq="' + e.seq + '">' +
    '<div class="call-sum" data-tog="' + e.seq + '" role="button" tabindex="0">' +
      '<span class="chev">&#8250;</span>' +
      '<span class="dot ' + (e.ok ? "up" : "down") + '"></span>' +
      '<span class="call-tool">' + esc(e.method) + "</span>" +
      '<span class="call-arg">' + esc(e.params || "") + "</span>" +
      '<span class="call-meta">' + esc(meta) + "</span>" +
    "</div>" +
    // Payload deliberately absent until the row is opened — trafficBodyHtml renders whatever
    // toggleTraffic has fetched. Building 200 hidden <pre> blocks (two fmtJson round-trips each) was
    // most of what this view cost, and none of it was on screen.
    '<div class="call-body">' + trafficBodyHtml(e) + "</div>" +
  "</div>";
}

function trafficBodyHtml(e) {
  var full = state.trafficFull[e.seq];
  if (!full) return '<div class="note"><span class="spin"></span> Loading…</div>';
  if (full.gone) return '<div class="note">This interaction has rolled out of the buffer.</div>';
  return '<div class="call-lbl">Request</div>' +
    '<pre class="logs">' + esc(fmtJson(full.body || "")) + "</pre>" +
    '<div class="call-lbl">Response' + (full.response ? "" : ' <span style="color:var(--text-3)">— none —</span>') + "</div>" +
    '<pre class="logs">' + (full.response ? esc(fmtJson(full.response)) : '<span style="color:var(--text-3)">no reply captured for this entry</span>') + "</pre>";
}

/** Fetch one interaction's raw request and reply, then paint it into the already-open row. */
async function loadTrafficBody(seq) {
  if (state.trafficFull[seq]) return;
  var j = await apiJson("/api/traffic/" + encodeURIComponent(seq));
  // A 404 means the ring rolled past it while the row sat there; say so rather than spin forever.
  state.trafficFull[seq] = j || { gone: true };
  var node = document.querySelector('#pane .call[data-tseq="' + seq + '"] .call-body');
  if (node) node.innerHTML = trafficBodyHtml({ seq: seq });
}
/** Expand/collapse one row's raw JSON in place — a poll must not close what you just opened. */
function toggleTraffic(seq) {
  state.trafficOpen[seq] = !state.trafficOpen[seq];
  var node = document.querySelector('#pane .call[data-tseq="' + seq + '"]');
  if (node) node.className = "call" + (state.trafficOpen[seq] ? " open" : "");
  if (state.trafficOpen[seq]) void loadTrafficBody(seq);
}
function renderTraffic() {
  // `entries` is one page; `clients`, `total` and `all` describe the whole ring (server-computed).
  var entries = state.traffic || [];
  var clients = state.trafficClients || [];
  var total = state.trafficTotal || 0;
  var all = state.trafficAll || 0;
  var sel = state.trafficClient;

  // Controls: action/everything toggle + clear. This whole pane is the Traffic view's content.
  var ctrl = '<div class="sec-head"><span class="sec-cap">Traffic</span>' +
    '<span style="display:flex;gap:var(--s2);align-items:center">' +
      '<div class="seg" id="trFilter">' +
        '<button data-filter="actions" aria-selected="' + (state.trafficFilter !== "all") + '">Actions</button>' +
        '<button data-filter="all" aria-selected="' + (state.trafficFilter === "all") + '">Everything</button>' +
      "</div>" +
      '<button class="btn" id="trClear"' + (all ? "" : " disabled") + ">" + (sel ? "Clear client" : "Clear") + "</button>" +
    "</span></div>";

  // Clients — who has been talking to the gateway, folded from recorded traffic (stateless: no live
  // connection to query). Click a row to filter the activity log to that client.
  var clientBlock;
  if (clients.length) {
    var rows = clients.map(function (c) {
      var isSel = sel === c.key;
      var mcps = (c.mcps || []).map(function (m) { return "/" + m; }).join("  ");
      var tokens = c.tokens || [];
      var tokenLine = tokens.length ? "token " + tokens.join(", ") : "no token";
      return '<div class="row row-act' + (isSel ? " row-sel" : "") + '" data-ckey="' + esc(c.key) + '" role="button" tabindex="0">' +
        '<div class="row-main">' +
          '<div class="name">' + esc(c.label) + "</div>" +
          '<div class="desc">' + esc(tokenLine) + " · " + esc(mcps) + " · " + esc(ago(c.lastAt)) +
          " · " + c.count.toLocaleString() + " request" + (c.count === 1 ? "" : "s") + "</div>" +
        "</div>" +
        (isSel ? '<button class="btn icon" data-cclr title="Stop filtering">&#10005;</button>' : "") +
      "</div>";
    }).join("");
    clientBlock = '<div class="cap" style="padding-top:var(--s5)">Clients · ' + clients.length + "</div>" +
      '<div class="group">' + rows + "</div>";
  } else {
    clientBlock = '<div class="cap" style="padding-top:var(--s5)">Clients</div>' +
      '<div class="group"><div class="row"><span class="rowmsg">No clients yet. When a client sends its first request (initialize, tools/list, …) it appears here with the MCPs it is using.</span></div></div>';
  }

  // Activity log — de-noised by the toggle, narrowed by a selected client.
  var actCap = "Activity · " + (state.trafficFilter === "all" ? "everything" : "actions only");
  var countTxt = total.toLocaleString() + (total !== all ? " of " + all.toLocaleString() : "") + " interactions";
  var actHead = '<div class="sec-head" style="padding-top:var(--s5)"><span class="sec-cap">' + esc(actCap) + "</span>" +
    '<span class="hint">' + esc(countTxt) + "</span></div>";
  var body;
  if (!all) {
    body = '<div class="group"><div class="row"><span class="rowmsg">No interactions yet. Every JSON-RPC request a client sends — initialize, tools/list, resources/read, tools/call — is recorded here; the clients above are summarized from it.</span></div></div>';
  } else if (!entries.length) {
    var hint = state.trafficPage
      ? "Nothing on this page."
      : sel
        ? "No activity for this client" + (state.trafficFilter !== "all" ? " in actions-only view." : ".")
        : (state.trafficFilter !== "all" ? "No actions yet — switch to Everything to see the protocol handshake." : "No interactions.");
    body = '<div class="group"><div class="row"><span class="rowmsg">' + esc(hint) + "</span></div></div>";
  } else {
    body = '<div class="group">' + entries.map(trafficRow).join("") + "</div>";
  }

  // Newer/Older, worded and shaped exactly like the tool-call log's pager — same direction, so
  // "Newer" always means toward the top of a newest-first list in both views.
  var pager = (state.trafficPage > 0 || state.trafficMore)
    ? '<div class="pager"><button class="btn" id="trPrev"' + (state.trafficPage > 0 ? "" : " disabled") + ">Newer</button>" +
      "<span>Page " + (state.trafficPage + 1) + "</span>" +
      '<button class="btn" id="trNext"' + (state.trafficMore ? "" : " disabled") + ">Older</button></div>"
    : "";

  // Wrapped in .wide: an interaction row is method + params + client + timing on one line, which the
  // standard measure cannot hold. Wiring below still queries from #pane, so the wrapper is invisible.
  $("pane").innerHTML = '<div class="wide">' + ctrl + clientBlock + actHead + body + pager + "</div>";

  // Every control below re-queries rather than re-filtering in place: the server owns the filter now,
  // so a page of "actions only for claude-code" can only come from asking for exactly that.
  $("trFilter").querySelectorAll("button").forEach(function (b) {
    b.onclick = function () { state.trafficFilter = b.dataset.filter; trafficReload(true); };
  });
  $("pane").querySelectorAll("[data-ckey]").forEach(function (row) {
    row.onclick = function () {
      state.trafficClient = state.trafficClient === row.dataset.ckey ? null : row.dataset.ckey;
      trafficReload(true);
    };
    row.onkeydown = function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); } };
  });
  var tp = $("trPrev"); if (tp) tp.onclick = function () { trafficPageStep(-1); };
  var tn = $("trNext"); if (tn) tn.onclick = function () { trafficPageStep(1); };
  $("pane").querySelectorAll("[data-tog]").forEach(function (s) {
    s.onclick = function () { toggleTraffic(s.dataset.tog); };
    s.onkeydown = function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleTraffic(s.dataset.tog); } };
  });
  var cclr = $("pane").querySelector("[data-cclr]");
  if (cclr) cclr.onclick = function (ev) { ev.stopPropagation(); state.trafficClient = null; trafficReload(true); };
  var clr = $("trClear");
  if (clr) clr.onclick = async function () {
    // Clear the selected client only when one is filtered ("Clear client"); otherwise clear all.
    var sel = state.trafficClient;
    var url = "/api/traffic" + (sel ? "?client=" + encodeURIComponent(sel) : "");
    var j = await apiJson(url, { method: "DELETE" });
    if (!j) return;
    state.trafficOpen = {};
    state.trafficFull = {};
    state.trafficClient = null; // the filtered client is gone (or we cleared all); drop the filter
    trafficReload(true);
  };
}

/** A group header: the sidebar's disclosure vocabulary applied to a full-width card. Built as a
 *  string like the rows beside it; wiring happens in wireTunnels off the data-tg attribute. */
function tunGroupHeadHtml(name, n) {
  var isDefault = name === DEFAULT_GROUP;
  return '<div class="sec-head tun-sec" data-tg="' + esc(name) + '" data-tgt role="button" tabindex="0" ' +
      'title="Collapse or expand this group">' +
      '<span class="tun-sec-cap">' +
        '<span class="tun-chev" aria-hidden="true">&#8250;</span>' +
        '<span class="sec-cap">' + esc(name) + "</span>" +
        '<span class="seg-n tun-count">' + n + "</span>" +
      "</span>" +
      '<span style="display:flex;gap:var(--s2)" data-tgnoclick>' +
        '<button class="btn icon" type="button" data-tgadd title="Add to ' + esc(name) +
          '" aria-label="Add to ' + esc(name) + '">+</button>' +
        (isDefault
          ? "" // the default group cannot be renamed or deleted — no menu, no phantom spacer to hold
          : '<button class="btn icon" type="button" data-tgmore title="Rename or delete this group" aria-label="Group actions">&#8943;</button>') +
      "</span>" +
    "</div>";
}

export { ago, loadTraffic, loadTrafficBody, renderTraffic, toggleTraffic, trafficBodyHtml, trafficPageStep, trafficReload, trafficRow, tunGroupHeadHtml };
