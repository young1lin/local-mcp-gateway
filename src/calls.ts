import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import { SECRET_ARG_KEY_RE } from "./mask.js";
import { dataPath } from "./datadir.js";
import { chmodPrivate } from "./privfs.js";

/**
 * Per-MCP log of tool invocations: what was called, with which arguments, and what came back.
 *
 * Captured at the tool-call handler — the one point every path crosses (an MCP client over HTTP, and
 * the panel's Run button) — so the log holds exactly the text the caller received, not a
 * reconstruction of it. Child stderr (`Adapter.logs()`) is a different thing entirely: it exists only
 * for proc MCPs and says nothing about what was asked or answered.
 *
 * The log lives on DISK and survives a restart, which is when you most want to know what the last
 * calls were. Nothing accumulates in the heap: the previous in-memory ring cost ~135 KB per MCP
 * resident and still lost everything on restart — worse on both counts.
 *
 * Two layers, because an index and a payload want opposite things:
 * - `<mcp>.jsonl` — one line per call carrying the metadata and the first PREVIEW_MAX characters of
 *   the reply. Small lines keep browsing cheap: a page is one short read from the END of the file, no
 *   matter how much history is behind it.
 * - `bodies/<mcp>/<seq>.txt` — the complete reply, written only when it exceeds the preview. Fetched
 *   by seq when someone actually asks for it, so a 262 KB result is readable in full without every
 *   page read dragging it along. The newest BODY_KEEP are retained per MCP.
 */
export interface CallEntry {
  /** Monotonic per-MCP sequence, recovered from the file across restarts. */
  seq: number;
  at: string;
  tool: string;
  /** "mcp" for a client on the HTTP endpoint, "panel" for the dashboard's Run/Try button. */
  via: string;
  /** The token label that authenticated the request, when via is "mcp" (absent for panel calls). */
  client?: string;
  ok: boolean;
  ms: number;
  /** Arguments as JSON, secret-looking values redacted. */
  args: string;
  /** The reply (or the error message): the preview in a page, the whole thing from readCall(). */
  output: string;
  /** Length of the full reply, even when `output` here is only the preview. */
  chars: number;
  /** True when `output` is only the head of the reply — the UI offers to fetch the rest. */
  preview?: boolean;
  /** True when the complete reply is on disk and can still be fetched. */
  body?: boolean;
  /** Set by readCall when the reply was written but has since been pruned. */
  bodyGone?: boolean;
}

const ARGS_MAX = 4 * 1024;
/** Held inline in the index line, so a page needs no extra reads. */
const PREVIEW_MAX = 2 * 1024;
/** Ceiling on a stored reply. renderResult already caps DB results at 256 KB; a proc child is free to
 *  return anything, and one reply must not become the biggest file in the project. */
const BODY_MAX = 1024 * 1024;
/** Complete replies kept per MCP. Older calls keep their metadata and preview, not their payload. */
const BODY_KEEP = 50;
/** Index budget per MCP: trimmed to the newest KEEP_BYTES once exceeded (~2 KB per line). */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;
/**
 * Retention. The byte budget alone is not a retention policy: it only bites on an MCP that is BUSY.
 * A rarely-used one sits under the budget forever, so its log keeps arguments and replies from years
 * ago that nobody asked to keep. Age is the second bound, and the two are independent — a busy MCP is
 * cut by bytes, a quiet one by age.
 */
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** Sweep at most this often per MCP. Age only matters at day resolution; checking on every append
 *  would read the whole index on the hot path for a boundary that moves once a day. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;
export const CALLS_PAGE_SIZE = 20;

let logDir = dataPath("logs", "calls");

/** Point the log somewhere else (tests use a temp directory). */
export function setCallLogDir(dir: string): void {
  logDir = dir;
  files.clear();
}

