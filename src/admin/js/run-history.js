import { $, api, apiJson, esc, state, toast } from "./util.js";
import { closeSheet } from "./add-sheet.js";
import { callsPageStep, cancelEdit, changeEditType, clearCalls, loadPage, pageNext, pagePrev, runConnTest, saveEdit, showFullResult, showTab, startEdit } from "./detail.js";
import { TESTABLE_TYPES, TYPE_FIELDS, TYPE_LABELS, envToText, fieldsHtml } from "./fields.js";
import { fmtChars, fmtJson, logsBody, toggleCall } from "./logs.js";
import { renderPane } from "./pane.js";
import { readRunArgs } from "./run.js";
import { rowOf } from "./sidebar.js";
import { ago } from "./traffic.js";

/* --- Run history: the refill control in the actions row ------------------------------------------ */
/** When an entry ran. Reuses ago() inside a day; past that, ago's time-of-day would be ambiguous,
 *  so the date comes back too. */
function histWhen(iso) {
  return Date.now() - new Date(iso).getTime() < 86400000 ? ago(iso) : new Date(iso).toLocaleString();
}

/** The control's closed label. "↺ Past runs (12)" says what it opens and how much is in it, so the
 *  closed control explains itself without looking like a form value. */
function histButtonLabel(d, tool) {
  if (d.run.histTool !== tool) return "↺ Past runs…"; // never loaded, or a fetch in flight
  var n = (d.run.hist || []).length;
  return n ? "↺ Past runs (" + n + ")" : "↺ No past runs";
}

/** The popover's left pane: one button per DISTINCT argument set, newest first, narrowed to the
 *  runs whose FULL recorded arguments contain the search box's query (the server does that matching —
 *  the 96-char row label would miss a keyword deeper in). The row label is the clipped one-line
 *  preview — the full text is what the right pane is for. */
function histRowsHtml(d, tool) {
  if (d.run.histTool !== tool) return '<div class="hist-empty">loading…</div>';
  var list = d.run.hist || [];
  if (!list.length) {
    return d.run.histQ
      ? '<div class="hist-empty">No runs whose arguments contain ' + esc('"' + d.run.histQ + '"') + ".</div>"
      : '<div class="hist-empty">No runs of this tool recorded yet.</div>';
  }
  return list.map(function (h) {
    return '<button type="button" class="hist-row" data-seq="' + h.seq + '" title="' +
      esc(h.args || "(no arguments)") + '">' + esc(h.args || "(no arguments)") + "</button>";
  }).join("");
}

/** One hovered entry rendered in full: the meta line, the COMPLETE arguments (the row label is
 *  clipped at 96 chars — this is the answer to "let me read the whole thing"), and the reply that
 *  run produced (the stored preview, so a 1 MB reply never loads on a hover). */
function histViewHtml(c) {
  // The identity line: status dot (the panel's universal up/down mark), when, who, how long —
  // not prose glued with dots, so each fact keeps its own weight and nothing runs together.
  var head = '<div class="hist-head">' +
    '<span class="dot ' + (c.ok ? "up" : "down") + '"></span>' +
    "<span>" + esc(histWhen(c.at)) + "</span>" +
    "<span>·</span>" +
    "<span>" + esc(c.via + (c.client ? " (" + c.client + ")" : "")) + "</span>" +
    '<span class="grow"></span>' +
    (c.ms != null ? "<span>" + esc(c.ms + " ms") + "</span>" : "") +
    "</div>";
  var out = head +
    '<div class="call-lbl">Arguments</div><pre class="logs">' +
    esc(fmtJson(c.args) || "(none)") + "</pre>";
  out += '<div class="call-lbl">' + (c.ok ? "Result" : "Error") + "</div>" +
    '<pre class="logs' + (c.ok ? "" : " err") + '">' + esc(fmtJson(c.output) || "(empty)") + "</pre>";
  if (c.preview) {
    out += '<div class="hist-note">Reply shown is its first ' + esc(fmtChars(c.chars)) +
      ' — the full reply lives in the Logs tab.</div>';
  }
  return out;
}

/** Open/close the popover. Opening does not steal focus from the form — the rows are reachable
 *  with the mouse, or with Tab once the control itself has focus. */
