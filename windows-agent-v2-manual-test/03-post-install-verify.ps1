# NetManager / Charon -- post-install verification (read-only)
#
# Writes:
#     C:\Users\Public\CharonAgentTest\post-install.txt
# Last line is one of:
#     POST_INSTALL_RESULT=PASS
#     POST_INSTALL_RESULT=FAIL
#
# This script:
#   - does NOT touch the service
#   - does NOT touch the agent.std{out,err}.log content beyond
#     reading the last 100 lines with secret masking
#   - does NOT print the contents of config.env

$ErrorActionPreference = "Continue"

$OutDir = "C:\Users\Public\CharonAgentTest"
$null = New-Item -ItemType Directory -Force -Path $OutDir
$OutFile = Join-Path $OutDir "post-install.txt"
$lines = New-Object System.Collections.Generic.List[string]
$fails = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $lines.Add($s) | Out-Null }
function Add-Fail([string]$s) { $fails.Add($s) | Out-Null }
function Add-Section([string]$t) {
    Add-Line ""
    Add-Line ("=" * 64)
    Add-Line $t
    Add-Line ("=" * 64)
}

$utcNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Line ("NetManager Agent v2 - Post-install verification")
Add-Line ("Generated UTC: " + $utcNow)

# Reusable masking helper
$maskTokens = @(
    @{ Pat = "(?i)X-Agent-Key\s*[:=]\s*\S+";        Repl = "X-Agent-Key=***REDACTED***" }
    @{ Pat = "(?i)AGENT_KEY\s*=\s*\S+";             Repl = "AGENT_KEY=***REDACTED***" }
    @{ Pat = "(?i)Authorization\s*:\s*\S+\s*\S+";   Repl = "Authorization: ***REDACTED***" }
    @{ Pat = "(?i)Bearer\s+[A-Za-z0-9._\-]+";       Repl = "Bearer ***REDACTED***" }
    @{ Pat = "eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"; Repl = "***JWT_REDACTED***" }
    @{ Pat = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"; Repl = "***UUID_REDACTED***" }
    @{ Pat = "(?i)([?&])(agent_key|access_token|token|api_key)=([^&\s]+)"; Repl = '$1$2=***REDACTED***' }
)
function Mask-Line([string]$s) {
    $out = $s
    foreach ($m in $maskTokens) {
        $out = [regex]::Replace($out, $m.Pat, $m.Repl)
    }
    return $out
}

# -------------------------------------------------------------------
# Service object
# -------------------------------------------------------------------
Add-Section "Service object"
$svc = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
if (-not $svc) {
    Add-Line "NetManagerAgent service is NOT registered."
    Add-Fail "Service not registered."
} else {
    Add-Line ("Name        : " + $svc.Name)
    Add-Line ("DisplayName : " + $svc.DisplayName)
    Add-Line ("Status      : " + $svc.Status)
    Add-Line ("StartType   : " + $svc.StartType)
    try {
        $cim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'"
        if ($cim) {
            Add-Line ("PathName    : " + $cim.PathName)
            Add-Line ("StartName   : " + $cim.StartName)
            Add-Line ("Description : " + $cim.Description)
            Add-Line ("ProcessId   : " + $cim.ProcessId)
        }
    } catch {
        Add-Line "Win32_Service CIM query failed (non-fatal)."
    }
    if ($svc.Status -ne "Running") {
        Add-Fail ("Service status is " + $svc.Status + ", expected Running.")
    }
}

# -------------------------------------------------------------------
# Host binary
# -------------------------------------------------------------------
Add-Section "Host binary"
$installDir = "C:\ProgramData\NetManagerAgent"
$binDir = Join-Path $installDir "bin"
$hostExe = Join-Path $binDir "charon-agent-host.exe"
if (Test-Path -LiteralPath $hostExe) {
    Add-Line ("charon-agent-host.exe present at: " + $hostExe)
    try {
        $size = (Get-Item -LiteralPath $hostExe).Length
        Add-Line ("Size                : " + $size + " bytes")
    } catch {}
    try {
        $hash = (Get-FileHash -LiteralPath $hostExe -Algorithm SHA256).Hash
        Add-Line ("SHA-256             : " + $hash)
    } catch {
        Add-Line "Get-FileHash failed."
        Add-Fail "Could not hash charon-agent-host.exe."
    }
    try {
        $ver = & $hostExe version 2>&1 | Out-String
        $ver = $ver.Trim()
        Add-Line ("version output      : " + $ver)
        if ($ver -match "2\.0\.0-mvp0\+g[0-9a-f]{12}") {
            Add-Line "version format OK"
        } else {
            Add-Fail ("Host version output does not match 2.0.0-mvp0+g<12hex>; got: " + $ver)
        }
    } catch {
        Add-Line "host version subcommand failed."
        Add-Fail "host version subcommand failed."
    }
} else {
    Add-Line ("charon-agent-host.exe MISSING at: " + $hostExe)
    Add-Fail "Host binary not on disk."
}
foreach ($leftover in @($hostExe + ".new", $hostExe + ".bak")) {
    if (Test-Path -LiteralPath $leftover) {
        Add-Line ("LEFTOVER FOUND       : " + $leftover)
        Add-Fail ("Stale " + (Split-Path -Leaf $leftover) + " left behind by installer.")
    } else {
        Add-Line (".new/.bak absent     : " + $leftover)
    }
}

# -------------------------------------------------------------------
# config.env / run_agent.py / agent script  (file metadata only)
# -------------------------------------------------------------------
Add-Section "Install directory contents (metadata only; config.env content NOT shown)"
$cfgEnv     = Join-Path $installDir "config.env"
$runAgent   = Join-Path $installDir "run_agent.py"
$agentPy    = Join-Path $installDir "netmanager_agent.py"
foreach ($f in @($cfgEnv, $runAgent, $agentPy)) {
    if (Test-Path -LiteralPath $f) {
        try {
            $fi = Get-Item -LiteralPath $f
            Add-Line ("{0}: present, {1} bytes, modified {2}" -f $f, $fi.Length, $fi.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"))
            try {
                $acl = Get-Acl -LiteralPath $f
                Add-Line ("  Owner: " + $acl.Owner)
                foreach ($ace in $acl.Access) {
                    Add-Line ("  ACE  : " + $ace.IdentityReference + "  " + $ace.FileSystemRights + "  " + $ace.AccessControlType)
                }
            } catch {}
        } catch {
            Add-Line ($f + " : present but stat failed.")
        }
    } else {
        Add-Line ($f + " : missing")
        Add-Fail ((Split-Path -Leaf $f) + " missing from install directory.")
    }
}

# -------------------------------------------------------------------
# Python child process correlation
# -------------------------------------------------------------------
Add-Section "Python child process (parent must be Go host)"
$hostPid = $null
try {
    $cim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'"
    if ($cim) { $hostPid = $cim.ProcessId }
} catch {}
Add-Line ("Go host PID (from SCM): " + $hostPid)
if ($hostPid) {
    $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $hostPid)
    if ($children -and ($children | Where-Object { $_.Name -match "python" }).Count -gt 0) {
        foreach ($c in $children) {
            if ($c.Name -match "python") {
                Add-Line ("  Python child  PID=" + $c.ProcessId + "  Name=" + $c.Name + "  Exec=" + $c.ExecutablePath)
            }
        }
    } else {
        Add-Line "No python.exe child found under the Go host."
        Add-Fail "Go host has no python.exe child process."
    }
} else {
    Add-Fail "Go host PID could not be resolved from SCM."
}

# -------------------------------------------------------------------
# Log files (last 100 lines, masked)
# -------------------------------------------------------------------
Add-Section "Log files (last 100 lines, masked)"
$logDir = Join-Path $installDir "logs"
if (-not (Test-Path -LiteralPath $logDir)) {
    Add-Line "Log directory missing."
    Add-Fail "Log directory missing."
} else {
    foreach ($lg in @("service-host.log", "agent.stdout.log", "agent.stderr.log")) {
        $p = Join-Path $logDir $lg
        if (Test-Path -LiteralPath $p) {
            Add-Line ""
            Add-Line ("-- " + $lg + " (last 100 lines, masked) --")
            try {
                $tail = Get-Content -LiteralPath $p -Tail 100 -ErrorAction Stop
                foreach ($l in $tail) { Add-Line (Mask-Line $l) }
            } catch {
                Add-Line ("could not read " + $p)
            }
        } else {
            Add-Line ($p + " : missing")
            Add-Fail ($lg + " missing.")
        }
    }
}

# -------------------------------------------------------------------
# Windows Event Log (NetManagerAgent + service host)
# -------------------------------------------------------------------
Add-Section "Recent NetManager Event Log records"
try {
    $evt = Get-WinEvent -FilterHashtable @{
        LogName = @("Application","System")
        ProviderName = @("NetManagerAgentHost","Service Control Manager")
    } -MaxEvents 50 -ErrorAction Stop
    foreach ($e in ($evt | Sort-Object TimeCreated -Descending)) {
        $ts = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        $first = ($e.Message -split "`r?`n")[0]
        Add-Line ("[" + $ts + "] " + $e.ProviderName + " (" + $e.Id + ") " + $e.LevelDisplayName + ": " + (Mask-Line $first))
    }
} catch {
    Add-Line "No matching Event Log records (or query failed)."
}

# -------------------------------------------------------------------
# 10s and 30s service-Running check
# -------------------------------------------------------------------
Add-Section "Running stability (10s + 30s)"
$svc = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
if (-not $svc) {
    Add-Line "Service missing; cannot check stability."
    Add-Fail "Service missing during stability check."
} else {
    Start-Sleep -Seconds 10
    $svc.Refresh()
    Add-Line ("Status @10s : " + $svc.Status)
    if ($svc.Status -ne "Running") { Add-Fail "Service not Running at 10s." }
    Start-Sleep -Seconds 20
    $svc.Refresh()
    Add-Line ("Status @30s : " + $svc.Status)
    if ($svc.Status -ne "Running") { Add-Fail "Service not Running at 30s." }
}

# -------------------------------------------------------------------
# Installer file cleanup check (best-effort)
# -------------------------------------------------------------------
Add-Section "Installer file cleanup"
$probeNames = @(
    "netmanager-agent-installer.ps1",
    "netmanager-agent-installer-elevated.ps1"
)
foreach ($n in $probeNames) {
    foreach ($d in @(
        $env:USERPROFILE,
        (Join-Path $env:USERPROFILE "Downloads"),
        (Join-Path $env:USERPROFILE "Desktop"),
        "C:\Users\Public\Downloads",
        "C:\Users\Public\Desktop"
    )) {
        if (-not $d) { continue }
        $cand = Join-Path $d $n
        if (Test-Path -LiteralPath $cand) {
            Add-Line ("Installer file still on disk: " + $cand)
        }
    }
}
Add-Line "(If a real installer .ps1 file is still listed above, the installer's self-cleanup did not fire.)"

# -------------------------------------------------------------------
# Verdict
# -------------------------------------------------------------------
Add-Section "Verdict"
if ($fails.Count -eq 0) {
    Add-Line "POST_INSTALL_RESULT=PASS"
} else {
    foreach ($f in $fails) { Add-Line ("FAIL: " + $f) }
    Add-Line ""
    Add-Line "POST_INSTALL_RESULT=FAIL"
}

# Authoritative UTF-8 BOM + CRLF writer (PS 5.1 safe; no byte-array concat).
$joined = ($lines -join "`r`n")
$normalized = $joined.TrimEnd([char]13, [char]10) + "`r`n"
$enc = New-Object System.Text.UTF8Encoding($true)
$tmp = $OutFile + ".tmp"
[System.IO.File]::WriteAllText($tmp, $normalized, $enc)
Move-Item -LiteralPath $tmp -Destination $OutFile -Force
Write-Host ("Post-install written to: " + $OutFile)
if ($fails.Count -eq 0) { exit 0 } else { exit 1 }
