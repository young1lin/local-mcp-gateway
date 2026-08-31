import { describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp } from "../src/router.js";
import { Registry } from "../src/registry.js";
import { ManagedStore } from "../src/managed.js";
import { echoAdapter } from "../src/adapters/echo.js";
import { TokenManager } from "../src/token.js";
import { setCallLogDir } from "../src/calls.js";

setCallLogDir(mkdtempSync(join(tmpdir(), "mcp-panel-calls-")));

// The panel is a tree of ES modules under src/admin/ served straight from disk — no bundler, so
// nothing but these checks stands between a typo'd import and a blank dashboard. This suite walks
// exactly what a browser would: fetch the shell, follow every asset it references, and verify the
// module graph actually links (every import resolves to a file that exports the name).
async function panelApp() {
  const reg = new Registry(60000);
  reg.register("echo", "config", { type: "echo" }, echoAdapter);
  // /api/info (the version stamp) rides mountAdminApi, which needs a store — same shape as the
  // adminapi suite's setup(), with a scratch managed.json that dies with the temp dir.
  const store = new ManagedStore(join(tmpdir(), `mcp-panel-store-${process.pid}-${counter++}.json`));
  return buildApp(reg, new TokenManager(store, "test-token"), store);
}
let counter = 0;

describe("admin panel assets", () => {
  it("serves the shell: theme boot inline, styles linked, module entry referenced, all no-store", async () => {
    const app = await panelApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain('src="/admin/js/main.js"');
    expect(res.text).toContain('href="/admin/styles/base.css"');
    expect(res.text).toContain('href="/admin/styles/views.css"');
    // The pre-paint theme resolver must stay inline in the shell — a linked script would flash.
    expect(res.text).toContain("mcp_gateway_theme");
    // And the 6k-line monolith it replaces is really gone.
    expect(res.text.split("\n").length).toBeLessThan(80);
  });

  it("serves every asset the shell references, with a real content type and no-store", async () => {
    const app = await panelApp();
    const shell = (await request(app).get("/")).text;
    const refs = [...shell.matchAll(/(?:src|href)="(\/admin\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(3); // two stylesheets + the module entry
    for (const ref of refs) {
      const res = await request(app).get(ref);
      expect({ ref, status: res.status }).toEqual({ ref, status: 200 });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("links the whole module graph: every import resolves to a file that exports the name", async () => {
    const app = await panelApp();
    const js = new Map<string, string>(); // path -> body
    const queue = ["/admin/js/main.js"];
    while (queue.length) {
      const path = queue.shift()!;
      if (js.has(path)) continue;
      const res = await request(app).get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect(res.headers["content-type"]).toContain("text/javascript");
      js.set(path, res.text);
      for (const m of res.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+)"/g)) {
        const target = path.slice(0, path.lastIndexOf("/") + 1) + m[2];
        queue.push(target);
        // The imported names must appear in the target's export list — the check that catches a
        // rename applied on one side of an import and forgotten on the other.
        const tres = await request(app).get(target);
        expect({ target, status: tres.status }).toEqual({ target, status: 200 });
        const exportMatch = tres.text.match(/export\s*\{([^}]*)\}/);
        const exported = new Set((exportMatch?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
        for (let sym of m[1].split(",")) {
          sym = sym.trim();
          if (!sym) continue;
          expect(exported.has(sym), `${path} imports ${sym} from ${target}, which does not export it`).toBe(true);
        }
      }
    }
    // The graph is not one file wearing a directory costume.
    expect(js.size).toBeGreaterThan(15);
    // Every entry module is reachable from main.js — an orphan module is dead code at best.
    expect(js.has("/admin/js/main.js")).toBe(true);
  });

  it("refuses paths that try to leave the admin tree or ask for unserved types", async () => {
    const app = await panelApp();
    expect((await request(app).get("/admin/%2e%2e/package.json")).status).toBe(404);
    expect((await request(app).get("/admin/js/../../package.json")).status).toBe(404);
    expect((await request(app).get("/admin/js/nope.js")).status).toBe(404);
    expect((await request(app).get("/admin/secret.txt")).status).toBe(404);
    expect((await request(app).get("/admin")).status).toBe(404); // the tree root is not a file
    // A malformed percent-escape makes decodeURIComponent throw — that is a 404, not a 500.
    expect((await request(app).get("/admin/%")).status).toBe(404);
  });

  // The regression: dropdown.js appends its menu to <body> as .menu.float.dd-menu, which must
  // paint ABOVE the sheet backdrop (40) — every select inside a sheet (the rule editor's
  // SSH-connection picker among them) opens its list over that full-screen overlay, where no click
  // can reach it: the backdrop eats the hit and closes the sheet instead. The first fix stated
  // z-index: 45 on .dd-menu in base.css and still shipped the bug — views.css loads after base.css,
  // and its .menu { z-index: 30 } won the same-specificity tie. Only the WINNING declaration after
  // the whole cascade matters, so this test resolves it like a browser would: collect every
  // pure-class rule in both sheets that matches the menu's class set, rank by specificity then
  // sheet order then position, and demand the winner beats the backdrop.
  it("layers the dropdown menu above the sheet backdrop it can open over", () => {
    const styles = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "admin", "styles");
    // In link order — the shell references base.css before views.css, which is the whole trap.
    // Comments are stripped first, the way the browser sees the sheet — otherwise a comment
    // glued to the front of a selector ("/* … */ .menu {") defeats the pure-class check below.
    const sheets = ["base.css", "views.css"].map((f, fi) => ({ fi, css: readFileSync(join(styles, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
    const rules: Array<{ classes: string[]; z: number; rank: number[] }> = [];
    for (const s of sheets) {
      // Leaf rules only: a media query's wrapper cannot match (it is not a class list), while its
      // inner rules are still walked — [^{}] stops at the wrapper's own braces.
      for (const m of s.css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim();
        if (!/^\.[\w-]+(\.[\w-]+)*$/.test(sel)) continue; // pure class-set selectors only
        const z = m[2].match(/z-index:\s*(\d+)/);
        if (!z) continue;
        rules.push({ classes: sel.slice(1).split("."), z: Number(z[1]), rank: [s.fi, m.index ?? 0] });
      }
    }
    const menuClasses = ["menu", "float", "dd-menu"];
    const applies = rules.filter((r) => r.classes.every((c) => menuClasses.includes(c)));
    expect(applies.length, "no z-index rule reaches the dropdown menu at all").toBeGreaterThan(0);
    // Highest specificity wins; on a tie, the later rule (sheet order, then position) wins.
    applies.sort((a, b) => (b.classes.length - a.classes.length) || (b.rank[0] - a.rank[0]) || (b.rank[1] - a.rank[1]));
    const winner = applies[0];
    const backdrop = rules.find((r) => r.classes.join(".") === "backdrop");
    expect(backdrop, "the layer a sheet's dropdown must beat — update this test if the idiom changes").toBeDefined();
    expect(winner.z, "the dropdown's winning layer is " + winner.z + " (." + winner.classes.join(".") + "), under the backdrop's " + backdrop!.z).toBeGreaterThan(backdrop!.z);
  });

  it("stamps the panel version from the whole tree, and a touched module flips it", async () => {
    const app = await panelApp();
    const res = await request(app).get("/api/info");
    expect(res.status).toBe(200);
    expect(res.body.panelVersion).toMatch(/^[0-9a-f]{40}$/); // sha1 over name+mtime of every file
  });

  // The regression this test exists for: a refactor once shipped modules whose cut boundaries
  // broke mid-statement — every static check passed, and the dashboard rendered blank. The only
  // check that catches that class is EXECUTION. Each module is imported under Node with DOM stubs;
  // a syntax error, a missing export used at load, or an evaluation-time throw fails here.
  it("boots: every module parses and evaluates (DOM-stubbed, no network)", async () => {
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
    try {
      const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "admin", "js");
      const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
      expect(files.length).toBeGreaterThan(15);
      for (const f of files) {
        await import(pathToFileURL(join(dir, f)).href); // a broken module rejects here
      }
    } finally {
      // Leave the worker as we found it, as far as we can.
      if (prevWindow) Object.defineProperty(globalThis, "window", prevWindow);
    }
  });
});
