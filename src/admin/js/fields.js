import { $, esc } from "./util.js";

/* --- field schemas ---------------------------------------------------------------------------- */
/* `description` leads every type: it is what the MCP client is told this endpoint is for, and with
   several instances of the same engine behind identical tool sets, it is the only thing that says
   which application's data is on the other end. */
var DESC_FIELD = {
  k: "description", label: "Description",
  ph: "What this MCP is for — e.g. IM service Redis, used by the chat backend",
  hint: "Describes the MCP itself. Sent to clients as the server's instructions, together with the connection target.",
};
/* "Start automatically at boot" — the user-facing side of the registry's `lazy` (inverted). A proc
   defaults OFF (its child is the one expensive idle thing here, so it starts on first request and
   is reaped when idle); every other type defaults ON. readFields returns it as `autostart`;
   submitAdd/saveEdit translate it to `lazy` before the server sees it. */
var AUTOSTART_PROC = {
  k: "autostart", label: "Start automatically at boot", bool: true, def: false,
  hint: "Off by default: the first client request spawns the child, and an idle one is reaped after 10 min (idleMs tunes). Adding it here still starts it now.",
};
var AUTOSTART_EAGER = {
  k: "autostart", label: "Start automatically at boot", bool: true, def: true,
  hint: "Off: idle at boot — the first client request starts it.",
};
var TESTABLE_TYPES = ["mysql", "redis", "pg", "mongo", "http", "rest"];
var TYPE_FIELDS = {
  proc: [
    DESC_FIELD,
    { k: "command", label: "Command", ph: "npx -y @modelcontextprotocol/server-git   ·   uvx mcp-server-git" },
    { k: "cwd", label: "Working directory", ph: "optional" },
    { k: "env", label: "Environment (KEY=VALUE per line)", area: true, kv: true, ph: "GIT_REPO=D:\\dev\\project" },
    { k: "exposeResources", label: "Expose resources", bool: true, def: true, hint: "Turn off for a child that publishes thousands of resources." },
    { k: "exposePrompts", label: "Expose prompts", bool: true, def: true },
    { k: "timeoutMs", label: "Call timeout (ms)", num: true, ph: "180000", hint: "How long one tool call may run. Raise it for slow work — image analysis and long scrapes routinely pass a minute." },
    AUTOSTART_PROC,
  ],
  mysql: [
    DESC_FIELD,
    { k: "host", label: "Host", half: true }, { k: "port", label: "Port", num: true, half: true },
    { k: "user", label: "User", half: true }, { k: "password", label: "Password", half: true },
    { k: "database", label: "Database", half: true }, { k: "timezone", label: "Timezone", half: true, ph: "Z" },
    { k: "maxRows", label: "Default row limit", num: true, half: true, ph: "200" },
    { k: "readonly", label: "Read-only", bool: true, hint: "Refuses writes, and sets the session read-only server-side." },
    AUTOSTART_EAGER,
  ],
  redis: [
    DESC_FIELD,
    { k: "host", label: "Host", half: true }, { k: "port", label: "Port", num: true, half: true },
    { k: "password", label: "Password", half: true }, { k: "db", label: "DB index", num: true, half: true },
    { k: "readonly", label: "Read-only", bool: true, hint: "Only read commands are accepted." },
    { k: "allowDestructive", label: "Allow FLUSHALL / FLUSHDB", bool: true },
    { k: "allowEval", label: "Allow Lua (EVAL / FCALL)", bool: true, hint: "A script is opaque to every other rule here — it can reach anything they refuse." },
    AUTOSTART_EAGER,
  ],
  pg: [
    DESC_FIELD,
    { k: "url", label: "Connection URL", area: true, ph: "postgresql://user:pass@127.0.0.1:5432/db?sslmode=disable" },
    { k: "maxRows", label: "Default row limit", num: true, half: true, ph: "200" },
    { k: "readonly", label: "Read-only", bool: true, hint: "Sets default_transaction_read_only on the session." },
    AUTOSTART_EAGER,
  ],
  mongo: [
    DESC_FIELD,
    { k: "url", label: "Connection URL", area: true, ph: "mongodb://user:pass@127.0.0.1:27017/db?authSource=admin" },
    { k: "database", label: "Database (override)", half: true, ph: "defaults to the URL path" },
    { k: "maxRows", label: "Default row limit", num: true, half: true, ph: "200" },
    { k: "readonly", label: "Read-only", bool: true, hint: "Hides the write tools and refuses $out/$merge." },
    AUTOSTART_EAGER,
  ],
  http: [
    DESC_FIELD,
    { k: "url", label: "Endpoint URL", area: true, ph: "https://mcp.context7.com/mcp" },
    {
      k: "headers", label: "Headers (NAME=VALUE per line)", area: true, kv: true,
      ph: "Authorization=Bearer ${CONTEXT7_API_KEY}",
      hint: "Where the remote's API key goes. Prefer a ${ENV_VAR} reference: the key then lives in .env, and neither this panel nor managed.json ever holds it.",
    },
    {
      k: "proxy", label: "Proxy", ph: "http://127.0.0.1:7890 or ${MY_PROXY}",
      hint: "Route THIS MCP's requests through an HTTP(S) proxy — for an endpoint this machine cannot reach directly. Other MCPs are not affected; a ${ENV_VAR} reference works here too.",
    },
    { k: "exposeResources", label: "Expose resources", bool: true, def: true },
    { k: "exposePrompts", label: "Expose prompts", bool: true, def: true },
    AUTOSTART_EAGER,
  ],
  rest: [
    DESC_FIELD,
    { k: "baseUrl", label: "Base URL", ph: "https://api.github.com" },
    {
      k: "headers", label: "Headers (NAME=VALUE per line)", area: true, kv: true,
      ph: "Authorization=Bearer ${MY_API_KEY}",
      hint: "Prefer a ${ENV_VAR} reference: the key then lives in .env, and neither this panel nor managed.json ever holds it.",
    },
    {
      k: "proxy", label: "Proxy", ph: "http://127.0.0.1:7890 or ${MY_PROXY}",
      hint: "Route THIS MCP's requests through an HTTP(S) proxy — for an API this machine cannot reach directly. Other MCPs are not affected.",
    },
    {
      k: "tools", label: "Tool declarations (JSON)", area: true, json: true,
      ph: '[{"name":"get_repo","description":"Get a public GitHub repo.","input":{"owner":{"type":"string","required":true},"repo":{"type":"string","required":true}},"request":{"method":"GET","path":"/repos/{{owner}}/{{repo}}"},"pick":["full_name","description","stargazers_count"]}]',
      hint: "The request block is the vendor's own example with {{arg}} in the slots you want the model to fill. Note {{arg}} for tool arguments — ${VAR} means an environment variable.",
    },
    { k: "timeoutMs", label: "Timeout (ms)", num: true, half: true, ph: "30000" },
    AUTOSTART_EAGER,
  ],
};
var TYPE_LABELS = {
  proc: "proc — spawn a command and proxy it",
  mysql: "mysql — in-process driver",
  redis: "redis — in-process driver",
  pg: "postgres — in-process driver",
  mongo: "mongo — in-process driver",
  http: "http — proxy a remote MCP endpoint",
  rest: "rest — declare tools over a plain HTTP API",
};

