# 06-safe-cleanup.ps1 - NetManager Windows Agent v2 (Architecture Plan v11)
#
# Two modes:
#
#   (default)            Leave the installed agent in place. Wipe only
#                        the LOCAL artifacts this manual-test workflow
#                        produced: preflight.txt, post-install.txt,
#                        installer-run.txt, any diagnostics ZIP in the
#                        current directory.
#
#   -RemoveAgentFiles    ALSO wipe the agent's on-disk state, returning
#                        the box to a clean-install state. This stops
#                        the service (via the host CLI), uninstalls it,
#                        and removes every artifact under
#                        C:\ProgramData\NetManagerAgent. The full path
#                        list -- including the secret-bearing paths
#                        config.env, config.env.bak,
#                        staging\rollback-config.failed, and the
#                        Invoke-ProcessCaptured staging\proc-capture\
#                        directory -- is wiped in one pass.
#
# This is OPERATOR cleanup, not the installer's rollback path. The
# installer's own rollback (Section G) preserves payload\previous etc.
# so a failed upgrade can be reverted; -RemoveAgentFiles is for
# returning the box to "agent never installed" state.

[CmdletBinding()]
param(
    [switch]$RemoveAgentFiles
)

$ErrorActionPreference = "Stop"

$InstallDir = "C:\ProgramData\NetManagerAgent"
$BinDir     = "$InstallDir\bin"
$ServiceName = "NetManagerAgent"
$HostExeLive = "$BinDir\charon-agent-host.exe"

# Local test-package artifacts (always wiped). LiteralPath prevents any
# accidental wildcard expansion from deleting files outside CWD.
foreach ($local in @("preflight.txt", "post-install.txt", "installer-run.txt")) {
    $p = Join-Path (Get-Location).Path $local
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    }
}
Get-ChildItem -LiteralPath (Get-Location).Path -Filter "netmanager-agent-diagnostics-*.zip" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }

if (-not $RemoveAgentFiles) {
    Write-Host "[OK] Local test-package artifacts wiped. Agent install untouched." -ForegroundColor Green
    Write-Host "[INFO] Re-run with -RemoveAgentFiles to also wipe the agent install."
    exit 0
}

# Locale-independent admin check before mutating C:\ProgramData.
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] -RemoveAgentFiles requires elevation." -ForegroundColor Red
    exit 1
}

# Drain the service via the host CLI (NEVER Stop-Service / sc.exe).
# This is best-effort -- if the host binary is missing or the service
# never existed we still proceed to wipe files.
if (Test-Path -LiteralPath $HostExeLive) {
    & $HostExeLive stop      --service-name $ServiceName 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
    & $HostExeLive uninstall --service-name $ServiceName 2>&1 | Out-Null
    # Bounded poll for SCM drain.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        & $HostExeLive status --service-name $ServiceName 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 18) { break }
        Start-Sleep -Milliseconds 500
    }
}

# Now wipe every on-disk artifact. Each path is removed via -LiteralPath
# (no wildcard expansion) and missing paths are silently tolerated.
$wipeRoots = @(
    "$InstallDir\payload",
    "$InstallDir\staging",
    "$InstallDir\bin"
)
$wipeFiles = @(
    "$InstallDir\config.env",
    "$InstallDir\config.env.bak",
    "$InstallDir\staging\rollback-config.failed",
    "$InstallDir\installer-run.txt"
)

foreach ($d in $wipeRoots) {
    if (Test-Path -LiteralPath $d) {
        Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue
    }
}
foreach ($f in $wipeFiles) {
    if (Test-Path -LiteralPath $f) {
        Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    }
}

# Finally remove the install root if empty (logs/ may survive if the
# operator wants to keep history; we don't force-delete them).
if (Test-Path -LiteralPath $InstallDir) {
    $remaining = Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue
    if (-not $remaining) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "[OK] Agent files wiped from $InstallDir." -ForegroundColor Green
exit 0
