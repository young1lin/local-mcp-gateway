import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2] ?? "src/admin/js";
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const BUILTIN = new Set(("document window localStorage location history navigator console JSON Math Number String Boolean Object Array Date RegExp " +
  "Error TypeError RangeError encodeURIComponent decodeURIComponent parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval " +
  "fetch confirm prompt alert requestAnimationFrame CSS URL FormData Blob File FileReader performance MutationObserver Event KeyboardEvent " +
  "HTMLSelectElement Element HTMLElement getComputedStyle BigInt Symbol Intl").split(/\s+/));
const KW = ["import","from","export","true","false","null","undefined","this","new","typeof","return",
  "if","else","for","while","do","switch","case","break","continue","try","catch","finally","throw",
  "function","const","let","var","class","extends","of","in","delete","void","instanceof","default",
  "async","await","yield","static","get","set"];
function strip(src) {
  let out = "", i = 0, mode = "code";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === '"') { mode = "dq"; i++; continue; }
      if (c === "'") { mode = "sq"; i++; continue; }
      out += c; i++;
    } else if (mode === "line") { if (c === "\n") { mode = "code"; out += "\n"; } else i++; }
    else if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i += 2; } else i++; }
    else if (mode === "dq") { if (c === "\\") i += 2; else if (c === '"') mode = "code"; else i++; }
    else if (mode === "sq") { if (c === "\\") i += 2; else if (c === "'") mode = "code"; else i++; }
  }
  return out;
}
let problems = 0;
for (const f of files) {
  const raw = readFileSync(join(dir, f), "utf8");
  const src = strip(raw);
  const known = new Set(BUILTIN);
  KW.forEach((k) => known.add(k));
  for (const m of raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/g))
    m[1].split(",").forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop(); if (n) known.add(n); });
  for (const m of raw.matchAll(/import\s+([\w$]+)\s+from\s*"\.\/([^"]+)"/g)) known.add(m[1]);
  for (const m of src.matchAll(/(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of src.matchAll(/\(\s*([^()]*)\)\s*(?:=>|\{)/g))
    m[1].split(",").forEach((p) => { const n = p.trim().split(/\s*=/)[0].replace(/\.\.\./, "").split(":").pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) known.add(n); });
  for (const m of src.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) known.add(m[1]);
  const missing = new Set();
  for (const m of src.matchAll(/(?<![.\w$'"])([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    if (known.has(name) || missing.has(name)) continue;
    missing.add(name);
  }
  if (missing.size) { problems++; console.log(f + " free: " + [...missing].join(", ")); }
}
console.log(problems ? "PROBLEMS: " + problems : "clean");
