import { $, TOKEN_ID_KEY, api, apiJson, esc, state } from "./util.js";
import { closeSheet } from "./add-sheet.js";
import { claudeSnippet, copyText, fetchSecret, useToken } from "./connect.js";

/* --- token management ------------------------------------------------------------------------- */
/** List, create, rotate and revoke named per-client tokens. A secret is shown ONCE on create/rotate. */
function openTokensView() {
  state.tokenViewSecret = null;
  paintTokens();
}
/** One `claude mcp add` line per MCP, embedding the given secret — a whole client setup in one copy. */
function connectAll(secret) {
  return (state.mcps || []).map(function (m) { return claudeSnippet(m.name, secret); }).join("\n");
}
async function refreshTokens() {
  var r = await api("/api/tokens");
  if (r.ok) state.tokens = (await r.json()).tokens || [];
}
function rememberedTokenId() {
  try { return localStorage.getItem(TOKEN_ID_KEY); } catch (e) { return null; }
}

/** Same rule as src/token.ts `pickCopyToken` — remembered id, else the `default` label, else first. */
function pickCopyToken(list, remembered) {
  if (!list.length) return null;
  if (remembered) {
    var hit = list.filter(function (t) { return t.id === remembered; })[0];
    if (hit) return hit;
  }
  return list.filter(function (t) { return t.label === "default"; })[0] || list[0] || null;
}

function paintTokens() {
  var list = state.tokens || [];
  // Which token the copy actions embed is real state the user should be able to see and change,
  // rather than "whichever one you touched last". With no prior "Use", copies use `default`.
  var inUse = pickCopyToken(list, rememberedTokenId());
  var rows = list.length ? list.map(function (t) {
    var mine = inUse && t.id === inUse.id;
    return '<div class="row"><div class="row-main">' +
      '<div class="name">' + esc(t.label) + (mine ? ' <span class="tag">copies use this</span>' : '') + '</div>' +
      '<div class="desc">id ' + esc(t.id) + (t.createdAt ? ' · created ' + new Date(t.createdAt).toLocaleString() : '') + '</div>' +
      '</div><div class="row-act">' +
        (mine ? '' : '<button class="btn" data-tkuse="' + esc(t.id) + '">Use</button> ') +
        '<button class="btn" data-tkrot="' + esc(t.id) + '">Rotate</button> ' +
        '<button class="btn danger" data-tkdel="' + esc(t.id) + '">Revoke</button>' +
      '</div></div>';
  }).join("") : '<div class="row"><span class="rowmsg">No tokens.</span></div>';
  var secret = state.tokenViewSecret;
  var secretBox = secret
    ? '<div class="group" style="margin-top:var(--s4)"><div class="row"><div class="row-main">' +
      '<div class="name">New secret — copy now, shown only once</div>' +
      '<input class="v" style="width:100%" value="' + esc(secret) + '" readonly></div></div>' +
      '<div class="form-actions">' +
        '<button class="btn" id="tkCopySecret">Copy secret</button>' +
        '<button class="btn primary" id="tkCopyConn">Copy connect commands (all MCPs)</button>' +
      '</div></div>'
    : "";
  $("sheet").innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="Tokens">' +
      '<div class="sheet-head"><h2>Tokens</h2></div>' +
      '<div class="sheet-body">' +
        '<p class="hint">One token per client. Copied connect commands use the <code>default</code> token unless you click Use. The Traffic tab attributes every request to its token, and to the name the client announces during initialize. A secret is shown once — on create or rotate.</p>' +
        '<div class="two"><input id="tkLabel" placeholder="label, e.g. claude-code">' +
        '<button class="btn primary" id="tkCreate">Create</button></div>' +
        '<div class="group">' + rows + "</div>" +
        secretBox +
      '</div>' +
      '<div class="sheet-foot"><button class="btn primary" id="tkDone">Done</button></div>' +
    '</div>';
  $("sheet").hidden = false;
  $("tkCreate").onclick = async function () {
    var j = await apiJson("/api/tokens", { method: "POST", body: JSON.stringify({ label: $("tkLabel").value }) });
    if (!j) return;
    await refreshTokens();
    state.tokenViewSecret = j.secret;
    paintTokens();
  };
  $("tkDone").onclick = closeSheet;
  $("sheet").onclick = function (e) { if (e.target === $("sheet")) closeSheet(); };
  if (secret) {
    $("tkCopySecret").onclick = function () { copyText(secret, "Token secret"); };
    $("tkCopyConn").onclick = function () { copyText(connectAll(secret), "Connect commands"); };
  }
  Array.prototype.forEach.call($("sheet").querySelectorAll("[data-tkuse]"), function (b) {
    b.onclick = async function () {
      if (await fetchSecret(b.dataset.tkuse)) paintTokens();
    };
  });
  Array.prototype.forEach.call($("sheet").querySelectorAll("[data-tkrot]"), function (b) {
    b.onclick = async function () {
      var j = await apiJson("/api/tokens/" + encodeURIComponent(b.dataset.tkrot) + "/rotate", { method: "POST" });
      if (!j) return;
      await refreshTokens();
      state.tokenViewSecret = j.secret;
      if (rememberedTokenId() === j.id) useToken(j.id, j.secret);
      paintTokens();
    };
  });
  Array.prototype.forEach.call($("sheet").querySelectorAll("[data-tkdel]"), function (b) {
    b.onclick = async function () {
      if (!confirm("Revoke this token? Clients using it stop working immediately.")) return;
      var id = b.dataset.tkdel;
      var j = await apiJson("/api/tokens/" + encodeURIComponent(id), { method: "DELETE" });
      if (!j) return;
      if (rememberedTokenId() === id) {
        state.activeSecret = null;
        try { localStorage.removeItem(TOKEN_ID_KEY); } catch (e) { /* blocked */ }
      }
      await refreshTokens();
      paintTokens();
    };
  });
}

export { connectAll, openTokensView, paintTokens, pickCopyToken, refreshTokens, rememberedTokenId };
