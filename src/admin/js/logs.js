import { esc, state } from "./util.js";
import { rowOf } from "./sidebar.js";

/* --- Logs: what was called, with what, and what came back ------------------------------------- */
function fmtChars(n) {
  return n < 1000 ? n + " chars" : (n / 1000).toFixed(1) + "k chars";
}

/**
 * Format a tool result for reading.
 *
 * A result travels compact — indentation is dead weight in a model's context — but nobody can read a
 * 2 KB single-line object, so the panel expands it here. A trailing "[showing the first N of M …]"
 * note from the gateway is kept out of the parse and re-appended. Anything that is not JSON (a plain
 * string, an error message, a clipped log entry) is shown exactly as it arrived.
 */
function fmtJson(text) {
  if (!text) return "";
  var body = text, tail = "";
  var cut = text.lastIndexOf("\n\n[");
  if (cut > 0 && text.charAt(text.length - 1) === "]") { body = text.slice(0, cut); tail = text.slice(cut); }
  var trimmed = body.trim();
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2) + tail;
  } catch (e) {
    return text; // truncated or not actually JSON — better raw than pretended
  }
}

function callHtml(d, c) {
  var when = new Date(c.at).toLocaleString();
  var meta = when + "  ·  " + c.via + (c.client ? "  ·  " + c.client : "") + "  ·  " + c.ms + " ms  ·  " + fmtChars(c.chars);
  // A page ships only the head of each reply. Offer the rest instead of leaving a dangling tail.
  var full = d.callsFull[c.seq];
  var body = full != null ? full : c.output;
  var more = c.preview && full == null
    ? '<div class="form-actions"><button class="btn" data-full="' + c.seq + '">Show full result (' + esc(fmtChars(c.chars)) + ")</button></div>"
    : "";
  return '<div class="call' + (d.callsOpen[c.seq] ? " open" : "") + '" data-seq="' + c.seq + '">' +
    '<div class="call-sum" data-callseq="' + c.seq + '" role="button" tabindex="0">' +
      '<span class="chev">&#8250;</span>' +
      '<span class="dot ' + (c.ok ? "up" : "down") + '"></span>' +
      '<span class="call-tool">' + esc(c.tool) + "</span>" +
      '<span class="call-arg">' + esc(c.args || "no arguments") + "</span>" +
      '<span class="call-meta">' + esc(meta) + "</span>" +
    "</div>" +
    '<div class="call-body">' +
      '<div class="call-lbl">Arguments</div><pre class="logs">' + esc(fmtJson(c.args) || "(none)") + "</pre>" +
      '<div class="call-lbl">' + (c.ok ? "Result" : "Error") + "</div>" +
      '<pre class="logs' + (c.ok ? "" : " err") + '" data-out="' + c.seq + '">' + esc(fmtJson(body) || "(empty)") + "</pre>" +
      more +
    "</div></div>";
}

function logsBody(d) {
  if (d.calls == null) return '<div class="note"><span class="spin"></span> Loading calls…</div>';
  var head = '<div class="sec-head"><span class="sec-cap">Tool calls · newest first</span>' +
    '<button class="btn" id="callsClear"' + (d.calls.length || d.callsPage ? "" : " disabled") + ">Clear</button></div>";
  var body = d.calls.length
    ? '<div class="group">' + d.calls.map(function (c) { return callHtml(d, c); }).join("") + "</div>"
    : '<div class="group"><div class="row"><span class="rowmsg">' +
      (d.callsPage ? "Nothing on this page." : "No calls yet. Every tool invocation — from an MCP client or from the Run tab — is recorded here with its arguments and its reply, and the log is kept on disk across restarts.") +
      "</span></div></div>";
  var pager = (d.callsPage > 0 || d.callsMore)
    ? '<div class="pager"><button class="btn" id="clPrev"' + (d.callsPage > 0 ? "" : " disabled") + ">Newer</button>" +
      "<span>Page " + (d.callsPage + 1) + "</span>" +
      '<button class="btn" id="clNext"' + (d.callsMore ? "" : " disabled") + ">Older</button></div>"
    : "";
  var err = "";
  if (d.stderr) {
    err = '<div class="sec-head" style="padding-top:var(--s5)"><span class="sec-cap">Child process stderr</span></div>' +
      '<div class="group"><pre class="logs">' + esc(d.stderr) + "</pre></div>";
  } else if ((d.config && d.config.type) === "proc") {
    /* An empty stderr on a proc answers a different question depending on whether a child exists
       yet. Blank space here reads as "logs went missing" — say which of the three blanks it is. */
    var st = (rowOf(d.name) || {}).lifecycle;
    var why = st === "idle"
      ? "No child process yet — a lazy proc starts on the first request (or the Start button). If that start fails, the failure reason and whatever the child printed land here."
      : st === "error"
        ? "The child printed nothing before failing — the failure reason is in this MCP's header and on the Config tab."
        : "The child is running but has printed nothing to stderr — nothing is being swallowed.";
    err = '<div class="sec-head" style="padding-top:var(--s5)"><span class="sec-cap">Child process stderr</span></div>' +
      '<div class="group"><div class="row"><span class="rowmsg">' + why + "</span></div></div>";
  }
  return head + body + pager + err;
}

