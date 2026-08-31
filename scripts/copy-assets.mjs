// Copy non-TypeScript assets that the compiled gateway reads at runtime (tsc emits only .ts -> .js).
// admin.ts serves the panel from dist/admin/ relative to its own compiled location, so the whole
// tree — index.html, styles/, js/ — must land there. Files are copied individually so stale outputs
// from deleted sources stand out, and the panel's version stamp (see adminapi.ts) notices any change.
import { cpSync, mkdirSync, rmSync } from "node:fs";

mkdirSync("dist", { recursive: true });
rmSync("dist/admin", { recursive: true, force: true });
cpSync("src/admin", "dist/admin", { recursive: true });
console.log("copied src/admin -> dist/admin");