function envToText(env) {
  return env ? Object.keys(env).map(function (k) { return k + "=" + env[k]; }).join("\n") : "";
}
function envToObj(text) {
  var o = {};
  String(text || "").split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    var i = line.indexOf("=");
    if (i < 0) return;
    o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return o;
}

/** Render one field. `p` prefixes element ids so the Add sheet and the inline editor can coexist. */
function fieldHtml(spec, val, p) {
  var id = p + spec.k;
  if (spec.bool) {
    var on = val === undefined ? !!spec.def : !!val && val !== "false";
    return '<div><label class="check"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + '>' +
      esc(spec.label) + "</label>" + (spec.hint ? '<div class="hint">' + esc(spec.hint) + "</div>" : "") + "</div>";
  }
  /* `json` fields hold an authored structure (a rest MCP's tool declarations) rather than a value or a
     KEY=VALUE map, so they round-trip as pretty-printed JSON. */
  var v = val == null ? "" : spec.json ? JSON.stringify(val, null, 2) : (typeof val === "object" ? envToText(val) : String(val));
  // A password field is pre-filled with the mask sentinel, and the server keeps the stored secret
  // only while that sentinel comes back untouched. Password-manager autofill silently replacing it
  // would overwrite the real credential on save, with nothing to distinguish that from an edit.
  var fill = /pass|secret|token|key|url|credential/i.test(spec.k) ? ' autocomplete="off" spellcheck="false"' : "";
  var body = spec.area
    ? "<textarea id=\"" + id + '"' + fill + (spec.ph ? ' placeholder="' + esc(spec.ph) + '"' : "") + ">" + esc(v) + "</textarea>"
    : '<input type="text" id="' + id + '" value="' + esc(v) + '"' + fill + (spec.ph ? ' placeholder="' + esc(spec.ph) + '"' : "") + ">";
  return '<div><label class="field"><span>' + esc(spec.label) + "</span>" + body + "</label>" +
    (spec.hint ? '<div class="hint">' + esc(spec.hint) + "</div>" : "") + "</div>";
}

/** Lay a type's fields out, pairing the ones marked `half` into two columns. */
function fieldsHtml(type, vals, p) {
  var specs = TYPE_FIELDS[type] || [];
  var out = "", i = 0;
  while (i < specs.length) {
    if (specs[i].half && specs[i + 1] && specs[i + 1].half) {
      out += '<div class="two">' + fieldHtml(specs[i], vals && vals[specs[i].k], p) +
        fieldHtml(specs[i + 1], vals && vals[specs[i + 1].k], p) + "</div>";
      i += 2;
    } else {
      out += fieldHtml(specs[i], vals && vals[specs[i].k], p);
      i += 1;
    }
  }
  return out;
}

function readFields(type, p) {
  var o = {};
  (TYPE_FIELDS[type] || []).forEach(function (f) {
    var node = $(p + f.k);
    if (!node) return;
    if (f.bool) { o[f.k] = node.checked; return; }
    var raw = node.value;
    if (f.kv) { o[f.k] = envToObj(raw); return; }
    /* Malformed JSON is sent through as the raw string on purpose: the server answers with what is
       wrong with it, which is a better message than anything this form could invent. */
    if (f.json) { try { o[f.k] = JSON.parse(raw); } catch (e) { o[f.k] = raw; } return; }
    if (f.num) { if (raw !== "") o[f.k] = Number(raw); return; }
    if (raw !== "") o[f.k] = raw;
  });
  return o;
}

export { AUTOSTART_EAGER, AUTOSTART_PROC, DESC_FIELD, TESTABLE_TYPES, TYPE_FIELDS, TYPE_LABELS, envToObj, envToText, fieldHtml, fieldsHtml, readFields };