function histToggle() {
  var d = state.detail;
  if (!d || d.tab !== "run" || !d.run.tool) return;
  d.run.histOpen ? histClose() : histOpen();
}
function histOpen() {
  var d = state.detail;
  if (!d || d.tab !== "run" || !d.run.tool) return;
  histClose(); // a pane rebuild can leave a stray popover behind under the same id
  var btn = $("r-hist");
  if (!btn || btn.disabled) return;
  d.run.histOpen = true;
  btn.setAttribute("aria-expanded", "true");
  // Appended to <body> and position:fixed — inside the form it was clipped by the .group card's
  // overflow:hidden (the panel's existing pattern: .menu.float and the sheet both do this).
  var r = btn.getBoundingClientRect();
  var pop = document.createElement("div");
  pop.className = "hist-pop";
  pop.id = "r-hist-pop";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - Math.min(780, window.innerWidth * .92) - 8)) + "px";
  // Drop below the button; flip above when that would run off the bottom of the viewport.
  var below = r.bottom + 6;
  var est = Math.min(340, window.innerHeight - 24);
  pop.style.top = (below + est > window.innerHeight ? Math.max(8, r.top - est - 6) : below) + "px";
  // Left pane: the filter box pinned above the rows it narrows. The input is NOT rebuilt while
  // typing — only #r-hist-list's innerHTML is swapped (renderHistoryOnly), so focus survives.
  pop.innerHTML = '<div class="hist-side">' +
      '<div class="hist-search"><input id="r-hist-q" type="search" placeholder="Filter by arguments…" ' +
        'aria-label="Filter past runs by their arguments" autocomplete="off" spellcheck="false"></div>' +
      '<div class="hist-list" id="r-hist-list">' + histRowsHtml(d, d.run.tool) + "</div>" +
    "</div>" +
    '<div class="hist-view" id="r-hist-view">' +
    '<div class="hist-empty">Hover a run to see it in full — the arguments and the reply it produced.</div>' +
    "</div>";
  document.body.appendChild(pop);
  wireHistRows(d);
  var box = $("r-hist-q");
  if (box) {
    box.value = d.run.histQ || "";
    box.oninput = function () { queueHistSearch(d); };
    // The box is where the hand already is — one ArrowDown lands on the first row, no mouse needed.
    box.onkeydown = function (ev) {
      if (ev.key === "ArrowDown") {
        var first = document.querySelector("#r-hist-pop .hist-row");
        if (first) { ev.preventDefault(); first.focus(); }
      }
    };
  }
}
function histClose() {
  window.clearTimeout(histSearchTimer);
  histSearchTimer = null;
  var pop = $("r-hist-pop");
  if (pop) pop.remove();
  var d = state.detail;
  if (d && d.run) {
    d.run.histOpen = false;
    d.run.histSelSeq = null;
    // The query belongs to the popover, not the tool: drop it on close, and when it had narrowed
    // the loaded list, reload the unfiltered one so the closed label's count tells the whole truth.
    if (d.run.histQ) {
      d.run.histQ = "";
      if (d.run.histTool === d.run.tool && d.run.tool) {
        d.run.histTool = null;
        void loadRunHistory(d.name, d.run.tool);
      }
    }
  }
  var btn = $("r-hist");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/** Typing in the filter re-asks the server for this tool's runs containing the text — the match
 *  happens there against the FULL stored arguments, so a hit past the 96-char preview still shows.
 *  Debounced: one scan per pause in typing, not one per keystroke. */
var histSearchTimer = null;
function queueHistSearch(d) {
  var box = $("r-hist-q");
  d.run.histQ = box ? box.value.trim() : "";
  window.clearTimeout(histSearchTimer);
  histSearchTimer = window.setTimeout(function () {
    if (state.detail !== d || !d.run.histOpen) return;
    d.run.histTool = null; // the loaded list answers the old query — force the refetch
    void loadRunHistory(d.name, d.run.tool);
  }, 200);
}

/** Hover/focus a row: show that run in full in the right pane. Entries are cached by seq, and the
 *  seq guard drops a reply that lost the race to a newer hover. */
async function histPreview(seq) {
  var d = state.detail;
  var view = $("r-hist-view");
  if (!d || d.tab !== "run" || !d.run.histOpen || !view) return;
  d.run.histSelSeq = seq;
  var full = d.run.histFull[seq];
  if (!full) {
    view.innerHTML = '<div class="hist-empty"><span class="spin"></span> loading…</div>';
    try {
      var r = await api("/api/mcps/" + encodeURIComponent(d.name) + "/calls/" + encodeURIComponent(seq));
      if (!r.ok) throw new Error("HTTP " + r.status);
      var j = await r.json();
      if (!j.call || state.detail !== d) return;
      full = d.run.histFull[seq] = j.call;
    } catch (e) {
      if (d.run.histSelSeq === seq) view.innerHTML = '<div class="hist-empty">could not load that run</div>';
      return;
    }
  }
  if (d.run.histSelSeq !== seq) return; // a newer hover already won
  view.innerHTML = histViewHtml(full);
}

/** Load the selected tool's newest DISTINCT runs — the full list when the search box is empty, the
 *  runs whose arguments contain d.run.histQ when it is not. Idempotent per tool: a repaint that
 *  re-wires the tab does not refetch. Set d.run.histTool = null first to force a refresh (right
 *  after a run, or on each debounced keystroke in the filter). */
async function loadRunHistory(name, tool) {
  var d = state.detail;
  if (!d || d.name !== name || d.run.histTool === tool || d.run.histLoading) return;
  d.run.histLoading = true;
  var q = d.run.histQ || "";
  try {
    var r = await api("/api/mcps/" + encodeURIComponent(name) + "/tool-history?tool=" +
      encodeURIComponent(tool) + "&limit=300" + (q ? "&q=" + encodeURIComponent(q) : ""));
    if (r.ok) {
      var j = await r.json();
      // A revisit built a new detail object, or the query moved on (a newer keystroke, or the close
      // that reset it) — a stale reply would narrow the list to something nobody asked for. Drop it.
      if (state.detail === d && d.run.histQ === q) {
        d.run.hist = j.entries || [];
        d.run.histTool = tool;
        renderHistoryOnly();
      }
    }
  } catch (e) { /* the control keeps its previous contents */ }
  finally {
    d.run.histLoading = false;
    // This reply lost the race to a newer query (a newer keystroke, or the reset a close performs),
    // and that query's own call was turned away while this one held the loading slot — run it now
    // rather than leave the list answering the old q. Not gated on the popover: a close-during-fetch
    // must still heal the closed label, which would otherwise sit at "Past runs…" forever.
    if (state.detail === d && d.run.histQ !== q && !d.run.histTool) {
      void loadRunHistory(d.name, d.run.tool);
    }
  }
}

/** Repaint only the control's label and (if open) the popover's rows, never the form around it —
 *  the same discipline as renderRunResult, so the SQL being edited survives a post-run refresh. */
function renderHistoryOnly() {
  var d = state.detail;
  if (!d || d.tab !== "run" || !d.run.tool) return;
  var btn = $("r-hist");
  if (btn) {
    btn.textContent = histButtonLabel(d, d.run.tool);
    // "No history at all" disables the control — but a filter that matched nothing must not: the
    // popover is mid-search, its empty state is the answer, and slamming it shut would eat the query.
    btn.disabled = !d.run.histQ && d.run.histTool === d.run.tool && !(d.run.hist || []).length;
    if (btn.disabled && d.run.histOpen) histClose();
  }
  var list = $("r-hist-list");
  if (list && d.run.histOpen) {
    list.innerHTML = histRowsHtml(d, d.run.tool);
    wireHistRows(d);
    if (d.run.histSelSeq != null) void histPreview(d.run.histSelSeq); // keep what was being read
  }
}

/** A run was picked: fetch its full arguments by seq, then write them into the form. */
async function applyRunHistory(seq) {
  var d = state.detail;
  if (!d || !d.run.tool) return;
  var tools = d.tools.items || [];
  var toolDef = null;
  for (var i = 0; i < tools.length; i++) if (tools[i].name === d.run.tool) toolDef = tools[i];
  if (!toolDef) return;
  try {
    var r = await api("/api/mcps/" + encodeURIComponent(d.name) + "/calls/" + encodeURIComponent(seq));
    if (!r.ok) { toast("HTTP " + r.status, true); return; }
    var j = await r.json();
    if (!j.call) return;
    d.run.histFull[seq] = j.call; // the pick just fetched it — a hover later is free
    // Arguments over 4 KB were stored clipped (argsText's overflow marker), so they are no longer
    // parseable JSON — say that precisely instead of the generic read failure.
    if (j.call.args && j.call.args.indexOf("… +") >= 0 && j.call.args.endsWith("more characters")) {
      toast("that run's arguments were too long to store in full — copy them from the Logs tab", true);
      return;
    }
    fillRunArgs(toolDef, JSON.parse(j.call.args || "{}") || {});
  } catch (e) { toast("that run's arguments could not be read", true); }
  histClose();
}

/** Bind the popover's rows: hover/focus previews in full, click refills the form and closes. */
function wireHistRows(d) {
  // NOTE: the popover lives on <body> (histOpen), not inside #tabbody — selecting from #tabbody
  // here is why hover never fired: the rows existed, the wiring found none of them.
  document.querySelectorAll("#r-hist-pop .hist-row").forEach(function (row) {
    row.onclick = function () { void applyRunHistory(Number(row.dataset.seq)); };
    row.onmouseenter = function () { void histPreview(Number(row.dataset.seq)); };
    row.onfocus = function () { void histPreview(Number(row.dataset.seq)); };
  });
}

/** Write one call's arguments into the generated form fields — the inverse of readRunArgs. Fields
 *  the call does not mention are cleared, so nothing stale survives a refill; keys the schema no
 *  longer knows are dropped (the tool would reject them anyway). */
function fillRunArgs(tool, args) {
  var props = (tool.inputSchema && tool.inputSchema.properties) || {};
  Object.keys(props).forEach(function (k) {
    var node = $("r-arg-" + k);
    if (!node) return;
    var kind = node.dataset.kind;
    if (kind === "boolean") { node.checked = args[k] === true; return; }
    var v = args[k];
    if (v === undefined || v === null) { node.value = ""; return; }
    if (kind === "number") { node.value = String(v); return; }
    if (kind === "array") {
      node.value = (Array.isArray(v) ? v : [v]).map(function (x) {
        return x !== null && typeof x === "object" ? JSON.stringify(x) : String(x);
      }).join("\n");
      return;
    }
    if (kind === "object") { node.value = v !== null && typeof v === "object" ? JSON.stringify(v, null, 2) : String(v); return; }
    node.value = String(v); // free-text inputs, the SQL textarea, and the enum dropdown
  });
}

async function runTool() {
  var d = state.detail;
  if (!d || d.run.running) return;
  var tools = d.tools.items || [];
  var toolDef = null;
  for (var i = 0; i < tools.length; i++) if (tools[i].name === d.run.tool) toolDef = tools[i];
  if (!toolDef) return;
  var args;
  try {
    args = readRunArgs(toolDef);
  } catch (err) {
    d.run.result = { ok: false, text: err.message, ms: 0 };
    renderRunResult();
    return;
  }
  d.run.running = true;
  var btn = $("runBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  var meta = $("runMeta");
  if (meta) meta.innerHTML = '<span class="spin"></span>';
  try {
    var r = await api("/api/mcps/" + encodeURIComponent(d.name) + "/call", {
      method: "POST", body: JSON.stringify({ tool: d.run.tool, arguments: args }),
    });
    var j = await r.json().catch(function () { return {}; });
    d.run.result = {
      ok: !!j.ok && !j.isError,
      text: j.text != null && j.text !== "" ? j.text : (j.error || "(no output)"),
      ms: j.ms,
    };
  } catch (e) {
    d.run.result = { ok: false, text: "request failed", ms: 0 };
  }
  d.run.running = false;
  renderRunResult();
  // The run just landed in the log — make it the dropdown's newest entry. histTool=null forces the
  // refetch; renderHistoryOnly swaps the options without touching the form the args sit in.
  d.run.histTool = null;
  void loadRunHistory(d.name, d.run.tool);
}

/** Update only the output and the meta line — never the form, so the SQL you typed survives a run. */
function renderRunResult() {
  var d = state.detail;
  var running = !!(d && d.run.running);
  var btn = $("runBtn");
  // Also called right after a pane rebuild, which may land mid-run — keep the button honest.
  if (btn) { btn.disabled = running; btn.textContent = running ? "Running…" : "Run"; }
  var out = $("runOut"), meta = $("runMeta");
  if (!out || !d) return;
  var res = d.run.result;
  if (!res) { out.textContent = ""; if (meta) meta.textContent = ""; return; }
  // Formatted for reading; the size in the meta line is the real (compact) reply.
  out.textContent = fmtJson(res.text);
  out.className = "logs" + (res.ok ? "" : " err");
  if (meta) {
    var bytes = new TextEncoder().encode(res.text).length;
    meta.textContent = (res.ok ? "ok" : "error") + "  ·  " + (res.ms != null ? res.ms + " ms" : "") +
      "  ·  " + (bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KB");
  }
}

function configBody(d) {
  if (d.editing) {
    var type = d.editType || (d.config && d.config.type) || "proc";
    // Stored values for the MCP's own type, nothing for a different one — then whatever the user has
    // already typed on top, so a type switch or a rejected save doesn't empty the form.
    var vals = Object.assign({}, type === ((d.config && d.config.type) || "proc") ? d.config : {}, d.editVals || {});
    // The stored def carries `lazy`; the form shows its inverse as "Start automatically". A stored
    // def with no lazy at all gets the type's default (proc off, everything else on).
    if (vals.lazy !== undefined) vals.autostart = !vals.lazy;
    else if (vals.autostart === undefined) vals.autostart = type !== "proc";
    var opts = Object.keys(TYPE_FIELDS).map(function (t) {
      return '<option value="' + t + '"' + (t === type ? " selected" : "") + ">" + esc(TYPE_LABELS[t] || t) + "</option>";
    }).join("");
    return '<div class="group"><div class="form">' +
      '<label class="field"><span>Type</span><select id="e-type">' + opts + "</select></label>" +
      fieldsHtml(type, vals, "e-") +
      '<div class="form-actions"><button class="btn primary" id="e-save">Save &amp; Restart</button>' +
      (TESTABLE_TYPES.indexOf(type) >= 0
        ? '<button class="btn" id="e-test">Test connection</button>'
        : "") +
      '<button class="btn" id="e-cancel">Cancel</button></div>' +
      '<div class="hint" id="e-test-out" hidden></div>' +
      "</div></div>";
  }
  var c = d.config;
  if (!c) return '<div class="note"><span class="spin"></span> Loading…</div>';
  var rows = Object.keys(c).map(function (k) {
    var v = c[k];
    if (v == null || v === "") return "";
    /* An array (a rest MCP's tools, a disabled-tool list) is not a KEY=VALUE map — envToText turns one
       into `0=[object Object]`. */
    var text = typeof v === "object" ? (Array.isArray(v) ? JSON.stringify(v) : envToText(v)) : String(v);
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v wrap">' + esc(text) + "</span></div>";
  }).join("");
  var note = d.source === "config"
    ? '<div class="note">Defined in gateway.config.json. Edits are saved as an override in managed.json; ' +
      "<code>${ENV}</code> references are kept as references, so no credential is written to disk.</div>"
    : "";
  return tunnelDepsHtml(d) + '<div class="group">' + rows + "</div>" + note +
    '<div class="form-actions" style="padding-top:var(--s4)"><button class="btn" id="c-edit">Edit configuration…</button></div>';
}

/**
 * The tunnels this MCP's traffic goes through. When a health check fails, the answer to "is it the
 * tunnel or the database?" belongs on the same screen as the failure.
 *
 * The stale-pool line is information only, by explicit decision: a reconnect after this MCP started
 * means its pool may hold sockets of the old SSH session, and the fix is the Restart button that is
 * already there. Nothing restarts an MCP on its own.
 */
function tunnelDepsHtml(d) {
  var t = d.tunnels;
  if (!t || !t.length) return "";
  var rows = t.map(function (x) {
    var dot = x.state === "up" ? "up" : x.state === "error" ? "error" : x.state === "reconnecting" ? "starting" : "";
    return '<div class="row"><span class="k">tunnel</span><span class="v">' +
      '<span class="dot ' + dot + '" style="display:inline-block;margin-right:6px"></span>' +
      esc(x.name) + " · " + esc(String(x.localPort)) + " &rarr; " + esc(x.targetHost + ":" + x.targetPort) +
      " · " + esc(x.state) + (x.reason ? " — " + esc(x.reason) : "") +
      (x.stalePool
        ? '<div class="tun-err">reconnected after this MCP started — its connection pool may hold dead sockets. ' +
          'Use Restart above.</div>'
        : "") +
      "</span></div>";
  }).join("");
  return '<div class="cap">Depends on</div><div class="group">' + rows + "</div><div style=\"height:var(--s5)\"></div>";
}

function wireTabBody(d, m) {
  var prev = $("pgPrev"); if (prev) prev.onclick = pagePrev;
  var next = $("pgNext"); if (next) next.onclick = pageNext;
  var edit = $("c-edit"); if (edit) edit.onclick = startEdit;
  var save = $("e-save"); if (save) save.onclick = saveEdit;
  var cancel = $("e-cancel"); if (cancel) cancel.onclick = cancelEdit;
  var testBtn = $("e-test"); if (testBtn) testBtn.onclick = function () { void runConnTest("e-"); };
  var type = $("e-type"); if (type) type.onchange = function () { changeEditType(type.value); };

  // Tools list → Try
  document.querySelectorAll("#tabbody [data-try]").forEach(function (b) {
    b.onclick = function () { tryTool(b.dataset.try); };
  });

  // Resources list → Read
  document.querySelectorAll("#tabbody [data-read]").forEach(function (b) {
    b.onclick = function () { void readResource(b.dataset.read, b); };
  });

  // Tools list → on/off toggle
  document.querySelectorAll("#tabbody [data-toggle]").forEach(function (b) {
    b.onclick = function () { void toggleTool(b.dataset.toggle, b.dataset.on === "1", b); };
  });

  // Resources → master on/off
  document.querySelectorAll("#tabbody [data-restog]").forEach(function (b) {
    b.onclick = function () { void toggleResources(b.dataset.restog === "1", b); };
  });

  // Logs tab
  var clear = $("callsClear");
  if (clear) clear.onclick = clearCalls;
  var clPrev = $("clPrev"); if (clPrev) clPrev.onclick = function () { callsPageStep(-1); };
  var clNext = $("clNext"); if (clNext) clNext.onclick = function () { callsPageStep(1); };
  document.querySelectorAll("#tabbody [data-callseq]").forEach(function (s) {
    s.onclick = function () { toggleCall(s.dataset.callseq); };
    s.onkeydown = function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleCall(s.dataset.callseq); }
    };
  });
  document.querySelectorAll("#tabbody [data-full]").forEach(function (b) {
    b.onclick = function (ev) { ev.stopPropagation(); showFullResult(b.dataset.full); };
  });

  // Run tab
  var toolSel = $("r-tool");
  if (toolSel) {
    toolSel.onchange = function () { d.run.tool = toolSel.value; d.run.result = null; renderPane(); };
  }
  var histBtn = $("r-hist");
  if (histBtn) {
    histBtn.onclick = function () { histToggle(); };
    // Same guard as renderHistoryOnly: a filter that matched nothing is a search in progress, not
    // an empty history — the control stays clickable so the popover (and its empty state) can open.
    histBtn.disabled = !d.run.histQ && d.run.histTool === d.run.tool && !(d.run.hist || []).length;
  }
  // A pane rebuild drops the popover with the old markup it lived in. If it was open, bring it
  // back over the fresh button; the previewed entry (histSelSeq) is re-shown by histPreview.
  if (d.run.histOpen) {
    d.run.histOpen = false; // histOpen() would no-op behind its own histClose guard
    histOpen();
  }
  // Loading here rather than in showTab: the tool the Run tab will show is only settled once the
  // form is built (runBody falls back to the first tool when none was preselected via Try).
  if (d.tab === "run" && d.run.tool) loadRunHistory(d.name, d.run.tool);
  var runBtn = $("runBtn");
  if (runBtn) {
    runBtn.onclick = runTool;
    // Ctrl/Cmd+Enter runs, so a SQL textarea can be submitted without reaching for the mouse.
    document.querySelectorAll("#tabbody textarea, #tabbody input[type=text]").forEach(function (f) {
      f.addEventListener("keydown", function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { ev.preventDefault(); runTool(); }
      });
    });
  }
  if ($("runOut")) renderRunResult();
}

