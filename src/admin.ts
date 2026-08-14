import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(here, "admin.html");

/**
 * Read the dashboard HTML on each request. Keeps the served UI in sync with edits to admin.html
 * without a gateway restart, and pairs with a no-store cache header on the route.
 */
export function adminHtml(): string {
  return readFileSync(HTML_PATH, "utf8");
}
