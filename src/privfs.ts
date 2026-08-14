import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

/** Owner-only directory / file modes. On Windows chmod is a no-op beyond the writable bit. */
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;

export function chmodPrivate(path: string, dir = false): void {
  try {
    chmodSync(path, dir ? PRIVATE_DIR : PRIVATE_FILE);
  } catch {
    /* missing, or the OS ignored the mode */
  }
}

export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR });
  chmodPrivate(path, true);
}

export function writeFilePrivate(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf8", mode: PRIVATE_FILE });
  chmodPrivate(path);
}