function fileFor(mcp: string): string {
  return join(logDir, `${mcp}.jsonl`);
}
/** A directory per MCP, so one name can never be mistaken for the prefix of another. */
function bodyDir(mcp: string): string {
  return join(logDir, "bodies", mcp);
}
function bodyFile(mcp: string, seq: number): string {
  return join(bodyDir(mcp), `${seq}.txt`);
}

/** Per-file write state: next sequence, current size, and a chain that serializes appends. */
interface FileState {
  seq: number;
  bytes: number;
  queue: Promise<void>;
  ready?: Promise<void>;
  /** When the age sweep last ran for this MCP; 0 means "not since boot", so the first append sweeps. */
  sweptAt?: number;
}
const files = new Map<string, FileState>();
let lastErrorLog = 0;

function onError(where: string, err: unknown): void {
  // A log that cannot be written must never break a tool call, but silence would be worse.
  const now = Date.now();
  if (now - lastErrorLog < 30000) return;
  lastErrorLog = now;
  log("warn", "call log write failed", { where, err: err instanceof Error ? err.message : String(err) });
}

/**
 * Old name -> current name, for calls already in flight when a rename happened.
 *
 * `logged()` captures the MCP name when the call starts and appends when it finishes, and
 * `recordCall` is deliberately not awaited — so a rename landing in between would have written a
 * fresh `<oldname>.jsonl` moments after the file was moved, stranding the entry in a file nothing
 * ever reads again. Cleared by forgetCallAlias when the freed name is registered again, so a NEW
 * MCP reusing an old name never inherits the redirect.
 */
const aliases = new Map<string, string>();

function currentName(mcp: string): string {
  let name = mcp;
  // Bounded walk: a chain of renames is short, and a cycle must not hang an append.
  for (let i = 0; i < 8 && aliases.has(name); i++) name = aliases.get(name)!;
  return name;
}

/** Drop a redirect, because this name now belongs to a different MCP. */
export function forgetCallAlias(name: string): void {
  aliases.delete(name);
}

function state(mcp: string): FileState {
  let s = files.get(mcp);
  if (!s) {
    s = { seq: 0, bytes: 0, queue: Promise.resolve() };
    files.set(mcp, s);
    // Recover the sequence and size from whatever is already on disk, once per MCP per boot.
    s.ready = (async () => {
      try {
        const info = await stat(fileFor(mcp));
        s!.bytes = info.size;
        const tail = await tailLines(fileFor(mcp), 1);
        const last = tail.lines[0] ? (JSON.parse(tail.lines[0]) as CallEntry) : undefined;
        if (last?.seq) s!.seq = last.seq;
      } catch {
        /* no file yet */
      }
    })();
  }
  return s;
}

/** Argument names whose value must never be written into a log line — the shared wordlist from
 *  mask.ts (this copy once lacked authorization|api[_-]?key, and apiKey args landed on disk). */
const SECRET_ARG_RE = SECRET_ARG_KEY_RE;
const REDACTED = "•••";

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… +${text.length - max} more characters`;
}

function argsText(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    const json = JSON.stringify(args, (key, value) => (SECRET_ARG_RE.test(key) ? REDACTED : value));
    return clip(json ?? String(args), ARGS_MAX);
  } catch {
    return "[arguments could not be serialized]";
  }
}

/** Flatten a CallToolResult's content blocks into the text a caller actually sees. */
export function contentText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`)).join("\n");
}

export interface CallRecord {
  tool: string;
  args?: unknown;
  ok: boolean;
  ms: number;
  /** Rendered result text, or the error message when ok is false. */
  output: string;
}

/**
 * Append one call to an MCP's log.
 *
 * Deliberately not awaited by the caller: a tool call must not wait on a disk write. Appends for one
 * MCP are chained so lines cannot interleave, and readers flush that chain first, so a call is always
 * visible to the very next read.
 */
