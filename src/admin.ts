import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
/** The panel's source tree, shipped as-is: index.html + styles/ + js/ (ES modules, no bundler). */
const ADMIN_DIR = join(here, "admin");

/**
 * Read the dashboard shell on each request. Keeps the served UI in sync with edits to src/admin/
 * without a gateway restart, and pairs with a no-store cache header on the route.
 */
export function adminHtml(): string {
  return readFileSync(join(ADMIN_DIR, "index.html"), "utf8");
}

/** Content types the panel actually serves; anything else is refused rather than guessed. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Serve one file under the panel's asset tree (/admin/styles/…, /admin/js/…). Like the shell, each
 * asset is read per request and sent no-store, so a saved edit is live on the next reload. Only
 * known extensions resolve, and the normalized path must stay inside the tree — a traversal-ish
 * request gets a 404, never a file from outside it.
 */
export function adminAsset(urlPath: string): { body: string; type: string } | null {
  // A malformed escape ("/admin/%") makes decodeURIComponent THROW — the same defense http.ts's
  // match() gives its :param segments. A bad escape is simply not an asset we know: 404, never a
  // 500 out of the dispatcher.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = normalize(decoded.replace(/^[\/]+/, ""));
  if (rel.split(sep)[0] !== "admin") return null;
  const full = normalize(join(ADMIN_DIR, rel.slice("admin".length + sep.length)));
  if (full !== ADMIN_DIR && !full.startsWith(ADMIN_DIR + sep)) return null;
  const dot = full.slice(full.lastIndexOf("."));
  const type = MIME[dot];
  if (!type) return null;
  try {
    return { body: readFileSync(full, "utf8"), type };
  } catch {
    return null; // missing asset — the route turns this into a 404
  }
}
