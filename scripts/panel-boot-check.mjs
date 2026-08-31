// Execute the panel's module graph under Node with DOM stubs: surfaces syntax errors AND
// evaluation-time errors — the exact class of failure that blanked the dashboard once.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = join(process.cwd(), "src", "admin", "js");
const el = () => {
  const node = {
    style: {}, dataset: {}, hidden: false, disabled: false, checked: false, value: "", textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => "", removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; }, removeChild(c) { return c; }, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    contains: () => false, closest: () => null,
    insertAdjacentHTML() {}, cloneNode: () => el(),
  };
  return node;
};
globalThis.document = {
  documentElement: el(), body: el(), head: el(),
  hidden: false, visibilityState: "visible", activeElement: null,
  getElementById: () => el(), createElement: () => el(), createTextNode: () => el(),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { reload() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.Blob = class { constructor() {} };
globalThis.TextEncoder = TextEncoder;
globalThis.setInterval = () => 0;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.clearInterval = () => {};

let failed = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
  try {
    await import(pathToFileURL(join(dir, f)).href);
    console.log("OK      " + f);
  } catch (e) {
    failed++;
    console.log("FAIL    " + f + "  ->  " + e.constructor.name + ": " + e.message);
    const at = (e.stack || "").split("\n").find((l) => l.includes("/src/admin/"));
    if (at) console.log("        " + at.trim());
  }
}
process.exit(failed ? 1 : 0);