export function recordCall(rawMcp: string | undefined, rec: CallRecord): void {
  if (!rawMcp) return; // an adapter built without a name (tests, echo) simply isn't logged
  const mcp = currentName(rawMcp);
  const s = state(mcp);
  const output = rec.output.length > BODY_MAX ? clip(rec.output, BODY_MAX) : rec.output;
  const long = output.length > PREVIEW_MAX;
  const entry: CallEntry = {
    seq: 0, // assigned inside the queue, so concurrent calls cannot claim the same number
    at: new Date().toISOString(),
    tool: rec.tool,
    via: currentCallSource(),
    ...(currentCallClient() ? { client: currentCallClient() } : {}),
    ok: rec.ok,
    ms: rec.ms,
    args: argsText(rec.args),
    output: long ? output.slice(0, PREVIEW_MAX) : output,
    chars: rec.output.length,
    ...(long ? { preview: true, body: true } : {}),
  };
  s.queue = s.queue
    .then(async () => {
      await s.ready;
      entry.seq = ++s.seq;
      await mkdir(logDir, { recursive: true });
      chmodPrivate(logDir, true);
      if (long) {
        await mkdir(bodyDir(mcp), { recursive: true });
        chmodPrivate(bodyDir(mcp), true);
        await writeFile(bodyFile(mcp, entry.seq), output, { encoding: "utf8", mode: 0o600 });
        chmodPrivate(bodyFile(mcp, entry.seq));
        // Keep the newest BODY_KEEP payloads; the index keeps every call either way.
        await rm(bodyFile(mcp, entry.seq - BODY_KEEP), { force: true });
      }
      const line = JSON.stringify(entry) + "\n";
      await appendFile(fileFor(mcp), line, "utf8");
      chmodPrivate(fileFor(mcp));
      s.bytes += Buffer.byteLength(line);
      if (s.bytes > MAX_BYTES) await trim(mcp, s);
      // Inside the queue, so a sweep can never race an append into a half-written file.
      if (Date.now() - (s.sweptAt ?? 0) > SWEEP_EVERY_MS) await sweepAge(mcp, s);
    })
    .catch((err) => onError("append", err));
}

/** Windows transient rename codes: a real-time scanner briefly holds the just-written tmp file. */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * Rewrite a file whole, via tmp + rename (atomic on NTFS and POSIX, like writeJsonAtomic).
 *
 * On Windows a real-time scanner can hold the freshly written tmp for a moment, so the rename fails
 * once with EPERM — which used to make a retention sweep silently no-op until its next hourly try.
 * One short retry absorbs exactly that; anything persistent still propagates to the queue's catch.
 */
export async function writeFileRenamed(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(tmp, data, "utf8");
      await rename(tmp, path);
      return;
    } catch (err) {
      if (attempt >= 1 || !isTransientRenameError(err)) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Drop the oldest history once the file outgrows its budget, keeping the newest KEEP_BYTES.
 *  The read handle closes BEFORE the tmp→rename swap: Windows refuses to replace a file that is
 *  still open, so every trim used to fail EPERM the moment the log first crossed its budget. */
async function trim(mcp: string, s: FileState): Promise<void> {
  const path = fileFor(mcp);
  let kept: Buffer;
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - KEEP_BYTES);
    const buf = Buffer.alloc(info.size - start);
    await handle.read(buf, 0, buf.length, start);
    // Start at the first line boundary, so the file never begins with half an entry.
    const nl = buf.indexOf(0x0a);
    kept = nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0);
  } finally {
    await handle.close();
  }
  await writeFileRenamed(path, kept!);
  s.bytes = kept!.length;
  log("info", "call log trimmed", { mcp, keptBytes: kept!.length });
}

/**
 * Drop entries older than MAX_AGE_MS, and the payload files that belonged to them.
 *
 * The index is append-only and chronological, so everything expired is a prefix of the file: find the
 * first line still in range and keep the rest. Reading the whole index is affordable precisely
 * because MAX_BYTES caps it at 2 MB, and this runs at most hourly per MCP, from inside the write
 * queue — never on a read.
 *
 * A torn line (killed mid-append) has no usable date; it is dropped with the expired prefix rather
 * than treated as current, which is the same thing parseLines does to it on the read side.
 */
