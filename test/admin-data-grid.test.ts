import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The panel ships browser ES modules; under Node they evaluate only with DOM globals stubbed —
// the same technique (and stub surface) as the boot check in admin-panel.test.ts.
const el = (): Record<string, unknown> => {
  const node: Record<string, unknown> = {
    style: {}, dataset: {}, hidden: false, disabled: false, checked: false, value: "",
    textContent: "", innerHTML: "",
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    setAttribute: () => {}, getAttribute: () => "", removeAttribute: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    appendChild: (c: unknown) => c, removeChild: (c: unknown) => c, remove: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    focus: () => {}, blur: () => {}, click: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    contains: () => false, closest: () => null, insertAdjacentHTML: () => {},
  };
  node.cloneNode = () => el();
  return node;
};
const doc = {
  documentElement: el(), body: el(), head: el(),
  hidden: false, visibilityState: "visible", activeElement: null,
  getElementById: () => el(), createElement: () => el(), createTextNode: () => el(),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: () => {}, removeEventListener: () => {},
};
const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.assign(globalThis, {
  document: doc, window: globalThis,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { reload: () => {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  confirm: () => true, alert: () => {},
  Blob: class {}, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
});

// Non-literal specifier: the module graph is browser JS outside tsc's purview, same as the
// admin-panel boot test's imports.
const grid = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "admin", "js", "data-grid.js")).href
) as { dbNextSort: (order: string | null, dir: string, name: string) => { order: string; dir: string } | null };

// A header click walks THREE states, not two: ascending -> descending -> back to the table's
// natural (unordered) state, and any other column starts over at ascending. The cycle is a pure
// helper so this file can pin it without a DOM.
describe("data grid header sort cycle", () => {
  it("walks ascending -> descending -> unsorted", () => {
    expect(grid.dbNextSort(null, "asc", "id")).toEqual({ order: "id", dir: "asc" });
    expect(grid.dbNextSort("id", "asc", "id")).toEqual({ order: "id", dir: "desc" });
    expect(grid.dbNextSort("id", "desc", "id")).toBeNull();
    // ...and the cycle restarts cleanly after a clear.
    expect(grid.dbNextSort(null, "asc", "id")).toEqual({ order: "id", dir: "asc" });
  });

  it("starts a freshly clicked column at ascending, whatever was sorted before", () => {
    expect(grid.dbNextSort("other", "desc", "id")).toEqual({ order: "id", dir: "asc" });
    expect(grid.dbNextSort("other", "asc", "id")).toEqual({ order: "id", dir: "asc" });
  });
});

// Leave the worker as we found it, as far as we can.
if (prevWindow) Object.defineProperty(globalThis, "window", prevWindow);
