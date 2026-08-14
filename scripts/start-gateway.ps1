# Starts the compiled MCP gateway as a detached background service (`lmg start`).
# Crash-restart and start-at-logon belong to the OS (Scheduled Task / systemd), not this script.
$ErrorActionPreference = "Continue"
# Run from the repo root (this script lives in scripts/), so it works from any clone location.
Set-Location (Split-Path $PSScriptRoot -Parent)

# Build on demand if the compiled CLI is missing (fresh checkout / dist cleaned).
if (-not (Test-Path "dist\bin.js")) {
    Write-Host "$(Get-Date -Format o)  dist/ missing — building..."
    npm run build
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "dist\bin.js")) {
        Write-Warning "$(Get-Date -Format o)  build failed (exit $LASTEXITCODE)."
        exit 1
    }
}

# Prefer the local CLI so a clone does not depend on a global `lmg` install.
# `lmg start` applies the V8 flags and detaches; closing this window does not stop the gateway.
Write-Host "$(Get-Date -Format o)  lmg start"
& node dist\bin.js start
exit $LASTEXITCODE
