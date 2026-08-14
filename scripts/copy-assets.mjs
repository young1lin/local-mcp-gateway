// Copy non-TypeScript assets that the compiled gateway reads at runtime (tsc emits only .ts -> .js).
// admin.ts reads admin.html relative to its own compiled location (dist/), so the HTML must land
// next to dist/*.js. Add more copyFileSync lines here as new runtime assets appear.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/admin.html", "dist/admin.html");
console.log("copied src/admin.html -> dist/admin.html");
