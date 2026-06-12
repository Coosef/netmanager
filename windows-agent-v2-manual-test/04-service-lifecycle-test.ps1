# NetManager / Charon -- service lifecycle test (controlled)
#
# OPERATOR MUST TYPE: TEST
# This script will:
#   - Stop, then Start the NetManagerAgent service (verified)
#   - Identify the Go host PID via SCM
#   - Identify the Python child PID under that Go host
#   - Kill ONLY the verified Python child PID
#   - Wait up to 30 seconds for the Go host to re-spawn it
#   - Verify the new Python child PID
# It will NEVER:
#   - kill the Go host process directly
#   - uninstall the service
#   - delete files
#   - restart the OS
#
# Outputs:
#   C:\Users\Public\CharonAgentTest\service-lifecycle.txt
#
# Exit code:
#   0 = all phases passed
#   1 = a phase failed
#   2 = a phase failed AND the service is in a state needing manual fix
#   3 = operator did not confirm

$ErrorActionPreference = "Continue"

$OutDir = "C:\Users\Public\CharonAgentTest"
$null = New-Item -ItemType Directory -Force -Path $OutDir
$OutFile = Join-Path $OutDir "service-lifecycle.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $lines.Add($s) | Out-Null }
function Flush {
    # Authoritative UTF-8 BOM + CRLF writer (PS 5.1 safe; no byte-array concat).
    $joined = ($lines -join "`r`n")
    $normalized = $joined.TrimEnd([char]13, [char]10) + "`r`n"
    $enc = New-Object System.Text.UTF8Encoding($true)
    $tmp = $OutFile + ".tmp"
    [System.IO.File]::WriteAllText($tmp, $normalized, $enc)
    Move-Item -LiteralPath $tmp -Destination $OutFile -Force
}

$utcNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Line "NetManager Agent v2 - Service lifecycle test"
Add-Line ("Generated UTC: " + $utcNow)

# Admin check (locale-independent)
$wp = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $wp.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
Add-Line ("IsAdministrator: " + $isAdmin)
if (-not $isAdmin) {
    Add-Line "ERROR: This script requires an elevated PowerShell window."
    Flush
    Write-Host "Please re-run from an elevated PowerShell."
    exit 3
}

# Operator confirmation
Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host "Lifecycle test will Stop+Start the NetManagerAgent service"
Write-Host "and will kill the verified python.exe child of that service."
Write-Host "It will NOT touch any other process."
Write-Host "Type TEST exactly to confirm. Anything else aborts."
Write-Host "------------------------------------------------------------"
$confirm = Read-Host "Confirm"
if ($confirm -ne "TEST") {
    Add-Line "Operator cancelled (did not type TEST)."
    Flush
    Write-Host "Aborted."
    exit 3
}
Add-Line "Operator typed TEST. Proceeding."

# Phase counter
$phaseFails = New-Object System.Collections.Generic.List[string]
$manualNeeded = $false

function Get-HostPid {
    try {
        $c = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" -ErrorAction Stop
        if ($c) { return [int]$c.ProcessId }
    } catch {}
    return 0
}
function Get-PythonChildPid([int]$hostPid) {
    if ($hostPid -le 0) { return 0 }
    try {
        $kids = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $hostPid) -ErrorAction Stop
        foreach ($k in $kids) {
            if ($k.Name -match "python") { return [int]$k.ProcessId }
        }
    } catch {}
    return 0
}

# -------------------------------------------------------------------
# Phase 1: baseline
# -------------------------------------------------------------------
Add-Line ""
Add-Line "------------------------------------------------------------"
Add-Line "Phase 1 - baseline"
Add-Line "------------------------------------------------------------"
$svc = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
if (-not $svc) {
    Add-Line "Service not registered."
    $phaseFails.Add("baseline: service missing") | Out-Null
    Flush
    exit 2
}
Add-Line ("Status   : " + $svc.Status)
$hostPid0 = Get-HostPid
$pyPid0   = Get-PythonChildPid $hostPid0
Add-Line ("Host PID : " + $hostPid0)
Add-Line ("Py PID   : " + $pyPid0)
if ($svc.Status -ne "Running") {
    Add-Line "Service is not Running at baseline; will still try Stop+Start, but flagging."
    $phaseFails.Add("baseline: service not Running") | Out-Null
}

# -------------------------------------------------------------------
# Phase 2: Stop
# -------------------------------------------------------------------
Add-Line ""
Add-Line "------------------------------------------------------------"
Add-Line "Phase 2 - Stop"
Add-Line "------------------------------------------------------------"
try {
    Stop-Service -Name "NetManagerAgent" -ErrorAction Stop -Force
} catch {
    Add-Line "Stop-Service failed."
    $phaseFails.Add("stop: Stop-Service threw") | Out-Null
    $manualNeeded = $true
}
$deadline = (Get-Date).AddSeconds(30)
$svc.Refresh()
while ($svc.Status -ne "Stopped" -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $svc.Refresh()
}
Add-Line ("Status after stop: " + $svc.Status)
if ($svc.Status -ne "Stopped") {
    Add-Line "Service did not reach Stopped within 30s."
    $phaseFails.Add("stop: did not reach Stopped") | Out-Null
    $manualNeeded = $true
}