/** Expand/collapse one call without re-rendering: a poll must not close what you just opened. */
function toggleCall(seq) {
  var d = state.detail;
  if (!d) return;
  d.callsOpen[seq] = !d.callsOpen[seq];
  var node = document.querySelector('#tabbody .call[data-seq="' + seq + '"]');
  if (node) node.className = "call" + (d.callsOpen[seq] ? " open" : "");
}

/** One truncated line of argument names, required ones in bold. `args` is [{ name, req }].
 *  The title carries the full list, because the line is clipped rather than wrapped and a tool with
 *  eight arguments would otherwise lose the last four with no way to see them from here. */
function argLine(args) {
  if (!args.length) return "";
  var plain = args.map(function (a) { return a.name; }).join(", ");
  return '<div class="args" title="' + esc(plain) + '">' + args.map(function (a) {
    return a.req ? "<b>" + esc(a.name) + "</b>" : esc(a.name);
  }).join(", ") + "</div>";
}

function kindBody(d, kind, m) {
  var kd = d[kind];
  // Resources get a master on/off at the top: off empties the list (the capability stays, so the
  // notify stays valid) and tells connected clients to re-list. Symmetric with the per-tool toggle.
  var resToggle = "";
  if (kind === "resources" && kd.loaded) {
    var on = kd.resourceEnabled !== false;
    resToggle = '<div class="row row-act"><div class="row-main"><div class="name">Expose resources</div>' +
      '<div class="desc">' + (on ? "visible to clients" : "hidden — clients see no resources") + "</div></div>" +
      '<button class="sw" role="switch" aria-checked="' + (on ? "true" : "false") +
      '" aria-label="Expose resources" data-restog="' + (on ? "1" : "0") + '" title="' +
      (on ? "Click to hide all resources" : "Click to expose resources") + '"></button></div>';
  }
  if (m.lifecycle !== "started") {
    return '<div class="group"><div class="row"><span class="rowmsg">Not started — start it to list ' + kind + ".</span></div></div>";
  }
  if (kd.loading && !kd.loaded) return '<div class="note"><span class="spin"></span> Loading ' + kind + "…</div>";
  if (kd.error) {
    // Keep the pager: pageNext/pagePrev push the cursor optimistically, so a failed page used to
    // leave the tab with no way back except the global Refresh (which resets to page one).
    var errPager = kd.cursors.length > 1
      ? '<div class="pager"><button class="btn" id="pgPrev">Previous</button><span>Page ' + kd.cursors.length +
        '</span><button class="btn" id="pgNext"' + (kd.nextCursor ? "" : " disabled") + ">Next</button></div>"
      : "";
    return '<div class="group"><div class="row"><span class="rowmsg warn">' + esc(kd.error) +
      "</span></div></div>" + errPager;
  }
  var rows;
  if (!kd.items.length && !(kind === "tools" && kd.disabled && kd.disabled.length)) {
    // An empty list still needs the toggle bar above it (resources can be hidden, not just absent),
    // so this is composed into `rows` and the resToggle header is added by the normal return below
    // rather than short-circuiting out of the function.
    var emptyMsg = kind === "resources" && kd.resourceEnabled === false
      ? "Resources are hidden — turn them on above to expose them to clients."
      : "No " + kind + ".";
    rows = '<div class="row"><span class="rowmsg">' + esc(emptyMsg) + "</span></div>";
  } else {
    rows = kd.items.map(function (it) {
    if (kind === "resources") {
      // Read mirrors the tools' Try button: a resource is only believable once you have seen its
      // contents, and its URI is the whole input, so no form is needed.
      return '<div class="row row-act"><div class="row-main"><div class="name">' + esc(it.uri) + "</div>" +
        (it.name ? '<div class="desc">' + esc(it.name) + "</div>" : "") +
        (it.description ? '<div class="desc">' + esc(it.description) + "</div>" : "") + "</div>" +
        '<button class="btn" data-read="' + esc(it.uri) + '" title="Read this resource">Read</button></div>';
    }
    var args = "";
    if (kind === "prompts" && it.arguments && it.arguments.length) {
      args = argLine(it.arguments.map(function (a) { return { name: a.name, req: !!a.required }; }));
    }
    if (kind === "tools" && it.inputSchema && it.inputSchema.properties) {
      var req = it.inputSchema.required || [];
      args = argLine(Object.keys(it.inputSchema.properties).map(function (k) {
        return { name: k, req: req.indexOf(k) >= 0 };
      }));
    }
    var main = '<div class="name">' + esc(it.name) + "</div>" +
      (it.description ? '<div class="desc">' + esc(it.description) + "</div>" : "") + args;
    // Tools get a Try button: it opens Run with this tool already selected, so a tool can be
    // exercised from the list it was found in. A toggle turns the tool off for clients — it drops
    // out of tools/list and clients are told to re-list (notifications/tools/list_changed).
    if (kind === "tools") {
      return '<div class="row row-act"><div class="row-main">' + main + "</div>" +
        '<button class="btn" data-try="' + esc(it.name) + '" title="Try this tool">Try</button>' +
        '<button class="sw" role="switch" aria-checked="true" aria-label="Visible to clients" data-toggle="' +
        esc(it.name) + '" data-on="1" title="Visible to clients — click to hide"></button></div>';
    }
    return '<div class="row row-b">' + main + "</div>";
  }).join("");
  }

  // Disabled tools are absent from the live list, so they get their own rows here — greyed, with the
  // toggle the other way, so a tool can be switched back on from the same place it was switched off.
  if (kind === "tools" && kd.disabled && kd.disabled.length) {
    rows += '<div class="group-cap">Disabled — not shown to clients</div>';
    rows += kd.disabled.map(function (name) {
      return '<div class="row row-act muted"><div class="row-main"><div class="name">' + esc(name) + "</div>" +
        '<div class="desc">hidden from tools/list until re-enabled</div></div>' +
        '<button class="sw" role="switch" aria-checked="false" aria-label="Visible to clients" data-toggle="' +
        esc(name) + '" data-on="0" title="Turn this tool on"></button></div>';
    }).join("");
  }

  var page = kd.cursors.length;
  var pages = kd.total != null ? " of " + Math.max(1, Math.ceil(kd.total / kd.pageSize)) : "";
  var pager = (page > 1 || kd.nextCursor)
    ? '<div class="pager"><button class="btn" id="pgPrev"' + (page <= 1 ? " disabled" : "") + ">Previous</button>" +
      "<span>Page " + page + pages + (kd.loading ? ' <span class="spin"></span>' : "") + "</span>" +
      '<button class="btn" id="pgNext"' + (kd.nextCursor ? "" : " disabled") + ">Next</button></div>"
    : "";
  return (resToggle ? '<div class="group">' + resToggle + "</div>" : "") + '<div class="group">' + rows + "</div>" + pager;
}

export { argLine, callHtml, fmtChars, fmtJson, kindBody, logsBody, toggleCall };
