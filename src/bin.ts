#!/usr/bin/env node
import { main } from "./cli.js";

/**
 * The published entry point, kept separate from cli.ts on purpose.
 *
 * The alternative — having cli.ts run itself when it detects that it is the process entry — has to
 * compare `process.argv[1]` against `import.meta.url`, and on POSIX npm installs a bin as a symlink,
 * so those two are different paths and the CLI would silently do nothing. A dedicated file that
 * simply calls main() has no such guess in it.
 */
void main();
