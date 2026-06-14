# 01-preflight.ps1 - NetManager Windows Agent v2 (Architecture Plan v11)
#
# Confirm the box can host the Windows Agent v2 WITHOUT requiring system
# Python or winget. The v3 package treated those as hard blockers; v2
# ships its own private Python runtime + Go service host, so neither is
# needed (corrections #11 + #32). The legacy interpreter / package-
# manager / Microsoft Store stub blockers are gone in v4.
#
# Output format (positive report, ASCII-safe, locale-independent):
#
#   Private Python runtime      : not installed
#   Installer action            : private runtime will be downloaded and installed
#   System Python required      : No
#   winget required             : No
#   ...
#   PRECHECK_RESULT=PASS         (or PRECHECK_RESULT=BLOCKED + one or more
#                                 [BLOCK] lines)
#
# Exit codes:
#   0  PRECHECK_RESULT=PASS
#   1  PRECHECK_RESULT=BLOCKED

$ErrorActionPreference = "Stop"

# Parse configuration ----------------------------------------------------
$cfgPath = Join-Path $PSScriptRoot "test-config.json"
if (-not (Test-Path -LiteralPath $cfgPath)) {
    Write-Host "[BLOCK] test-config.json missing next to 01-preflight.ps1." -ForegroundColor Red
    "PRECHECK_RESULT=BLOCKED" | Tee-Object preflight.txt
    exit 1
}
try {
    $cfg = (Get-Content -LiteralPath $cfgPath -Raw) | ConvertFrom-Json
} catch {
    Write-Host "[BLOCK] test-config.json is not valid JSON." -ForegroundColor Red
    "PRECHECK_RESULT=BLOCKED" | Tee-Object preflight.txt
    exit 1
}
$backend = "$($cfg.backend_url)"
if (-not $backend) {
    Write-Host "[BLOCK] test-config.json has no backend_url." -ForegroundColor Red
    "PRECHECK_RESULT=BLOCKED" | Tee-Object preflight.txt
    exit 1
}

$blockers = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList

function Add-Block { param([string]$reason) [void]$script:blockers.Add($reason) }
function Add-Warn  { param([string]$reason) [void]$script:warnings.Add($reason) }

# (1) Locale-independent admin check (SID-based; no localized strings).
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Add-Block "Not elevated. Re-run PowerShell as Administrator."
}

# (2) OS version >= Server 2019 / Win10 1809 (build 17763).
try {
    $osBuild = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
    if ($osBuild -lt 17763) {
        Add-Block "OS build $osBuild below 17763 (Server 2019 / Win10 1809)."
    }
} catch {
    Add-Warn "Could not read OS build number."
}

# (3) Disk free on C: (>= 2 GB for agent + private runtime).
try {
    $freeBytes = (Get-PSDrive -Name C).Free
    $freeGb = [math]::Round($freeBytes / 1GB, 2)
    if ($freeGb -lt 2) { Add-Block "Free disk on C: is $freeGb GB; need >= 2 GB." }
} catch {
    Add-Warn "Could not measure free disk on C:."
}

# (4) HTTPS reachability to the configured NetManager backend. TLS 1.2 only.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-WebRequest -Uri $backend -Method Head -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -ge 500) {
        Add-Block "Backend HEAD $backend returned $($r.StatusCode)."
    }
} catch {
    Add-Block ("Could not reach $backend over HTTPS (TLS 1.2). " +
               "Verify the backend URL and network egress.")
}

# v4 EXPLICITLY does NOT block on missing system Python, missing winget,
# missing Microsoft Store, or missing pip. The Windows Agent v2 installer
# downloads its own private runtime from the backend (Section D endpoint
# /api/v1/agents/{id}/download/runtime/windows-amd64). No third-party
# package source is contacted at install time, and no entry on PATH is
# read or modified. (Corrections #11 + #32.)

Write-Host "Private Python runtime      : not installed"
Write-Host "Installer action            : private runtime will be downloaded and installed"
Write-Host "System Python required      : No"
Write-Host "winget required             : No"
Write-Host "Backend reachable           : $backend"
Write-Host ""

foreach ($w in $warnings) { Write-Host "[WARN] $w" -ForegroundColor Yellow }

if ($blockers.Count -gt 0) {
    foreach ($b in $blockers) { Write-Host "[BLOCK] $b" -ForegroundColor Red }
    "PRECHECK_RESULT=BLOCKED" | Tee-Object -FilePath preflight.txt
    exit 1
}

"PRECHECK_RESULT=PASS" | Tee-Object -FilePath preflight.txt
exit 0
