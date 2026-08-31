import { $, esc } from "./util.js";
import { histButtonLabel } from "./run-history.js";

/* --- Run: invoke a tool from the panel -------------------------------------------------------- */
/** Argument inputs generated from the tool's own inputSchema, so this works for any MCP the gateway
 *  hosts — including a proc child whose tools the gateway knows nothing about. */
function argFieldsHtml(tool) {
  var schema = tool.inputSchema || {};
  var props = schema.properties || {};
  var required = schema.required || [];
  var keys = Object.keys(props);
  if (!keys.length) return '<div class="hint">This tool takes no arguments.</div>';
  return keys.map(function (k) {
    var p = props[k] || {};
    var id = "r-arg-" + k;
    var kind = p.type === "array" ? "array"
      : p.type === "object" ? "object"
      : p.type === "boolean" ? "boolean"
      : (p.type === "number" || p.type === "integer") ? "number" : "string";
    // Not escaped with the key: the star is markup, so it is concatenated after esc(k), never into it.
    var star = required.indexOf(k) >= 0 ? ' <span class="req-star">*</span>' : "";
    var hint = p.description ? '<div class="hint">' + esc(p.description) + "</div>" : "";
    // esc() on the id too: the key comes from the tool's own inputSchema, and a proc MCP's child
    // controls that completely — an unescaped key like `x" autofocus onfocus="…` breaks out of the
    // attribute and runs on render. getElementById still matches, because the browser decodes the
    // entities back to the raw key when it parses the attribute.
    var attrs = ' id="' + esc(id) + '" data-arg="' + esc(k) + '" data-kind="' + kind + '"';
    if (kind === "boolean") {
      // Name and star in one span: .check is a flex row with an 8px gap, so a bare text node would
      // leave the star floating a gap away from the name it belongs to.
      return '<div><label class="check"><input type="checkbox"' + attrs + "><span>" + esc(k) + star +
        "</span></label>" + hint + "</div>";
    }
    // A constrained field renders as a dropdown rather than a free-text box that shows the allowed
    // values nowhere. The blank first option keeps "leave this argument out" reachable.
    if (Array.isArray(p.enum) && p.enum.length) {
      var opts = '<option value=""></option>' + p.enum.map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(v) + "</option>";
      }).join("");
      return '<div><label class="field"><span>' + esc(k) + star + "  ·  " + esc(kind) + "</span>" +
        "<select" + attrs + ">" + opts + "</select></label>" + hint + "</div>";
    }
    var area = kind === "array" || kind === "object" || k === "sql";
    var itemType = kind === "array" && p.items && p.items.type ? String(p.items.type) : "";
    if (itemType) attrs += ' data-items="' + esc(itemType) + '"';
    var ph = k === "sql" ? "SELECT 1"
      : kind === "array" ? "one value per line" + (itemType ? " (" + itemType + ")" : "")
      : kind === "object" ? "{ }" : "";
    var input = area
      ? "<textarea" + attrs + ' placeholder="' + esc(ph) + '"></textarea>'
      : '<input type="text"' + attrs + ' placeholder="' + esc(ph) + '">';
    return '<div><label class="field"><span>' + esc(k) + star + "  ·  " + esc(kind) + "</span>" + input + "</label>" + hint + "</div>";
  }).join("");
}

function readRunArgs(tool) {
  var out = {};
  var props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
  Object.keys(props).forEach(function (k) {
    var node = $("r-arg-" + k);
    if (!node) return;
    var kind = node.dataset.kind;
    if (kind === "boolean") { if (node.checked) out[k] = true; return; }
    var raw = node.value.trim();
    if (raw === "") return;
    if (kind === "number") { var n = Number(raw); if (!isNaN(n)) out[k] = n; return; }
    if (kind === "array") {
      // Coerce each line to the declared item type: a schema saying items are numbers and getting
      // ["1","2"] is rejected by any server that validates its input.
      var itemType = node.dataset.items || "";
      out[k] = raw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
        if (itemType === "number" || itemType === "integer") { var n = Number(s); return isNaN(n) ? s : n; }
        if (itemType === "boolean") return s === "true" ? true : s === "false" ? false : s;
        return s;
      });
      return;
    }
    if (kind === "object") { try { out[k] = JSON.parse(raw); } catch (e) { throw new Error("`" + k + "` is not valid JSON"); } return; }
    out[k] = raw;
  });
  return out;
}

function runBody(d, m) {
  if (m.lifecycle !== "started") {
    return '<div class="group"><div class="row"><span class="rowmsg">Not started — start it to run a tool.</span></div></div>';
  }
  var kd = d.tools;
  if (kd.loading && !kd.loaded) return '<div class="note"><span class="spin"></span> Loading tools…</div>';
  if (kd.error) return '<div class="group"><div class="row"><span class="rowmsg warn">' + esc(kd.error) + "</span></div></div>";
  var tools = kd.items || [];
  if (!tools.length) return '<div class="group"><div class="row"><span class="rowmsg">This MCP exposes no tools.</span></div></div>';

  var current = null;
  for (var i = 0; i < tools.length; i++) if (tools[i].name === d.run.tool) current = tools[i];
  if (!current) current = tools[0];
  d.run.tool = current.name;

  var opts = tools.map(function (t) {
    return '<option value="' + esc(t.name) + '"' + (t.name === current.name ? " selected" : "") + ">" + esc(t.name) + "</option>";
  }).join("");

  return '<div class="group"><div class="form">' +
      '<label class="field"><span>Tool</span><select id="r-tool">' + opts + "</select></label>" +
      (current.description ? '<div class="hint">' + esc(current.description) + "</div>" : "") +
      argFieldsHtml(current) +
      '<div class="form-actions"><button class="btn primary" id="runBtn">Run</button>' +
        '<div class="hist-wrap">' +
          '<button type="button" id="r-hist" class="hist-sel" aria-haspopup="true" aria-expanded="' +
            (d.run.histOpen ? "true" : "false") +
            '" title="Fill the arguments from a past run — newest first, repeats shown once (up to 300). Type in the box to filter by arguments; hover an entry to read it in full. Secret values stay redacted.">' +
            esc(histButtonLabel(d, current.name)) + "</button>" +
        "</div>" +
        '<span class="run-meta" id="runMeta"></span></div>' +
      '<pre class="logs" id="runOut"></pre>' +
    "</div></div>";
}

export { argFieldsHtml, readRunArgs, runBody };
