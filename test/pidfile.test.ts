import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listDaemonPorts,
  logFilePath,
  parsePidRecord,
  pidAlive,
  pidFilePath,
  readPidFile,
  removePidFile,
  writePidFile,
  type PidRecord,
} from "../src/pidfile.js";

/** A fresh data dir per test, the way bootstrap.test.ts does it. */
function useHome(): string {
  const h = mkdtempSync(join(tmpdir(), "mcpgw-pid-"));
  process.env.MCP_GATEWAY_HOME = h;
  return h;
}

const REC: PidRecord = {
  pid: 4242,
  port: 19999,
  entry: "D:\\dev\\mcp-gateway\\dist\\index.js",
  node: "D:\\Program Files\\nodejs\\node.exe",
  startedAt: "2026-08-14T15:00:00.000Z",
};

describe("pid file", () => {
  afterEach(() => {
    delete process.env.MCP_GATEWAY_HOME;
  });

  // Named by port, and kept in the data dir rather than beside the config: `lmg status` has to find a
  // running daemon from any cwd, and the port is what makes two instances distinguishable.
  it("lives in the data dir, named by port", () => {
    const h = useHome();
    expect(pidFilePath(19999)).toBe(join(h, "gateway-19999.pid"));
    expect(logFilePath(19999)).toBe(join(h, "gateway-19999.log"));
  });

  it("round-trips a record", () => {
    useHome();
    writePidFile(REC);
    expect(readPidFile(19999)).toEqual(REC);
  });

  it("reports nothing when no daemon was ever started", () => {
    useHome();
    expect(readPidFile(19999)).toBeUndefined();
    expect(listDaemonPorts()).toEqual([]);
  });

  // The file exists precisely to be read after an unclean kill, so a torn one must not throw — that
  // would make `lmg status` fail instead of reporting "not running".
  it("treats a torn or non-JSON file as absent instead of throwing", () => {
    useHome();
    writeFileSync(pidFilePath(19999), '{"pid":4242,"po');
    expect(readPidFile(19999)).toBeUndefined();
    writeFileSync(pidFilePath(19999), "");
    expect(readPidFile(19999)).toBeUndefined();
  });

  // Every field is load-bearing: `port` is how stop() reaches /health, and `entry` is the witness
  // that this PID is still OUR gateway rather than a number the OS recycled into something else.
  it("rejects a record missing anything it will later rely on", () => {
    const bad: unknown[] = [
      null,
      undefined,
      [],
      "x",
      42,
      {},
      { ...REC, pid: 0 },
      { ...REC, pid: -1 },
      { ...REC, pid: 1.5 },
      { ...REC, pid: "4242" },
      { ...REC, port: 0 },
      { ...REC, port: "19999" },
      { ...REC, entry: "" },
      { ...REC, node: "" },
      { ...REC, startedAt: "" },
    ];
    for (const b of bad) expect(parsePidRecord(b), JSON.stringify(b)).toBeUndefined();
    expect(parsePidRecord({ ...REC })).toEqual(REC);
  });

  it("ignores unknown extra keys, so an older or newer writer stays readable", () => {
    expect(parsePidRecord({ ...REC, somethingNew: true })).toEqual(REC);
  });

  it("removes the file, and removing a file that is already gone is not an error", () => {
    useHome();
    writePidFile(REC);
    expect(existsSync(pidFilePath(19999))).toBe(true);
    removePidFile(19999);
    expect(existsSync(pidFilePath(19999))).toBe(false);
    expect(() => removePidFile(19999)).not.toThrow();
  });

  it("lists the ports that have a pid file, sorted, ignoring everything else in the dir", () => {
    const h = useHome();
    writePidFile({ ...REC, port: 19999 });
    writePidFile({ ...REC, port: 8080 });
    writeFileSync(join(h, "managed.json"), "{}");
    writeFileSync(join(h, "gateway-notaport.pid"), "{}");
    writeFileSync(join(h, "gateway-19999.log"), "");
    expect(listDaemonPorts()).toEqual([8080, 19999]);
  });

  it("knows whether a pid is alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2147483647)).toBe(false); // odd and enormous — cannot be a live Windows pid
    expect(pidAlive(0)).toBe(false); // never signal pid 0: that is the whole process group
  });
});