async function sweepAge(mcp: string, s: FileState): Promise<void> {
  s.sweptAt = Date.now();
  const path = fileFor(mcp);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return; // no file yet
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  const lines = text.split("\n").filter((l) => l.length);
  let keepFrom = lines.length;
  for (let i = 0; i < lines.length; i++) {
    let at: number;
    try {
      at = Date.parse((JSON.parse(lines[i]) as CallEntry).at);
    } catch {
      continue; // torn or unparseable: leave it in the expired prefix
    }
    if (Number.isFinite(at) && at >= cutoff) { keepFrom = i; break; }
  }
  if (keepFrom === 0) return; // nothing has expired

  const kept = lines.slice(keepFrom);
  const out = kept.length ? kept.join("\n") + "\n" : "";
  await writeFileRenamed(path, out);
  s.bytes = Buffer.byteLength(out);

  // The payloads of the dropped entries are now unreachable — readCall finds no index line for them,
  // so they would sit on disk forever. BODY_KEEP only prunes while an MCP is still being called.
  const oldestKept = kept.length ? (JSON.parse(kept[0]) as CallEntry).seq : Infinity;
  await pruneBodies(mcp, oldestKept);
  log("info", "call log aged out", { mcp, dropped: keepFrom, kept: kept.length });
}

/** Remove payload files for entries no longer in the index. */
async function pruneBodies(mcp: string, oldestKeptSeq: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(bodyDir(mcp));
  } catch {
    return; // no payloads were ever written for this MCP
  }
  await Promise.all(names.map(async (n) => {
    const seq = Number(n.replace(/\.txt$/, ""));
    if (Number.isFinite(seq) && seq < oldestKeptSeq) {
      await rm(join(bodyDir(mcp), n), { force: true });
    }
  }));
}

/**
 * Sweep every call log on disk, and keep sweeping while the gateway runs.
 *
 * The per-append sweep alone leaves exactly the logs retention is FOR: an MCP that stops being
 * called never appends again, so its history would sit there past the cutoff forever. This walks the
 * directory instead of the live `files` map, so it also reaches logs belonging to MCPs that are no
 * longer registered at all.
 *
 * The timer is unref'd — retention is never a reason for the process to stay alive — and the
 * returned stop function exists so a test does not leave one running.
 */
export function startCallRetention(): () => void {
  void sweepCallLogs();
  const timer = setInterval(() => void sweepCallLogs(), SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** One retention pass over every log on disk. Awaitable, so a test does not have to guess. */
export async function sweepCallLogs(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(logDir);
  } catch {
    return; // nothing logged yet
  }
  const done: Array<Promise<void>> = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const mcp = n.slice(0, -".jsonl".length);
    const s = state(mcp);
    // Through the queue, like every other writer, so a sweep cannot land mid-append.
    s.queue = s.queue.then(() => sweepAge(mcp, s)).catch((err) => onError("sweep", err));
    done.push(s.queue);
  }
  await Promise.all(done);
}

/** Wait for pending appends (all MCPs, or one) to reach the file. */
export async function flushCalls(mcp?: string): Promise<void> {
  const pending = mcp ? [files.get(mcp)] : [...files.values()];
  await Promise.all(pending.map((s) => s?.queue));
}

/**
 * Read the last `want` complete lines of a file, newest first.
 *
 * Reads backwards in chunks so paging the newest calls costs one small read no matter how long the
 * history is. Splitting on 0x0A is safe for UTF-8 (a newline byte cannot occur inside a multi-byte
 * sequence), so chunk boundaries never corrupt a character.
 */