/** Jump from the Tools list into Run with that tool preselected. */
function tryTool(name) {
  var d = state.detail;
  if (!d) return;
  d.run.tool = name;
  d.run.result = null;
  showTab("run");
}

/** Toggle all of an MCP's resources on/off. Live: the server answers an empty list while off and
 *  pushes notifications/resources/list_changed, so this just fires the change and reloads. */
async function toggleResources(currentlyOn, btn) {
  if (!state.selected) return;
  btn.disabled = true;
  var j = await apiJson("/api/mcps/" + encodeURIComponent(state.selected) + "/resources-toggle", {
    method: "POST",
    body: JSON.stringify({ enabled: !currentlyOn }),
  });
  btn.disabled = false;
  if (!j) return;
  if (j.unchanged) { toast("Already " + (currentlyOn ? "on" : "off")); return; }
  var d = state.detail;
  if (d) { d.resources.loaded = false; d.resources.cursors = []; void loadPage(d.name, "resources"); }
}

/** Toggle a tool on/off for clients. Live: the server filters the next tools/list and pushes
 *  notifications/tools/list_changed, so this just fires the change and reloads the list. */
async function toggleTool(name, currentlyOn, btn) {
  if (!state.selected) return;
  btn.disabled = true;
  var j = await apiJson("/api/mcps/" + encodeURIComponent(state.selected) + "/tools/" + encodeURIComponent(name), {
    method: "POST",
    body: JSON.stringify({ enabled: !currentlyOn }),
  });
  btn.disabled = false;
  if (!j) return;
  if (j.unchanged) { toast("Already " + (currentlyOn ? "on" : "off")); return; }
  // Reload the tools page so the row moves between the enabled list and the disabled group.
  var d = state.detail;
  if (d) { d.tools.loaded = false; d.tools.cursors = []; void loadPage(d.name, "tools"); }
}

