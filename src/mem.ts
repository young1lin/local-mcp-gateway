import { execFile } from "node:child_process";
import { log } from "./log.js";

export interface MemoryInfo {
  /** Resident set of the gateway process itself, in MB. Read in-process — free and always current. */
  gatewayMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  /** Summed working set of every proc-MCP child subtree, in MB. Undefined when not measured. */
  childrenMb?: number;
  /** Processes counted: the gateway, plus children when they were measured. */
  processCount: number;
  /** True when proc children exist but were not measured on this call (ask with `tree`). */
  childrenPending: boolean;
  /** Epoch ms of the child measurement (absent when no walk happened). */
  measuredAt?: number;
  at: number;
}

interface TreeResult {
  mb: number;
  count: number;
}

let cache: { at: number; key: string; data: TreeResult } | null = null;
/** Walking the process tree is the expensive part, so a result is reused for this long. */
const CACHE_MS = 20000;

/** Drop the cached child measurement so the next walk re-measures (call after start/stop/restart). */
export function invalidateMemoryCache(): void {
  cache = null;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1048576) * 10) / 10;
}

/**
 * Report the gateway's memory footprint.
 *
 * The gateway's own numbers come from `process.memoryUsage()` — no subprocess, no I/O. Child
 * subtrees are only walked when proc-type MCPs actually exist AND the caller asks for it, because
 * the walk needs a `powershell.exe`, and one of those is ~65 MB of working set and ~350 ms of
 * startup (measured). The previous version spawned one every 4 seconds to render a memory badge,
 * which cost far more memory than everything it was reporting on.
 */
export async function getMemoryInfo(childPids: number[], measureChildren = false): Promise<MemoryInfo> {
  const u = process.memoryUsage();
  const base: MemoryInfo = {
    gatewayMb: mb(u.rss),
    heapUsedMb: mb(u.heapUsed),
    heapTotalMb: mb(u.heapTotal),
    externalMb: mb(u.external),
    processCount: 1,
    childrenPending: false,
    at: Date.now(),
  };

  if (!childPids.length) return { ...base, childrenMb: 0 };
  if (!measureChildren) return { ...base, childrenPending: true };

  const tree = await measureTree(childPids);
  // A walk that failed reports nothing rather than zero: "0 MB across 0 processes" reads exactly
  // like "there are no children", and the moment a WMI query is slow enough to time out is the
  // moment an operator most needs to see that the number is missing rather than wrong.
  if (!tree) return { ...base, childrenPending: true };
  return { ...base, childrenMb: tree.mb, processCount: 1 + tree.count, measuredAt: Date.now() };
}

/** Walks in progress, keyed by PID set, so concurrent callers share one spawn. */
const inFlight = new Map<string, Promise<TreeResult | null>>();

function measureTree(roots: number[]): Promise<TreeResult | null> {
  const key = roots.slice().sort((a, b) => a - b).join(",");
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return Promise.resolve(cache.data);
  // Two clicks on the panel's memory chip must not each spawn a ~65 MB powershell — that cost is
  // the whole reason this measurement is opt-in.
  const running = inFlight.get(key);
  if (running) return running;
  const walk = spawnWalk(key, roots).finally(() => inFlight.delete(key));
  inFlight.set(key, walk);
  return walk;
}

function spawnWalk(key: string, roots: number[]): Promise<TreeResult | null> {
  // BFS each root by ParentProcessId (a proc MCP is cmd.exe -> npx -> the real server, so the
  // descendants are what matter), summing WorkingSet64. Output as "totalBytes|count".
  const script = `
$roots = @(${roots.join(",")})
$all = New-Object System.Collections.Generic.List[int]
$q = New-Object System.Collections.Generic.Queue[int]
foreach ($r in $roots) { $q.Enqueue([int]$r) }
while ($q.Count -gt 0) {
  $p = $q.Dequeue()
  if ($p -eq $PID) { continue }
  [void]$all.Add($p)
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -EA SilentlyContinue | ForEach-Object { $q.Enqueue([int]$_.ProcessId) }
}
$pr = $all | ForEach-Object { Get-Process -Id $_ -EA SilentlyContinue } | Where-Object { $_ }
# Roots sampled but ALL gone by walk time (children exiting) would print "|0" below — an
# authoritative-looking 0 MB. Emit nothing instead: the walker already treats empty output as a
# failed walk, and getMemoryInfo's contract is "report pending, never a confident zero".
if (@($pr).Count -eq 0) { return }
"{0}|{1}" -f (($pr | Measure-Object -Property WorkingSet64 -Sum).Sum), (@($pr).Count)
`.trim();

  // EncodedCommand (UTF-16LE base64) avoids all quoting/escaping pain. Spawn powershell directly
  // (execFile, no shell) so there's no cmd.exe wrapper between gateway and powershell to count.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) {
          // Deliberately not cached — see getMemoryInfo.
          log("warn", "process tree walk failed", { err: err ? err.message : "no output" });
          resolve(null);
          return;
        }
        const [sum, count] = stdout.trim().split("|");
        const data: TreeResult = { mb: mb(Number(sum) || 0), count: Number(count) || 0 };
        cache = { at: Date.now(), key, data };
        resolve(data);
      },
    );
  });
}
