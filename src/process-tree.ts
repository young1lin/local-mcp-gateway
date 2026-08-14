import { execFile } from "node:child_process";
import { log } from "./log.js";

/**
 * Force-kill a process AND its whole descendant tree.
 *
 * Why this exists: the MCP SDK's StdioClientTransport spawns the launch command (e.g.
 * `npx -y @pkg`), which on Windows expands to cmd.exe -> node(npx) -> node(the real server). Its
 * `close()` only `abort()`s the direct child; killing a parent on Windows does NOT cascade to
 * children, so the real server survives as an orphan (the root cause of the orphan leak).
 * `taskkill /T /F` is the only reliable way to tear down the entire subtree, any depth.
 */
export function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      // /T = kill the process tree (all descendants); /F = force (no graceful phase).
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      // Posix fallback: the SDK doesn't spawn a detached process group, so a plain SIGTERM to the
      // direct pid is the best we can do without a tree walk. This gateway runs on Windows; the
      // win32 path above is the one that matters in production.
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
      resolve();
    }
  });
}

/**
 * The PIDs of `ownPid` and every descendant (any process type), via a PowerShell parent->child walk.
 * A reaper uses it to refuse to touch a stale-ledger PID the OS has since handed to one of THIS
 * instance's own freshly-spawned children — the safety net against PID reuse. Win32 only; elsewhere
 * returns just `ownPid` (the reaper is a no-op off Windows).
 */
export function descendantPidsOf(ownPid: number): Promise<Set<number>> {
  const out = new Set<number>([ownPid]);
  if (process.platform !== "win32") return Promise.resolve(out);
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$kids = @{}
foreach ($p in $all) { $pp = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.Generic.List[int] }; [void]$kids[$pp].Add([int]$p.ProcessId) }
$legit = New-Object System.Collections.Generic.HashSet[int]; [void]$legit.Add(${ownPid})
$q = New-Object System.Collections.Generic.Queue[int]; $q.Enqueue(${ownPid})
while ($q.Count -gt 0) { $c = $q.Dequeue(); $list = $kids[$c]; if ($list) { foreach ($k in $list) { if (-not $legit.Contains($k)) { [void]$legit.Add($k); $q.Enqueue($k) } } } }
$legit | ForEach-Object { $_ }
`.trim();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (!err && stdout) {
        for (const line of stdout.trim().split(/\r?\n/)) {
          const n = Number(line.trim());
          if (Number.isFinite(n) && n > 0) out.add(n);
        }
      }
      resolve(out); // a PowerShell failure degrades to "only ownPid" — safe (reaps nothing extra)
    });
  });
}

// Command-line substrings that identify the MCP packages this gateway launches. Used by the
// startup orphan sweep. Extend when new packages are added to gateway.config.json.
const MCP_PACKAGE_RE = "mcp-server-mysql|postgres-mcp-server|redis-mcp-server";

/**
 * Find node processes running one of our MCP packages that are NOT descendants of `ownPid` —
 * i.e. orphaned by a previous gateway instance that was hard-killed (task /End, crash) before its
 * close() could tree-kill them. Returns their PIDs.
 *
 * Builds the descendant set of this process with PowerShell, following ALL process types (not just
 * node) so the cmd.exe / npx layers in the spawn chain are walked correctly — a node-only walk
 * would break at cmd.exe and falsely flag live servers as orphans.
 */
function findOrphanMcps(ownPid: number): Promise<number[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const script = `
$gw = ${ownPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$children = @{}
foreach ($p in $all) { $pp = [int]$p.ParentProcessId; if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.Generic.List[int] }; [void]$children[$pp].Add([int]$p.ProcessId) }
$legit = @{}; $q = New-Object System.Collections.Generic.Queue[int]; $q.Enqueue($gw); $legit[$gw] = $true
while ($q.Count -gt 0) { $c = $q.Dequeue(); $kids = $children[$c]; if ($kids) { foreach ($k in $kids) { if (-not $legit.ContainsKey($k)) { $legit[$k] = $true; $q.Enqueue($k) } } } }
$pat = '${MCP_PACKAGE_RE}'
$all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match $pat -and -not $legit.ContainsKey([int]$_.ProcessId) } | ForEach-Object { [int]$_.ProcessId }
`.trim();

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pids = stdout
        .trim()
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
  });
}

/**
 * Reclaim MCP server processes orphaned by a previous gateway instance. Call once at startup,
 * BEFORE starting any MCP of our own, so the sweep can't mistake a fresh child for an orphan.
 */
export async function killOrphanMcps(ownPid: number): Promise<number[]> {
  let pids: number[] = [];
  try {
    pids = await findOrphanMcps(ownPid);
  } catch (err) {
    log("warn", "orphan sweep failed", { err: (err as Error).message });
    return [];
  }
  for (const pid of pids) {
    log("warn", "killing orphan mcp process", { pid });
    await treeKill(pid);
  }
  if (pids.length) log("info", "orphan mcp sweep complete", { killed: pids.length });
  return pids;
}