/** Read one resource and show its contents. Read-only, so a sheet with no form is the whole UI. */
async function readResource(uri, btn) {
  if (!state.selected) return;
  var label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  var j = await apiJson("/api/mcps/" + encodeURIComponent(state.selected) + "/resource", {
    method: "POST",
    body: JSON.stringify({ uri: uri }),
  });
  if (btn) { btn.disabled = false; btn.textContent = label || "Read"; }
  if (!j) return;
  $("sheet").innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Resource contents">' +
      '<div class="sheet-head"><h2>' + esc(uri) + "</h2></div>" +
      '<div class="sheet-body"><div class="note">' +
        (j.ok ? esc((j.mimeType || "text/plain") + " · " + j.ms + " ms") : '<span style="color:var(--red)">read failed</span>') +
      "</div>" +
      '<pre class="logs" style="max-height:60vh">' + esc(j.text || "") + "</pre></div>" +
      '<div class="sheet-foot"><button class="btn" id="rd-close">Close</button></div>' +
    "</div>";
  $("sheet").hidden = false;
  $("rd-close").onclick = closeSheet;
  $("sheet").onclick = function (e) { if (e.target === $("sheet")) closeSheet(); };
}

/** Repaint only the Logs tab body, so a poll doesn't rebuild the pane (or the header, or the menu).
 *  Expanded rows survive because `callsOpen` is state, not DOM. */
function renderCallsOnly() {
  var d = state.detail;
  if (!d || d.tab !== "logs") return;
  var body = $("tabbody");
  if (!body) return;
  // Repaint only when the log actually changed — otherwise a 6 s poll would scroll an open result
  // back to the top while it is being read.
  var calls = d.calls || [];
  var sig = (calls.length ? calls[0].seq : 0) + ":" + calls.length + ":" + d.stderr.length;
  if (body.dataset.callsig === sig) return;
  body.innerHTML = logsBody(d);
  body.dataset.callsig = sig;
  wireTabBody(d, rowOf(d.name) || {});
}

export { applyRunHistory, configBody, fillRunArgs, histButtonLabel, histClose, histOpen, histPreview, histRowsHtml, histSearchTimer, histToggle, histViewHtml, histWhen, loadRunHistory, queueHistSearch, readResource, renderCallsOnly, renderHistoryOnly, renderRunResult, runTool, toggleResources, toggleTool, tryTool, tunnelDepsHtml, wireHistRows, wireTabBody };
