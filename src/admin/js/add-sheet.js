import { $, DEFAULT_GROUP, apiJson, esc, state, toast } from "./util.js";
import { openDetail, runConnTest } from "./detail.js";
import { TESTABLE_TYPES, TYPE_FIELDS, TYPE_LABELS, fieldsHtml, readFields } from "./fields.js";
import { loadList } from "./polling.js";
import { newGroup } from "./sidebar.js";

/* --- Add sheet -------------------------------------------------------------------------------- */
/** `group` is the group the new MCP joins — the header + that opened this sheet. */
function openSheet(group) {
  state.addGroup = group || DEFAULT_GROUP;
  var into = state.addGroup === DEFAULT_GROUP ? "" : " to " + state.addGroup;
  var types = Object.keys(TYPE_FIELDS);
  var opts = types.map(function (t) { return '<option value="' + t + '">' + esc(TYPE_LABELS[t] || t) + "</option>"; }).join("");
  $("sheet").innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Add an MCP">' +
      '<div class="sheet-head"><h2>Add an MCP' + esc(into) + "</h2></div>" +
      '<div class="sheet-body">' +
        '<div class="two">' +
          '<label class="field"><span>Name</span><input id="a-name" placeholder="git-mcp" autocomplete="off"></label>' +
          '<label class="field"><span>Type</span><select id="a-type">' + opts + "</select></label>" +
        "</div>" +
        '<div id="a-fields"></div>' +
        '<label class="check"><input type="checkbox" id="a-start" checked>Start it now</label>' +
        '<div class="hint" id="a-test-out" hidden></div>' +
      "</div>" +
      '<div class="sheet-foot"><button class="btn" id="a-import">Import .mcp.json</button>' +
        '<input id="a-file" type="file" accept=".json,application/json" hidden>' +
        '<span class="grow"></span>' +
        '<button class="btn" id="a-cancel">Cancel</button>' +
        '<button class="btn" id="a-test" hidden>Test connection</button>' +
        '<button class="btn primary" id="a-save">Add</button></div>' +
    "</div>";
  $("sheet").hidden = false;
  var paint = function () {
    $("a-fields").innerHTML = fieldsHtml($("a-type").value, {}, "a-");
    // The test button exists only for the types that have something to test.
    var tb = $("a-test");
    if (tb) tb.hidden = TESTABLE_TYPES.indexOf($("a-type").value) < 0;
  };
  paint();
  $("a-type").onchange = paint;
  $("a-cancel").onclick = closeSheet;
  $("a-test").onclick = function () { void runConnTest("a-"); };
  $("a-save").onclick = submitAdd;
  $("a-import").onclick = function () { $("a-file").click(); };
  $("a-file").onchange = function () { void submitImport($("a-file")); };
  $("sheet").onclick = function (e) { if (e.target === $("sheet")) closeSheet(); };
  $("a-name").focus();
}
function closeSheet() { $("sheet").hidden = true; $("sheet").innerHTML = ""; }

async function submitImport(input) {
  var f = input && input.files && input.files[0];
  if (!f) return;
  var text;
  try { text = await f.text(); } catch (e) { toast("Could not read file", true); return; }
  var json;
  try { json = JSON.parse(text); } catch (e) { toast("Not valid JSON", true); return; }
  var j = await apiJson("/api/mcps/import", { method: "POST", body: JSON.stringify(json) });
  if (!j) return;
  closeSheet();
  var n = (j.imported || []).length;
  var s = (j.skipped || []).length;
  toast("Imported " + n + (s ? ", skipped " + s : ""));
  if (j.imported && j.imported[0]) state.selected = j.imported[0].name;
  await loadList();
  if (state.selected) openDetail(state.selected);
}

async function submitAdd() {
  var type = $("a-type").value;
  var body = Object.assign({ name: $("a-name").value.trim(), type: type, enabled: $("a-start").checked }, readFields(type, "a-"));
  if (body.autostart !== undefined) { body.lazy = !body.autostart; delete body.autostart; }
  if (!body.name) { toast("Name is required", true); return; }
  if (type === "proc" && !body.command) { toast("Command is required", true); return; }
  var j = await apiJson("/api/mcps", { method: "POST", body: JSON.stringify(body) });
  if (!j) return;
  closeSheet();
  toast("Added " + body.name + " (" + (j.lifecycle || "stopped") + ")");
  state.selected = body.name;
  // Join the group whose + opened this sheet, BEFORE the list reload — so the row is drawn in its
  // group once, rather than appearing under `default` and hopping a moment later.
  if (state.addGroup && state.addGroup !== DEFAULT_GROUP) {
    await apiJson("/api/mcps/" + encodeURIComponent(body.name) + "/group",
      { method: "PUT", body: JSON.stringify({ group: state.addGroup }) });
  }
  await loadList();
  openDetail(body.name);
}
// The sidebar header's + makes a GROUP — that is the only thing that belongs to the sidebar as a
// whole. Adding an MCP belongs to a group, so it lives on each group's own + instead.
$("addBtn").onclick = newGroup;

export { closeSheet, openSheet, submitAdd, submitImport };
