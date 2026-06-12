# NetManager / Charon -- Windows Agent v2 manual test preflight
#
# READ-ONLY system probe. Writes a single text file:
#     C:\Users\Public\CharonAgentTest\preflight.txt
#
# The LAST line of that file is one of:
#     PRECHECK_RESULT=PASS
#     PRECHECK_RESULT=BLOCKED
#
# This script:
#   - does NOT install anything
#   - does NOT touch any existing NetManagerAgent service
#   - does NOT change firewall, antivirus, registry, ExecutionPolicy
#   - does NOT send any HTTP request to production endpoints
#   - does NOT need elevation (admin role is REPORTED, not REQUESTED)

$ErrorActionPreference = "Continue"

# -------------------------------------------------------------------
# Output setup
# -------------------------------------------------------------------
$OutDir = "C:\Users\Public\CharonAgentTest"
$OutFile = Join-Path $OutDir "preflight.txt"
$null = New-Item -ItemType Directory -Force -Path $OutDir
$lines = New-Object System.Collections.Generic.List[string]
$blockers = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$s) { $lines.Add($s) | Out-Null }
function Add-Block([string]$reason) { $blockers.Add($reason) | Out-Null }
function Add-Section([string]$title) {
    Add-Line ""
    Add-Line ("=" * 64)
    Add-Line $title
    Add-Line ("=" * 64)
}

$utcNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Line "NetManager Agent v2 - Preflight Report"
Add-Line ("Generated UTC: " + $utcNow)
Add-Line "Script: 01-preflight.ps1"

# -------------------------------------------------------------------
# Windows + locale
# -------------------------------------------------------------------
Add-Section "Windows + Locale"
try {
    $cim = Get-CimInstance Win32_OperatingSystem
    Add-Line ("ProductName     : " + $cim.Caption)
    Add-Line ("Version         : " + $cim.Version)
    Add-Line ("BuildNumber     : " + $cim.BuildNumber)
    Add-Line ("OSArchitecture  : " + $cim.OSArchitecture)
    Add-Line ("InstallDateUTC  : " + ($cim.InstallDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")))
} catch {
    Add-Line ("Win32_OperatingSystem query failed: " + $_.Exception.GetType().FullName)
    Add-Block "Cannot read Win32_OperatingSystem."
}
Add-Line ("Hostname        : " + $env:COMPUTERNAME)
Add-Line ("Culture         : " + (Get-Culture).Name)
Add-Line ("UICulture       : " + (Get-UICulture).Name)
try {
    $sysLocale = (Get-WinSystemLocale).Name
    Add-Line ("SystemLocale    : " + $sysLocale)
} catch {
    Add-Line "SystemLocale    : (Get-WinSystemLocale not available on this host)"
}

# -------------------------------------------------------------------
# PowerShell
# -------------------------------------------------------------------
Add-Section "PowerShell"
$psv = $PSVersionTable.PSVersion
$psEdition = $PSVersionTable.PSEdition
Add-Line ("PSVersion       : " + $psv.ToString())
Add-Line ("PSEdition       : " + $psEdition)
Add-Line ("CLRVersion      : " + $PSVersionTable.CLRVersion)
if ($psv.Major -ne 5) {
    Add-Block ("Windows PowerShell 5.1 expected; found " + $psv.ToString() + ".")
}
if ($psEdition -ne "Desktop") {
    Add-Block ("Windows PowerShell Desktop edition expected; found " + $psEdition + ".")
}

# -------------------------------------------------------------------
# Process / architecture
# -------------------------------------------------------------------
Add-Section "Process + Architecture"
$procArch = $env:PROCESSOR_ARCHITECTURE
$wow64Arch = $env:PROCESSOR_ARCHITEW6432
Add-Line ("PROCESSOR_ARCHITECTURE      : " + $procArch)
Add-Line ("PROCESSOR_ARCHITEW6432      : " + ($wow64Arch -as [string]))
$is64Proc = [System.Environment]::Is64BitProcess
$is64Os   = [System.Environment]::Is64BitOperatingSystem
Add-Line ("Is64BitProcess              : " + $is64Proc)
Add-Line ("Is64BitOperatingSystem      : " + $is64Os)
if (-not $is64Os) {
    Add-Block "Windows Agent v2 requires a 64-bit (amd64) Windows OS."
}

# -------------------------------------------------------------------
# Elevation + UAC
# -------------------------------------------------------------------
Add-Section "Elevation + UAC"
$wp = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $wp.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
Add-Line ("IsAdministrator             : " + $isAdmin)
Add-Line "(Preflight does not require elevation; the installer wrapper will request UAC itself.)"

try {
    $uac = Get-ItemProperty `
        -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" `
        -ErrorAction Stop
    Add-Line ("UAC EnableLUA               : " + ($uac.EnableLUA -as [string]))
    Add-Line ("UAC ConsentPromptBehavior   : " + ($uac.ConsentPromptBehaviorAdmin -as [string]))
    if ($uac.EnableLUA -eq 0) {
        Add-Block "UAC (EnableLUA) is disabled. Installer self-elevation will not work."
    }
} catch {
    Add-Line "UAC policy registry could not be read (non-fatal)."
}

# -------------------------------------------------------------------
# Reboot pending (read-only)
# -------------------------------------------------------------------
Add-Section "Reboot Pending"
$rebootSignals = @()
foreach ($path in @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending"
)) {
    if (Test-Path -LiteralPath $path) {
        $rebootSignals += $path
    }
}
if ($rebootSignals.Count -gt 0) {
    Add-Line "Reboot is pending. Detected signals:"
    foreach ($s in $rebootSignals) { Add-Line ("  " + $s) }
    Add-Block "Reboot pending; reboot the test machine before installing."
} else {
    Add-Line "No reboot pending."
}

# -------------------------------------------------------------------
# Python + py launcher + winget + Microsoft Store alias detection
# -------------------------------------------------------------------
Add-Section "Python toolchain"
$pyCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pyCmd) {
    $pyPath = $pyCmd.Source
    Add-Line ("python.exe resolves to       : " + $pyPath)
    if ($pyPath -like "*\Microsoft\WindowsApps\python.exe") {
        Add-Line "WARNING: this is the Microsoft Store App Execution Alias stub, not a real Python install."
        Add-Block "python.exe resolves to the Microsoft Store alias; install real Python 3.12 (or remove the alias) before the installer is run."
    } else {
        try {
            $pyVer = & $pyPath --version 2>&1 | Out-String
            Add-Line ("python --version             : " + ($pyVer.Trim()))
            if ($pyVer -notmatch "Python\s+3\.(1[0-9]|[2-9]\d)") {
                Add-Block "Detected Python is not 3.10+; installer requires Python 3.12 (or close)."
            }
        } catch {
            Add-Line "python --version failed to return output."
            Add-Block "python.exe present but did not respond to --version."
        }
    }
} else {
    Add-Line "python.exe not on PATH."
    Add-Line "(The installer will try to install Python 3.12 via winget if missing.)"
}
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) {
    Add-Line ("py.exe launcher              : " + $pyLauncher.Source)
} else {
    Add-Line "py.exe launcher              : not present (optional)"
}
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Add-Line ("winget                       : " + $winget.Source)
} else {
    Add-Line "winget                       : not present"
    if (-not $pyCmd) {
        Add-Block "No Python AND no winget. Installer cannot auto-install Python; install Python 3.12 manually first."
    }
}

