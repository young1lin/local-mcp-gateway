/**
 * MCP resources for the DB adapters: the schema a client attaches with `@`, instead of spending a
 * tool call on it.
 *
 * Two decisions shape everything here.
 *
 * **Nothing is cached, anywhere.** A listing is one live `information_schema` query — fast enough
 * to run through an SSH tunnel on every attach — and a live database keeps gaining tables. A TTL
 * would be wrong more often than it would be useful, and it would turn
 * "I added a table and can't see it" into a class of bug that depends on when you last opened a menu.
 * So there is no cache to invalidate, no `listChanged` capability, and no timer polling the catalog to
 * be able to fire one.
 *
 * **The field set is deliberately narrow.** Claude Code negotiates protocol 2024-11-05 over HTTP (see
 * makeToolServer), where `title`, `icons`, `ttlMs` and `cacheScope` do not exist — and strict parsing
 * of an unknown key rejects the whole reply, which is exactly what already cost us tool `annotations`.
 * Everything worth saying goes into `description`, which every revision has and every client shows.
 */

/** One listed resource. Fields limited to those present in protocol 2024-11-05. */
export interface ResourceEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** One block of resource content, as returned by resources/read. */
export interface ResourceBody {
  uri: string;
  mimeType?: string;
  text: string;
}

/** A parameterized resource, for the tables too numerous to list individually. */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** What an adapter implements to expose resources. */
export interface ResourceProvider {
  list(cursor?: string): Promise<{ resources: ResourceEntry[]; nextCursor?: string }>;
  templates(): ResourceTemplate[];
  read(uri: string): Promise<ResourceBody[]>;
}

/**
 * A URI that names nothing, or a cursor that means nothing.
 *
 * Carried as its own type so the server layer can answer `-32602` as the spec requires, rather than
 * the `-32603` a bare Error would become. The spec also forbids expressing "no such resource" as an
 * empty `contents` array, since that is ambiguous with "exists but is empty".
 */
export class ResourceFault extends Error {}

/** Entries per page of resources/list. */
export const PAGE_SIZE = 200;

/**
 * Cut one page out of a list, cursor being the decimal offset of the next one.
 *
 * The offset is safe as a cursor precisely because nothing is cached: each page is a fresh query with
 * a stable ORDER BY, so a table added between two pages shifts the tail rather than corrupting it.
 */
export function page<T>(items: T[], cursor?: string, size = PAGE_SIZE): { slice: T[]; nextCursor?: string } {
  let start = 0;
  if (cursor != null && cursor !== "") {
    if (!/^\d+$/.test(cursor)) throw new ResourceFault(`invalid cursor: ${cursor}`);
    start = Number(cursor);
    if (start > items.length) throw new ResourceFault(`cursor is past the end of the list: ${cursor}`);
  }
  const end = start + size;
  return { slice: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

/** A table as the catalog reports it, before families are collapsed. */
export interface TableFact {
  name: string;
  /** Approximate rows; undefined when the catalog has no estimate yet. */
  rows?: number;
  /** On-disk bytes; undefined when unknown. */
  bytes?: number;
}

/** A logical table: either one physical table, or a shard set collapsed into a single entry. */
export interface Family {
  /** Display name — the base table when one exists, else `prefix_*`. */
  name: string;
  /** The physical table to read DDL from. */
  representative: string;
  members: string[];
  rows: number;
  bytes: number;
}

/**
 * How many same-prefix tables it takes to be called a shard set.
 *
 * A busy database can hold a thousand `events_*` tables that are a single logical events table, and
 * listing them individually makes every other table unfindable. But a numeric suffix is not proof of
 * sharding — `daily_1 … _4` and `logs_his2` are ordinary distinct tables. Eight is comfortably
 * above the incidental cases and far below any real shard set.
 */
export const SHARD_MIN = 8;

/** Strip a trailing shard suffix: `events_1013`, `stats_202601` → `events`, `stats`. */
function familyKey(name: string): string {
  const key = name.replace(/_?\d{1,8}$/, "");
  // A name that is only digits (or only a suffix) has no prefix to group by — leave it alone.
  return key || name;
}

const fmt = new Intl.NumberFormat("en-US");

/** `3.2 GB`, `12.4 MB`, `812 KB` — for a description a human skims in a picker. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Collapse shard sets, then order by size so the tables that matter come first.
 *
 * Ordering is by bytes descending: in a picker of hundreds of entries, the million-row base table
 * has to appear before a 1,000-row shard of it.
 */
export function collapseShards(tables: TableFact[], minMembers = SHARD_MIN): Family[] {
  const groups = new Map<string, TableFact[]>();
  for (const t of tables) {
    const key = familyKey(t.name);
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const out: Family[] = [];
  for (const [key, members] of groups) {
    const sum = (pick: (t: TableFact) => number | undefined) =>
      members.reduce((a, t) => a + (pick(t) ?? 0), 0);

    if (members.length < minMembers) {
      // Not a shard set: every table stands on its own.
      for (const t of members) {
        out.push({ name: t.name, representative: t.name, members: [t.name], rows: t.rows ?? 0, bytes: t.bytes ?? 0 });
      }
      continue;
    }

    const names = members.map((t) => t.name).sort();
    // The unsuffixed table is the one to read DDL from; without it, any shard will do.
    const base = names.find((n) => n === key);
    out.push({
      name: base ?? `${key}_*`,
      representative: base ?? names[0],
      members: names,
      rows: sum((t) => t.rows),
      bytes: sum((t) => t.bytes),
    });
  }

  return out.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/** `~12,345,678 rows · 4.0 GB · 1015 shards (events_0 … events_1013)` */
export function describeFamily(f: Family): string {
  const parts: string[] = [];
  if (f.rows > 0) parts.push(`~${fmt.format(f.rows)} rows`);
  if (f.bytes > 0) parts.push(humanBytes(f.bytes));
  if (f.members.length > 1) {
    const shards = f.members.filter((n) => n !== f.name);
    parts.push(`${f.members.length} shards (${shards[0]} … ${shards[shards.length - 1]})`);
  }
  return parts.join(" · ");
}

/** Identifiers reach the catalog as bound parameters, but `SHOW CREATE TABLE` cannot bind one. */
const SAFE_IDENT = /^[A-Za-z0-9_$]{1,64}$/;

export function assertIdent(name: string, what: string): string {
  if (!SAFE_IDENT.test(name)) throw new ResourceFault(`not a valid ${what}: ${name}`);
  return name;
}

/**
 * Split `scheme://<authority>/<rest>` without WHATWG URL parsing.
 *
 * `new URL()` lowercases the authority, and on Linux MySQL database names are case-sensitive — a
 * resource URI must round-trip exactly as listed.
 */
export function splitUri(uri: string, scheme: string): { authority: string; rest?: string } {
  const m = new RegExp(`^${scheme}://([^/?#]+)(?:/([^?#]*))?$`).exec(uri);
  if (!m) throw new ResourceFault(`not a ${scheme} resource URI: ${uri}`);
  const rest = m[2] == null || m[2] === "" ? undefined : decodeURIComponent(m[2]);
  return { authority: decodeURIComponent(m[1]), rest };
}