export async function tailLines(path: string, want: number): Promise<{ lines: string[]; more: boolean }> {
  const CHUNK = 64 * 1024;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { lines: [], more: false };
  }
  try {
    const { size } = await handle.stat();
    let pos = size;
    let acc = Buffer.alloc(0);
    let atStart = false;
    for (;;) {
      if (pos <= 0) { atStart = true; break; }
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, pos);
      acc = Buffer.concat([buf, acc]);
      // Count complete lines currently held; the first partial line is dropped unless we hit BOF.
      const complete = acc.toString("utf8").split("\n").filter((l) => l.length).length;
      if (complete > want) break;
    }
    let text = acc.toString("utf8");
    if (!atStart) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const all = text.split("\n").filter((l) => l.length);
    const lines = all.slice(-want).reverse();
    return { lines, more: !atStart || all.length > want };
  } finally {
    await handle.close();
  }
}

function parseLines(lines: string[]): CallEntry[] {
  const out: CallEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as CallEntry);
    } catch {
      /* a torn line (killed mid-append) — skip it rather than fail the page */
    }
  }
  return out;
}

export interface CallPage {
  calls: CallEntry[];
  page: number;
  pageSize: number;
  /** True when older entries exist behind this page. */
  more: boolean;
}

/** One page of an MCP's log, newest first. Each entry carries the preview already stored in the index. */
export async function readCalls(mcp: string, page = 0, pageSize = CALLS_PAGE_SIZE): Promise<CallPage> {
  await flushCalls(mcp);
  const size = Math.max(1, Math.min(pageSize, 100));
  const from = Math.max(0, page) * size;
  const tail = await tailLines(fileFor(mcp), from + size + 1);
  const entries = parseLines(tail.lines);
  return {
    calls: entries.slice(from, from + size),
    page: Math.max(0, page),
    pageSize: size,
    more: entries.length > from + size || tail.more,
  };
}

/**
 * One entry with its reply in full — what the panel's "Show full result" button fetches.
 *
 * Scans the index (bounded at MAX_BYTES, and this runs on a click rather than on a poll) for the
 * metadata, then reads the payload beside it. A reply whose payload has been pruned comes back as the
 * preview, flagged, rather than as a silently short result.
 */
export async function readCall(mcp: string, seq: number): Promise<CallEntry | undefined> {
  await flushCalls(mcp);
  const tail = await tailLines(fileFor(mcp), Number.MAX_SAFE_INTEGER);
  const entry = parseLines(tail.lines).find((e) => e.seq === seq);
  if (!entry || !entry.body) return entry;
  try {
    const output = await readFile(bodyFile(mcp, seq), "utf8");
    return { ...entry, output, preview: undefined };
  } catch {
    return { ...entry, bodyGone: true };
  }
}

/** One entry of a single tool's recent-run history — the Run tab's refill dropdown. */
export interface ToolHistoryEntry {
  seq: number;
  at: string;
  via: string;
  client?: string;
  ok: boolean;
  ms: number;
  /** One-line args preview, sized for a dropdown label; the full set is fetched by seq when picked. */
  args: string;
}

/** Fold whitespace and clip, so a stored multi-line args blob still reads as one label line. */
function oneLine(text: string, max = 96): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** How many entries the refill dropdown may list. The index line holds up to 4 KB of args, so the
 *  ceiling keeps the reply bounded however it is asked for. */
export const TOOL_HISTORY_MAX = 300;

/**
 * The newest DISTINCT runs of ONE tool, newest first — what the panel's Run tab offers to refill the
 * argument form with. Both sources are included (the panel's Run button and MCP clients), because
 * "what the client sent last" is as often the thing worth re-running as your own previous attempt.
 *
 * Runs whose arguments are identical are collapsed to one entry — the newest occurrence — because the
 * dropdown answers "what was last executed", not "how often it was executed". Distinctness is decided
 * on the FULL stored arguments, never on the clipped preview: two long argument sets sharing a
 * 96-character prefix are different runs and must not merge. The limit counts DISTINCT entries, so a
 * tool whose whole history is one repeated call lists one entry, not 300 copies of it.
 *
 * `q`, when given, keeps only the runs whose FULL stored arguments contain it (case-insensitive).
 * The match is deliberately NOT on the clipped preview the caller gets back: a keyword sitting past
 * the 96-character label must still find its run — that filter is the dropdown's search box.
 *
 * Same whole-index read readCall() already performs on a "show full result" click: the file is
 * chronological and capped at MAX_BYTES, so one backwards scan filtered by tool name is the whole
 * cost. Args come back as a short single-line preview — the label is all the dropdown shows; the
 * complete arguments of a picked entry are one seq lookup away (readCall).
 */
