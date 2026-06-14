# 02-run-installer.ps1 - NetManager Windows Agent v2 (Architecture Plan v11)
#
# Download the production installer from the configured NetManager backend
# and run it elevated. The installer itself is authored by the backend's
# _windows_installer() generator and emits the Section H 11-stage flow
# (corrections #66 + #67 + #68 + #69 + #70 + #71 + #72):
#
#   [1/11]   Admin check + self-elevation
#   [2/11]   2A SID-based ACL + 2B transaction-recovery preflight with
#            four-probe SCM agreement + InitialServiceState classification
#            + InitialRegistrationSnapshot + IsCanonicallyRestorable gate
#   [3/11]   Re-assert install root ACL
#   [4/11]   Download runtime manifest
#   [5/11]   Download runtime ZIP + triple SHA-256 verify
#   [6/11]   6A traversal-safe extraction + 6B byte-exact RUNTIME_OK
#   [7/11]   Stage config.env.new
#   [8/11]   Download + verify Go host binary -> $HostExeNew
#   [9/11]   9A pre-quiesce OldHostProcessSnapshot +
#            OldVerifiedChildPythonProcessSnapshot + Stop/Uninstall/
#            Status branching + A3 PID+path+creation-time triple verify;
#            9B M1..M6 atomic swap
#   [10/11]  Structured Invoke-HostInstall reading .ExitCode + exit-17
#            anomaly handling (install: service: already exists)
#   [11/11]  Stage 11.A/B/C SCM registration semantic equivalence +
#            Stage 11.D LOGICAL_DELETE of payload\previous,
#            config.env.bak, bin\charon-agent-host.exe.bak ONLY after
#            11.C passes
#
# Rollback paths the installer takes when any stage fails:
#   SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING
#   SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED
#   SUCCESSFUL_CLEAN_INSTALL_ROLLBACK
# A rollback that itself fails surfaces:
#   ROLLBACK_INCOMPLETE / MANUAL INTERVENTION REQUIRED  (exit 2)
#
# This script does NOT re-implement the installer; it only invokes it.
# All host CLI calls inside the installer go through Invoke-HostInstall +
# Invoke-ProcessCaptured (.ExitCode / .Stdout / .Stderr) by design --
# bare `& $HostExe install` is forbidden because the success-stdout
# literal would pollute the call-operator pipeline.
#
# Pre-blocks Stage 2B may surface in installer-run.txt:
#   SERVICE_REGISTRATION_PROBE_INCONSISTENT
#   REGISTRATION_NOT_CANONICALLY_RESTORABLE
#   INCONSISTENT_LIVE_STATE
#   UNRESOLVED_PREVIOUS_TRANSACTION
# Each of these is BLOCKED (exit 3) without mutating live state.

$ErrorActionPreference = "Stop"

# Parse configuration ----------------------------------------------------
$cfgPath = Join-Path $PSScriptRoot "test-config.json"
if (-not (Test-Path -LiteralPath $cfgPath)) {
    Write-Host "[ERROR] test-config.json missing." -ForegroundColor Red
    exit 1
}
$cfg = (Get-Content -LiteralPath $cfgPath -Raw) | ConvertFrom-Json
$backend = "$($cfg.backend_url)"
$agentId = "$($cfg.agent_id)"
$agentKey = "$($cfg.agent_key)"
if (-not $backend -or -not $agentId -or -not $agentKey) {
    Write-Host "[ERROR] test-config.json requires backend_url + agent_id + agent_key." -ForegroundColor Red
    exit 1
}

# Locale-independent admin + self-elevation guard ------------------------
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Re-run PowerShell as Administrator." -ForegroundColor Red
    exit 1
}

# Download the rendered installer over TLS 1.2 ---------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$installerPath = Join-Path $env:TEMP ("netmanager-installer-" + [guid]::NewGuid().ToString() + ".ps1")
try {
    $resp = Invoke-WebRequest `
        -Uri "$backend/api/v1/agents/$agentId/download/windows" `
        -Headers @{ "X-Agent-Key" = $agentKey } `
        -OutFile $installerPath `
        -UseBasicParsing `
        -PassThru
    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "installer did not land on disk"
    }
} catch {
    Write-Host "[ERROR] Could not download installer: $($_.Exception.Message)" -ForegroundColor Red
    if (Test-Path -LiteralPath $installerPath) {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    }
    exit 1
}

# Run the installer elevated and wait for it to finish -------------------
# The installer self-elevates on first launch and re-launches itself
# under an Administrator context; this wrapper just waits for the chain
# to terminate. The installer's outer try/finally removes its own file
# from PSCommandPath (which embeds the agent key in its header), so this
# wrapper does NOT have to touch the installer file again.
$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$proc = Start-Process -FilePath $psExe `
    -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$installerPath`""
    ) `
    -Wait -PassThru

$exitCode = 1
if ($proc -and $proc.ExitCode -ne $null) {
    $exitCode = [int]$proc.ExitCode
}

# Defense in depth -- if the installer's all-paths finally somehow
# failed to remove its own file, this wrapper does so. -LiteralPath
# prevents wildcard expansion from deleting anything else.
if (Test-Path -LiteralPath $installerPath) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}

if ($exitCode -eq 0) {
    Write-Host "[OK] Installer reported success." -ForegroundColor Green
} elseif ($exitCode -eq 1) {
    Write-Host "[INFO] Installer rolled back (see installer-run.txt for ROLLBACK_RESULT)." -ForegroundColor Yellow
} elseif ($exitCode -eq 2) {
    Write-Host "[CRITICAL] ROLLBACK_INCOMPLETE / MANUAL INTERVENTION REQUIRED." -ForegroundColor Red
} elseif ($exitCode -eq 3) {
    Write-Host "[BLOCKED] Stage 2B preflight blocked the installer (see installer-run.txt)." -ForegroundColor Yellow
} else {
    Write-Host "[ERROR] Installer exited with $exitCode." -ForegroundColor Red
}
exit $exitCode
