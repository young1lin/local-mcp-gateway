import { TOKEN_ID_KEY, apiJson, state, toast } from "./util.js";
import { kindBody, logsBody } from "./logs.js";
import { closeMenu } from "./pane.js";
import { configBody, histClose } from "./run-history.js";
import { runBody } from "./run.js";
import { pickCopyToken, refreshTokens, rememberedTokenId } from "./tokens.js";

/* --- connecting a client ---------------------------------------------------------------------- */
/**
 * Client configuration is built here, in the browser, from the endpoint URL and the live bearer
 * token (fetched once into state.token). Each copied command embeds the token, so paste = ready — no
 * separate step of exporting the token in whatever shell the command lands in.
 */
function tokenEnv() {
  return (state.info && state.info.tokenEnv) || "MCP_GATEWAY_TOKEN";
}
function endpointUrl(name) {
  return location.origin + "/" + name;
}
/**
 * The secret a copied connect command embeds.
 *
 * Copies use the token last marked with Use, or — with no prior choice — the seed token labeled
 * `default`. That way a fresh panel with several tokens still copies without a prompt (the Cursor
 * IDE browser cannot answer `prompt()`, and a cancelled prompt used to look like a copy failure).
 * When there are no tokens at all it creates `default` rather than sending you to another panel.
 */
async function resolveSecret() {
  await refreshTokens();
  var list = state.tokens || [];

  if (!list.length) {
    var made = await apiJson("/api/tokens", { method: "POST", body: JSON.stringify({ label: "default" }) });
    if (!made) return null;
    await refreshTokens();
    return useToken(made.id, made.secret);
  }

  var pick = pickCopyToken(list, rememberedTokenId());
  if (!pick) return null;
  if (state.activeSecret && rememberedTokenId() === pick.id) return state.activeSecret;
  return fetchSecret(pick.id);
}

async function fetchSecret(id) {
  var j = await apiJson("/api/tokens/" + encodeURIComponent(id) + "/secret");
  if (!j) return null;
  return useToken(j.id, j.secret);
}

/** Remember which token the copy actions embed — by id, so a rotate is picked up automatically. */
function useToken(id, secret) {
  state.activeSecret = secret;
  try { localStorage.setItem(TOKEN_ID_KEY, id); } catch (e) { /* blocked — this session still works */ }
  return secret;
}

/** Copy a connect command for one MCP, embedding the active token secret. */
async function copyConn(name, kind) {
  var secret = await resolveSecret();
  if (!secret) return;
  var text = kind === "claude" ? claudeSnippet(name, secret)
    : kind === "codex" ? codexSnippet(name, secret) : mcpJsonSnippet(name, secret);
  copyText(text, kind === "claude" ? "Claude Code command" : kind === "codex" ? "Codex block" : ".mcp.json entry");
}

/** `claude mcp add` — one line, secret embedded. Runs in any shell (cmd, PowerShell, bash, zsh). */
function claudeSnippet(name, secret) {
  return 'claude mcp add --transport http -s user ' + name + " " + endpointUrl(name) +
    ' --header "Authorization: Bearer ' + secret + '"';
}

/** Codex has no one-line add for an HTTP server, so copy this block into ~/.codex/config.toml. */
function codexSnippet(name, secret) {
  return "[mcp_servers." + name + "]\n" +
    'type = "http"\n' +
    'url = "' + endpointUrl(name) + '"\n' +
    'headers = { "Authorization" = "Bearer ' + secret + '" }';
}

/** A `.mcp.json` entry for project-scoped Claude Code; the secret is inline. */
function mcpJsonSnippet(name, secret) {
  var entry = {};
  entry[name] = { type: "http", url: endpointUrl(name), headers: { Authorization: "Bearer " + secret } };
  return JSON.stringify({ mcpServers: entry }, null, 2);
}

async function copyText(text, label) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else legacyCopy(text);
    toast(label + " copied — the token is embedded.");
  } catch (e) {
    legacyCopy(text);
    toast(label + " copied");
  }
}

/** Fallback for a browser that withholds the async clipboard (or a non-secure origin). */
function legacyCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* nothing else to try */ }
  document.body.removeChild(ta);
}
document.addEventListener("click", function (e) {
  if (state.menuOpen) closeMenu();
  // The Run history popover closes on any click outside itself AND outside the popover — the
  // popover sits on <body>, so clicking its scrollbar or the preview pane must not count as "outside".
  // A row click closes it through applyRunHistory, its own handler.
  var inHist = e.target && e.target.closest && e.target.closest(".hist-wrap, .hist-pop");
  var d = state.detail;
  if (!inHist && d && d.tab === "run" && d.run.histOpen) histClose();
});

function tabBody(d, m) {
  if (d.tab === "run") return runBody(d, m);
  if (d.tab === "config") return configBody(d);
  if (d.tab === "logs") return logsBody(d);
  return kindBody(d, d.tab, m);
}

export { claudeSnippet, codexSnippet, copyConn, copyText, endpointUrl, fetchSecret, legacyCopy, mcpJsonSnippet, resolveSecret, tabBody, tokenEnv, useToken };