export async function readToolHistory(
  mcp: string,
  tool: string,
  limit = TOOL_HISTORY_MAX,
  q?: string,
): Promise<ToolHistoryEntry[]> {
  await flushCalls(mcp);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, TOOL_HISTORY_MAX));
  const needle = (q ?? "").trim().toLowerCase();
  const tail = await tailLines(fileFor(mcp), Number.MAX_SAFE_INTEGER);
  const out: ToolHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const e of parseLines(tail.lines)) {
    if (e.tool !== tool) continue;
    if (needle && !e.args.toLowerCase().includes(needle)) continue;
    if (seen.has(e.args)) continue; // same arguments → same dropdown entry; the newest is already in
    seen.add(e.args);
    out.push({
      seq: e.seq,
      at: e.at,
      via: e.via,
      ...(e.client ? { client: e.client } : {}),
      ok: e.ok,
      ms: e.ms,
      args: oneLine(e.args),
    });
    if (out.length >= size) break;
  }
  return out;
}

/** Forget an MCP's history (the panel's Clear button, and deleting an MCP). */
export async function clearCalls(mcp: string): Promise<void> {
  await flushCalls(mcp);
  files.delete(mcp);
  await rm(fileFor(mcp), { force: true });
  await rm(bodyDir(mcp), { recursive: true, force: true });
}

/** Follow a rename, so the history isn't stranded under a name that no longer exists. */
export async function renameCalls(from: string, to: string): Promise<void> {
  await flushCalls(from);
  const s = files.get(from);
  files.delete(from);
  aliases.set(from, to);
  // Re-point anything that already pointed at `from`, so a second rename doesn't leave a stale hop.
  for (const [old, target] of aliases) if (target === from && old !== from) aliases.set(old, to);
  try {
    await rename(fileFor(from), fileFor(to));
    if (s) files.set(to, { seq: s.seq, bytes: s.bytes, queue: Promise.resolve() });
  } catch {
    /* nothing logged under the old name yet */
  }
  await rename(bodyDir(from), bodyDir(to)).catch(() => { /* no stored payloads */ });
}

/**
 * Which entry point a call came in through. An AsyncLocalStorage rather than a parameter because the
 * call crosses the MCP SDK (transport -> Server -> handler), which has nowhere to carry it.
 */
const source = new AsyncLocalStorage<string>();

export function withCallSource<T>(via: string, fn: () => Promise<T>): Promise<T> {
  return source.run(via, fn);
}

export function currentCallSource(): string {
  return source.getStore() ?? "mcp";
}

/**
 * The client (token label) that authenticated this request, carried across the MCP SDK the same way
 * `via` is — set at the bearer gate for client calls, absent for panel calls (which have no token).
 */
const clientCtx = new AsyncLocalStorage<string>();

export function withCallClient<T>(client: string, fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve(clientCtx.run(client, fn));
}

export function currentCallClient(): string | undefined {
  return clientCtx.getStore();
}

/**
 * Wrap a tool-call handler so every invocation lands in the log. `present` turns the result into the
 * logged text and says whether it counts as an error — a tool that reports failure in-band
 * (`isError: true`) never throws, and logging that as a success would make the log lie.
 */
export async function logged<T>(
  mcp: string | undefined,
  tool: string,
  args: unknown,
  run: () => Promise<T>,
  present: (result: T) => { ok: boolean; output: string },
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await run();
    const { ok, output } = present(result);
    recordCall(mcp, { tool, args, ok, ms: Date.now() - t0, output });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordCall(mcp, { tool, args, ok: false, ms: Date.now() - t0, output: message });
    throw err;
  }
}