# -------------------------------------------------------------------
# Existing NetManagerAgent service
# -------------------------------------------------------------------
Add-Section "Existing NetManagerAgent service"
$existing = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
if ($existing) {
    Add-Line ("Status        : " + $existing.Status)
    Add-Line ("StartType     : " + $existing.StartType)
    Add-Line ("DisplayName   : " + $existing.DisplayName)
    try {
        $svcCim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'"
        if ($svcCim) {
            Add-Line ("PathName      : " + $svcCim.PathName)
            Add-Line ("StartName     : " + $svcCim.StartName)
            Add-Line ("Description   : " + $svcCim.Description)
        }
    } catch {
        Add-Line "Win32_Service query failed (non-fatal)."
    }
    Add-Line ""
    Add-Line "An EXISTING NetManagerAgent service is registered. Preflight will NOT touch it."
    Add-Line "Decide whether to: (a) uninstall it manually before installer runs,"
    Add-Line "or (b) let the installer's [8/9] uninstall + bounded drain handle it."
    Add-Block "An existing NetManagerAgent service is registered. Decide handling before installer."
} else {
    Add-Line "No NetManagerAgent service registered."
}

# -------------------------------------------------------------------
# Existing install directory + host binary
# -------------------------------------------------------------------
Add-Section "Existing install directory"
$installDir = "C:\ProgramData\NetManagerAgent"
$hostExe = Join-Path $installDir "bin\charon-agent-host.exe"
if (Test-Path -LiteralPath $installDir) {
    Add-Line ("Install directory present   : " + $installDir)
    try {
        Get-ChildItem -LiteralPath $installDir -Force -ErrorAction Stop |
            ForEach-Object {
                Add-Line ("  {0}  {1,12}  {2}" -f $_.Mode, $_.Length, $_.Name)
            }
    } catch {
        Add-Line "(Could not enumerate install directory: insufficient permissions when running non-elevated.)"
    }
    if (Test-Path -LiteralPath $hostExe) {
        Add-Line ("charon-agent-host.exe       : present at " + $hostExe)
        try {
            $hostSize = (Get-Item -LiteralPath $hostExe).Length
            Add-Line ("  Size                      : " + $hostSize + " bytes")
        } catch {}
        Add-Block "Previous install of charon-agent-host.exe is on disk. Decide rollback strategy."
    } else {
        Add-Line "charon-agent-host.exe        : absent (fresh-install layout)"
    }
} else {
    Add-Line ("Install directory absent     : " + $installDir + " (fresh install path)")
}