# -------------------------------------------------------------------
# Phase 3: Start
# -------------------------------------------------------------------
Add-Line ""
Add-Line "------------------------------------------------------------"
Add-Line "Phase 3 - Start"
Add-Line "------------------------------------------------------------"
try {
    Start-Service -Name "NetManagerAgent" -ErrorAction Stop
} catch {
    Add-Line "Start-Service failed."
    $phaseFails.Add("start: Start-Service threw") | Out-Null
    $manualNeeded = $true
}
$deadline = (Get-Date).AddSeconds(30)
$svc.Refresh()
while ($svc.Status -ne "Running" -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $svc.Refresh()
}
Add-Line ("Status after start: " + $svc.Status)
if ($svc.Status -ne "Running") {
    Add-Line "Service did not reach Running within 30s."
    $phaseFails.Add("start: did not reach Running") | Out-Null
    $manualNeeded = $true
}

# 10s + 30s exact-Running re-check
Start-Sleep -Seconds 10
$svc.Refresh()
Add-Line ("Status @10s   : " + $svc.Status)
if ($svc.Status -ne "Running") {
    $phaseFails.Add("start: not Running at 10s") | Out-Null
    $manualNeeded = $true
}
Start-Sleep -Seconds 20
$svc.Refresh()
Add-Line ("Status @30s   : " + $svc.Status)
if ($svc.Status -ne "Running") {
    $phaseFails.Add("start: not Running at 30s") | Out-Null
    $manualNeeded = $true
}

$hostPid1 = Get-HostPid
$pyPid1   = Get-PythonChildPid $hostPid1
Add-Line ("New Host PID  : " + $hostPid1)
Add-Line ("New Py PID    : " + $pyPid1)

# -------------------------------------------------------------------
# Phase 4: kill Python child (verified PID only)
# -------------------------------------------------------------------
Add-Line ""
Add-Line "------------------------------------------------------------"
Add-Line "Phase 4 - kill verified python child"
Add-Line "------------------------------------------------------------"
if ($hostPid1 -le 0) {
    Add-Line "No Go host PID; skipping python-kill phase."
    $phaseFails.Add("python-kill: host PID missing") | Out-Null
    $manualNeeded = $true
} elseif ($pyPid1 -le 0) {
    Add-Line "No python child to kill."
    $phaseFails.Add("python-kill: no python child to kill") | Out-Null
} else {
    # Re-verify parent right before kill
    $checkPyPid = Get-PythonChildPid $hostPid1
    if ($checkPyPid -ne $pyPid1) {
        Add-Line ("Python child PID changed between probe and kill (" + $pyPid1 + " -> " + $checkPyPid + "); aborting kill.")
        $phaseFails.Add("python-kill: race detected, aborted") | Out-Null
    } else {
        try {
            $target = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pyPid1) -ErrorAction Stop
            if ($target -and $target.ParentProcessId -eq $hostPid1 -and $target.Name -match "python") {
                Add-Line ("Killing python child PID=" + $pyPid1 + " (parent verified=" + $hostPid1 + ")")
                Stop-Process -Id $pyPid1 -Force -ErrorAction Stop
            } else {
                Add-Line "Re-verify failed; not killing."
                $phaseFails.Add("python-kill: re-verify failed") | Out-Null
            }
        } catch {
            Add-Line "Stop-Process failed for python child."
            $phaseFails.Add("python-kill: Stop-Process threw") | Out-Null
        }
    }

    # Wait up to 30s for the Go host to respawn a python child
    $deadline = (Get-Date).AddSeconds(30)
    $pyPid2 = 0
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $pyPid2 = Get-PythonChildPid $hostPid1
        if ($pyPid2 -gt 0 -and $pyPid2 -ne $pyPid1) { break }
    }
    Add-Line ("Respawned Py PID: " + $pyPid2)
    if ($pyPid2 -le 0 -or $pyPid2 -eq $pyPid1) {
        Add-Line "Go host did not respawn a new python child within 30s."
        $phaseFails.Add("python-kill: no respawn within 30s") | Out-Null
        $manualNeeded = $true
    }
}

# -------------------------------------------------------------------
# Phase 5: final state
# -------------------------------------------------------------------
Add-Line ""
Add-Line "------------------------------------------------------------"
Add-Line "Phase 5 - final state"
Add-Line "------------------------------------------------------------"
$svc.Refresh()
Add-Line ("Status final  : " + $svc.Status)
$hostPidF = Get-HostPid
$pyPidF   = Get-PythonChildPid $hostPidF
Add-Line ("Final Host PID: " + $hostPidF)
Add-Line ("Final Py PID  : " + $pyPidF)

Add-Line ""
if ($phaseFails.Count -eq 0) {
    Add-Line "LIFECYCLE_RESULT=PASS"
    Flush
    exit 0
}
foreach ($f in $phaseFails) { Add-Line ("FAIL: " + $f) }
Add-Line ""
if ($manualNeeded) {
    Add-Line "LIFECYCLE_RESULT=MANUAL_INTERVENTION_REQUIRED"
    Flush
    exit 2
}
Add-Line "LIFECYCLE_RESULT=FAIL"
Flush
exit 1