# -------------------------------------------------------------------
# Relevant running processes
# -------------------------------------------------------------------
Add-Section "Related processes (read-only)"
$names = @("charon-agent-host", "python", "netmanager_agent")
foreach ($n in $names) {
    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
    if ($procs) {
        foreach ($p in $procs) {
            try {
                $pathPart = $p.Path
            } catch {
                $pathPart = "(path unavailable)"
            }
            Add-Line ("  {0,-22}  PID={1,-6}  Path={2}" -f $p.Name, $p.Id, $pathPart)
        }
    } else {
        Add-Line ("  " + $n + "        : (no instances)")
    }
}

# -------------------------------------------------------------------
# TLS 1.2 capability (no real HTTP request)
# -------------------------------------------------------------------
Add-Section "TLS 1.2 capability"
try {
    $current = [Net.ServicePointManager]::SecurityProtocol
    Add-Line ("Current SecurityProtocol     : " + $current)
    $tls12 = [Net.SecurityProtocolType]::Tls12
    $supports12 = ([int]$current -band [int]$tls12) -ne 0
    Add-Line ("Supports Tls12 in current scope : " + $supports12)
    Add-Line "(The installer sets Tls12 explicitly at the top of its script; this preflight does not enable Tls12 system-wide.)"
} catch {
    Add-Line "Could not inspect SecurityProtocol."
}

# -------------------------------------------------------------------
# Disk space
# -------------------------------------------------------------------
Add-Section "Disk space"
try {
    $drive = (Get-PSDrive C)
    $freeGB = [math]::Round($drive.Free / 1GB, 2)
    Add-Line ("C: free space               : " + $freeGB + " GB")
    if ($freeGB -lt 2) {
        Add-Block "Less than 2 GB free on C:; installer + service logs may run out of space."
    }
} catch {
    Add-Line "Could not read C: drive free space (non-fatal)."
}

# -------------------------------------------------------------------
# Test output directory writability
# -------------------------------------------------------------------
Add-Section "Output directory writability"
$writeOk = $true
$probe = Join-Path $OutDir ".write-probe.tmp"
try {
    "probe" | Out-File -FilePath $probe -Encoding ASCII -Force
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    Add-Line ("Output directory             : " + $OutDir + "  (writable)")
} catch {
    $writeOk = $false
    Add-Line ("Output directory             : " + $OutDir + "  (NOT writable)")
    Add-Block "Cannot write to C:\Users\Public\CharonAgentTest\."
}

# -------------------------------------------------------------------
# Service Control Manager Event Log (last 20 errors/warnings)
# -------------------------------------------------------------------
Add-Section "SCM Event Log (last 20 errors/warnings)"
try {
    Get-WinEvent -LogName System -MaxEvents 200 -ErrorAction Stop |
        Where-Object {
            ($_.ProviderName -eq "Service Control Manager") -and
            ($_.LevelDisplayName -in @("Error","Warning","Critical"))
        } |
        Select-Object -First 20 |
        ForEach-Object {
            $ts = $_.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            $msg = ($_.Message -split "`r?`n")[0]
            Add-Line ("  [" + $ts + "] " + $_.LevelDisplayName + " (" + $_.Id + "): " + $msg)
        }
} catch {
    Add-Line "Could not query the System Event Log (try running again from an elevated PowerShell if needed)."
}

# -------------------------------------------------------------------
# General HTTPS reachability (no request to production endpoints)
# -------------------------------------------------------------------
Add-Section "General HTTPS reachability"
try {
    $ts = (Test-NetConnection -ComputerName "www.microsoft.com" -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)
    $reach = "FAIL"
    if ($ts) { $reach = "OK" }
    Add-Line ("TCP 443 to www.microsoft.com : " + $reach)
    if (-not $ts) {
        Add-Block "Outbound HTTPS (TCP 443) failed to a public endpoint; installer downloads will fail."
    }
} catch {
    Add-Line "Test-NetConnection unavailable or failed."
}
Add-Line "(No request was made to any NetManager production endpoint.)"

# -------------------------------------------------------------------
# Final verdict
# -------------------------------------------------------------------
Add-Section "Verdict"
if ($blockers.Count -eq 0) {
    Add-Line "No blockers detected. Preflight PASS."
    Add-Line ""
    Add-Line "PRECHECK_RESULT=PASS"
} else {
    Add-Line "BLOCKED reasons:"
    foreach ($b in $blockers) { Add-Line ("  - " + $b) }
    Add-Line ""
    Add-Line "PRECHECK_RESULT=BLOCKED"
}

# Write file (UTF-8 with BOM, CRLF). Force CRLF on write so the
# blob is uniform on tr-TR hosts regardless of how PowerShell
# emits line endings on different runtimes.
$buf = ($lines -join "`r`n") + "`r`n"
$bom = [byte[]](0xEF, 0xBB, 0xBF)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
$tmp = $OutFile + ".tmp"
[System.IO.File]::WriteAllBytes($tmp, ($bom + $bytes))
Move-Item -LiteralPath $tmp -Destination $OutFile -Force
Write-Host ("Preflight written to: " + $OutFile)
if ($blockers.Count -eq 0) {
    exit 0
} else {
    exit 1
}
