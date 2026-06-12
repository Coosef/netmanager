# NetManager / Charon -- Windows Agent v2 manual test preflight
# Package version: v3
#
# v3 hotfix scope (after a real Windows Server 2019 / PS 5.1 run
# produced a preflight.txt that was 4215 bytes of pure 0x00):
#   - Authoritative writer rewritten to the operator-recommended
#     pattern: [CmdletBinding] + [string[]] $Lines with
#     [AllowEmptyCollection], explicit [string]::Join, explicit
#     [string]$text cast, UTF8Encoding($true) + WriteAllText.
#   - At every call site the buffer is force-cast: [string[]]@($lines).
#   - A sidecar file is written next to the primary output proving
#     the runtime types and the SHA-256 of the bytes the writer
#     actually fed to WriteAllText. If the file on disk later
#     differs from that SHA-256, we know something outside the
#     script (AV, EDR, snapshot) is rewriting it.
#   - Confirm-OutputContract now explicitly counts NUL bytes,
#     non-zero bytes, and bails on a fully-zero-filled file.
#   - Fallback writer is a completely separate inline WriteAllText
#     call -- it does NOT reuse the helper.
#
# READ-ONLY system probe. Writes a single text file:
#     C:\Users\Public\CharonAgentTest\preflight.txt
#
# The LAST non-empty line of that file is one of:
#     PRECHECK_RESULT=PASS
#     PRECHECK_RESULT=BLOCKED
#
# This script:
#   - does NOT install anything
#   - does NOT touch any existing NetManagerAgent service
#   - does NOT change firewall, antivirus, registry, ExecutionPolicy
#   - does NOT send any HTTP request to production endpoints
#   - does NOT need elevation (admin role is REPORTED, not REQUESTED)

$ErrorActionPreference = "Stop"

# -------------------------------------------------------------------
# Output paths
# -------------------------------------------------------------------
$OutDir       = "C:\Users\Public\CharonAgentTest"
$OutFile      = Join-Path $OutDir "preflight.txt"
$DebugFile    = Join-Path $OutDir "preflight-debug.txt"
$FallbackFile = Join-Path $OutDir "preflight-write-failure.txt"

$lines    = New-Object System.Collections.Generic.List[string]
$blockers = New-Object System.Collections.Generic.List[string]

function Add-Line   { param([string]$s)      $lines.Add($s)    | Out-Null }
function Add-Block  { param([string]$reason) $blockers.Add($reason) | Out-Null }
function Add-Section {
    param([string]$title)
    Add-Line ""
    Add-Line ("=" * 64)
    Add-Line $title
    Add-Line ("=" * 64)
}

# -------------------------------------------------------------------
# Authoritative writer (operator pattern, verbatim shape)
# -------------------------------------------------------------------
# Returns the SHA-256 (hex, uppercase) of the bytes actually fed to
# WriteAllText, so the caller can prove what got written.
function Write-TextFileUtf8BomCrLf {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,

        # PowerShell's Mandatory validator runs against each ELEMENT of
        # a typed string[]; the first empty string in the array fails
        # the bind with "Cannot bind argument to parameter 'Lines'
        # because it is an empty string." Adding BOTH AllowEmptyString
        # and AllowEmptyCollection is required to accept a mixed array
        # (which a real preflight report always contains -- section
        # spacer lines are empty).
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$Lines
    )
    $parent = [System.IO.Path]::GetDirectoryName($LiteralPath)
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    # Build a real System.String, force-typed.
    $text = [string]::Join("`r`n", [string[]]$Lines)
    if (-not $text.EndsWith("`r`n")) {
        $text = $text + "`r`n"
    }
    $text = [string]$text   # belt-and-suspenders against PSObject unwrap

    $utf8Bom = New-Object System.Text.UTF8Encoding($true)

    # Compute the byte stream we are about to write so we can hash it.
    # Note: GetPreamble + GetBytes is exactly what WriteAllText does
    # internally for the "no FileStream" overload, so this lets us
    # prove what we asked the runtime to write.
    $preamble = $utf8Bom.GetPreamble()
    $payload  = $utf8Bom.GetBytes($text)
    $sha      = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash(($preamble + $payload))
    } finally {
        $sha.Dispose()
    }
    $hashHex = ($hashBytes | ForEach-Object { $_.ToString("X2") }) -join ""

    [System.IO.File]::WriteAllText(
        $LiteralPath,
        [string]$text,
        $utf8Bom
    )

    return [pscustomobject]@{
        TextType         = $text.GetType().FullName
        TextLength       = $text.Length
        TextHasNul       = ($text.IndexOf([char]0) -ge 0)
        EncodedByteCount = $payload.Length
        PreambleLength   = $preamble.Length
        ExpectedSha256   = $hashHex
    }
}

# -------------------------------------------------------------------
# Self-validation: re-read the file and prove the byte contract.
# Throws on any deviation. Caller writes a fallback file.
# -------------------------------------------------------------------
function Confirm-OutputContract {
    param(
        [Parameter(Mandatory=$true)][string]$LiteralPath,
        [Parameter(Mandatory=$true)][string]$ExpectedLastLineRegex,
        [Parameter(Mandatory=$true)][string]$ExpectedSha256
    )
    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        throw "output file missing after write"
    }
    $bytes = [System.IO.File]::ReadAllBytes($LiteralPath)
    if ($bytes.Length -lt 100) {
        throw ("output too small (" + $bytes.Length + " bytes)")
    }

    # Count NUL and non-zero explicitly. A fully-zero-filled buffer
    # is the failure mode we saw on the real Server 2019 machine.
    $nulCount = 0
    $nonZero  = 0
    foreach ($b in $bytes) {
        if ($b -eq 0) { $nulCount++ } else { $nonZero++ }
    }
    if ($nonZero -eq 0) {
        throw ("output is entirely zero-filled (" + $bytes.Length + " bytes, all 0x00)")
    }
    if ($nulCount -gt 0) {
        throw ("NUL byte count = " + $nulCount + " (must be 0)")
    }
    if (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
        throw ("BOM missing in first 3 bytes (got " + ("{0:X2} {1:X2} {2:X2}" -f $bytes[0], $bytes[1], $bytes[2]) + ")")
    }
    if ($bytes.Length -ge 6) {
        if ($bytes[3] -eq 0xEF -and $bytes[4] -eq 0xBB -and $bytes[5] -eq 0xBF) {
            throw "double BOM detected"
        }
    }
    # Prove the bytes on disk match the bytes we fed to WriteAllText.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actualHashBytes = $sha.ComputeHash($bytes)
    } finally {
        $sha.Dispose()
    }
    $actualHashHex = ($actualHashBytes | ForEach-Object { $_.ToString("X2") }) -join ""
    if ($actualHashHex -ne $ExpectedSha256) {
        throw ("SHA-256 mismatch: writer fed " + $ExpectedSha256.Substring(0,16) + "... ; disk has " + $actualHashHex.Substring(0,16) + "... (a third-party process may be rewriting the file)")
    }
    # Strict UTF-8 decode
    $strict = New-Object System.Text.UTF8Encoding $true, $true
    try {
        $text = $strict.GetString($bytes, 3, $bytes.Length - 3)
    } catch {
        throw ("strict UTF-8 decode failed: " + $_.Exception.GetType().FullName)
    }
    $bareLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
    if ($bareLf -gt 0) {
        throw ("bare LF count = " + $bareLf + " (must be 0)")
    }
    $allLines = $text -split "`r`n"
    $lastNonEmpty = $null
    for ($i = $allLines.Length - 1; $i -ge 0; $i--) {
        if ($allLines[$i].Trim().Length -gt 0) {
            $lastNonEmpty = $allLines[$i]
            break
        }
    }
    if ($null -eq $lastNonEmpty) {
        throw "no non-empty lines in output"
    }
    if ($lastNonEmpty -notmatch $ExpectedLastLineRegex) {
        throw ("last non-empty line did not match expected marker: " + $lastNonEmpty)
    }
}

# -------------------------------------------------------------------
# Sidecar debug writer -- runtime-type evidence, NO secrets.
# Uses its OWN inline WriteAllText so a writer-helper bug cannot
# hide the evidence.
# -------------------------------------------------------------------
function Write-DebugSidecar {
    param(
        [string]$LiteralPath,
        [string]$LinesType,
        [int]$LinesCount,
        [string]$TextType,
        [int]$TextLength,
        [bool]$TextHasNul,
        [int]$EncodedByteCount,
        [int]$PreambleLength,
        [string]$ExpectedSha256,
        [string]$ScriptVersion,
        [string]$WriteOutcome
    )
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append("CHARON PREFLIGHT WRITER DEBUG").Append("`r`n")
    $null = $sb.Append("SCRIPT_VERSION=").Append($ScriptVersion).Append("`r`n")
    $null = $sb.Append("LINES_TYPE=").Append($LinesType).Append("`r`n")
    $null = $sb.Append("LINES_COUNT=").Append($LinesCount).Append("`r`n")
    $null = $sb.Append("TEXT_TYPE=").Append($TextType).Append("`r`n")
    $null = $sb.Append("TEXT_LENGTH=").Append($TextLength).Append("`r`n")
    $null = $sb.Append("TEXT_HAS_NUL=").Append($TextHasNul).Append("`r`n")
    $null = $sb.Append("ENCODED_BYTE_COUNT=").Append($EncodedByteCount).Append("`r`n")
    $null = $sb.Append("PREAMBLE_LENGTH=").Append($PreambleLength).Append("`r`n")
    $null = $sb.Append("EXPECTED_SHA256=").Append($ExpectedSha256).Append("`r`n")
    $null = $sb.Append("WRITE_OUTCOME=").Append($WriteOutcome).Append("`r`n")
    $enc = New-Object System.Text.UTF8Encoding($true)
    try {
        [System.IO.File]::WriteAllText($LiteralPath, [string]$sb.ToString(), $enc)
    } catch {}
}

# -------------------------------------------------------------------
# Fallback writer -- SEPARATE inline WriteAllText, not the helper.
# -------------------------------------------------------------------
function Write-FallbackFile {
    param([string]$LiteralPath, [string]$FailureType, [string]$FailureMsg)
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append("NetManager Agent v2 - Preflight output validation FAILED").Append("`r`n")
    $null = $sb.Append("Failure type : ").Append($FailureType).Append("`r`n")
    $null = $sb.Append("Detail       : ").Append($FailureMsg).Append("`r`n")
    $null = $sb.Append("").Append("`r`n")
    $null = $sb.Append("This file exists because the primary writer or self-validation rejected the").Append("`r`n")
    $null = $sb.Append("primary output. Send THIS file back along with the (likely corrupt)").Append("`r`n")
    $null = $sb.Append("preflight.txt and the preflight-debug.txt next to it.").Append("`r`n")
    $null = $sb.Append("").Append("`r`n")
    $null = $sb.Append("PRECHECK_RESULT=BLOCKED").Append("`r`n")
    $enc = New-Object System.Text.UTF8Encoding($true)
    try {
        [System.IO.File]::WriteAllText($LiteralPath, [string]$sb.ToString(), $enc)
    } catch {}
}

$ScriptVersion = "v3"
$resultLabel = "BLOCKED"
$exitCode    = 3

# Ensure $OutDir exists BEFORE try/finally.
try {
    $null = New-Item -ItemType Directory -Force -Path $OutDir -ErrorAction Stop
} catch {
    Write-Host ("FATAL: Could not create output directory: " + $OutDir)
    Write-Host ("Detail: " + $_.Exception.GetType().FullName)
    exit 3
}

try {
    $utcNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Add-Line "NetManager Agent v2 - Preflight Report"
    Add-Line "Package version: v3"
    Add-Line ("Generated UTC: " + $utcNow)
    Add-Line "Script: 01-preflight.ps1"

    Add-Section "Windows + Locale"
    try {
        $cim = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
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
    try {
        Add-Line ("Culture         : " + (Get-Culture).Name)
        Add-Line ("UICulture       : " + (Get-UICulture).Name)
    } catch {
        Add-Line "Culture / UICulture query failed."
    }
    try {
        $sysLocale = (Get-WinSystemLocale).Name
        Add-Line ("SystemLocale    : " + $sysLocale)
    } catch {
        Add-Line "SystemLocale    : (Get-WinSystemLocale not available on this host)"
    }

    Add-Section "PowerShell"
    $psv = $PSVersionTable.PSVersion
    $detectedPsEdition = $PSVersionTable.PSEdition
    Add-Line ("PSVersion       : " + $psv.ToString())
    Add-Line ("PSEdition       : " + $detectedPsEdition)
    Add-Line ("CLRVersion      : " + $PSVersionTable.CLRVersion)
    if ($psv.Major -ne 5) {
        Add-Block ("Windows PowerShell 5.1 expected; found " + $psv.ToString() + ".")
    }
    if ($detectedPsEdition -ne "Desktop") {
        Add-Block ("Windows PowerShell Desktop edition expected; found " + $detectedPsEdition + ".")
    }

    Add-Section "Process + Architecture"
    Add-Line ("PROCESSOR_ARCHITECTURE      : " + $env:PROCESSOR_ARCHITECTURE)
    Add-Line ("PROCESSOR_ARCHITEW6432      : " + ($env:PROCESSOR_ARCHITEW6432 -as [string]))
    $is64Proc = [System.Environment]::Is64BitProcess
    $is64Os   = [System.Environment]::Is64BitOperatingSystem
    Add-Line ("Is64BitProcess              : " + $is64Proc)
    Add-Line ("Is64BitOperatingSystem      : " + $is64Os)
    if (-not $is64Os) {
        Add-Block "Windows Agent v2 requires a 64-bit (amd64) Windows OS."
    }

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

    Add-Section "Reboot Pending"
    $rebootSignals = @()
    foreach ($path in @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending"
    )) {
        try { if (Test-Path -LiteralPath $path) { $rebootSignals += $path } } catch {}
    }
    if ($rebootSignals.Count -gt 0) {
        Add-Line "Reboot is pending. Detected signals:"
        foreach ($s in $rebootSignals) { Add-Line ("  " + $s) }
        Add-Block "Reboot pending; reboot the test machine before installing."
    } else {
        Add-Line "No reboot pending."
    }

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
    if ($pyLauncher) { Add-Line ("py.exe launcher              : " + $pyLauncher.Source) }
    else             { Add-Line "py.exe launcher              : not present (optional)" }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) { Add-Line ("winget                       : " + $winget.Source) }
    else {
        Add-Line "winget                       : not present"
        if (-not $pyCmd) {
            Add-Block "No Python AND no winget. Installer cannot auto-install Python; install Python 3.12 manually first."
        }
    }

    Add-Section "Existing NetManagerAgent service"
    $existing = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
    if ($existing) {
        Add-Line ("Status        : " + $existing.Status)
        Add-Line ("StartType     : " + $existing.StartType)
        Add-Line ("DisplayName   : " + $existing.DisplayName)
        try {
            $svcCim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" -ErrorAction Stop
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
        Add-Block "An existing NetManagerAgent service is registered. Decide handling before installer."
    } else {
        Add-Line "No NetManagerAgent service registered."
    }

    Add-Section "Existing install directory"
    $installDir = "C:\ProgramData\NetManagerAgent"
    $hostExe = Join-Path $installDir "bin\charon-agent-host.exe"
    if (Test-Path -LiteralPath $installDir) {
        Add-Line ("Install directory present   : " + $installDir)
        try {
            foreach ($it in (Get-ChildItem -LiteralPath $installDir -Force -ErrorAction Stop)) {
                Add-Line ("  {0}  {1,12}  {2}" -f $it.Mode, $it.Length, $it.Name)
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

    Add-Section "Related processes (read-only)"
    foreach ($n in @("charon-agent-host", "python", "netmanager_agent")) {
        $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
        if ($procs) {
            foreach ($p in $procs) {
                $pathPart = "(path unavailable)"
                try { $pathPart = $p.Path } catch {}
                Add-Line ("  {0,-22}  PID={1,-6}  Path={2}" -f $p.Name, $p.Id, $pathPart)
            }
        } else {
            Add-Line ("  " + $n + "        : (no instances)")
        }
    }

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

    Add-Section "Disk space"
    try {
        $drive = (Get-PSDrive C -ErrorAction Stop)
        $freeGB = [math]::Round($drive.Free / 1GB, 2)
        Add-Line ("C: free space               : " + $freeGB + " GB")
        if ($freeGB -lt 2) {
            Add-Block "Less than 2 GB free on C:; installer + service logs may run out of space."
        }
    } catch {
        Add-Line "Could not read C: drive free space (non-fatal)."
    }

    Add-Section "Output directory writability"
    $probe = Join-Path $OutDir ".write-probe.tmp"
    try {
        "probe" | Out-File -FilePath $probe -Encoding ASCII -Force
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        Add-Line ("Output directory             : " + $OutDir + "  (writable)")
    } catch {
        Add-Line ("Output directory             : " + $OutDir + "  (NOT writable)")
        Add-Block "Cannot write to C:\Users\Public\CharonAgentTest\."
    }

    Add-Section "SCM Event Log (last 20 errors/warnings)"
    try {
        $records = Get-WinEvent -LogName System -MaxEvents 200 -ErrorAction Stop |
            Where-Object {
                ($_.ProviderName -eq "Service Control Manager") -and
                ($_.LevelDisplayName -in @("Error","Warning","Critical"))
            } |
            Select-Object -First 20
        foreach ($r in $records) {
            $ts = $r.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            $msg = ($r.Message -split "`r?`n")[0]
            Add-Line ("  [" + $ts + "] " + $r.LevelDisplayName + " (" + $r.Id + "): " + $msg)
        }
    } catch {
        Add-Line "Could not query the System Event Log (try running again from an elevated PowerShell if needed)."
    }

    Add-Section "General HTTPS reachability"
    try {
        $tn = Test-NetConnection -ComputerName "www.microsoft.com" -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
        $reach = "FAIL"
        if ($tn) { $reach = "OK" }
        Add-Line ("TCP 443 to www.microsoft.com : " + $reach)
        if (-not $tn) {
            Add-Block "Outbound HTTPS (TCP 443) failed to a public endpoint; installer downloads will fail."
        }
    } catch {
        Add-Line "Test-NetConnection unavailable or failed."
    }
    Add-Line "(No request was made to any NetManager production endpoint.)"

    Add-Section "Verdict"
    if ($blockers.Count -eq 0) {
        Add-Line "No blockers detected. Preflight PASS."
        Add-Line ""
        Add-Line "PRECHECK_RESULT=PASS"
        $resultLabel = "PASS"
        $exitCode = 0
    } else {
        Add-Line "BLOCKED reasons:"
        foreach ($b in $blockers) { Add-Line ("  - " + $b) }
        Add-Line ""
        Add-Line "PRECHECK_RESULT=BLOCKED"
        $resultLabel = "BLOCKED"
        $exitCode = 1
    }
} catch {
    Add-Line ""
    Add-Line "------------------------------------------------------------"
    Add-Line "UNEXPECTED PREFLIGHT FAILURE"
    Add-Line "------------------------------------------------------------"
    Add-Line ("Failure type    : " + $_.Exception.GetType().FullName)
    Add-Line "Preflight could not complete; result forced to BLOCKED."
    Add-Line ""
    Add-Line "PRECHECK_RESULT=BLOCKED"
    $resultLabel = "BLOCKED"
    $exitCode = 3
} finally {
    try { $null = New-Item -ItemType Directory -Force -Path $OutDir -ErrorAction Stop } catch {}

    # Force buffer into a real System.String[] BEFORE calling the writer.
    [string[]]$reportLines = @($lines | ForEach-Object { [string]$_ })
    $linesType = $reportLines.GetType().FullName
    $linesCount = $reportLines.Length

    $outputOk      = $false
    $writeErrType  = ""
    $writeErrMsg   = ""
    $writeInfo     = $null

    try {
        $writeInfo = Write-TextFileUtf8BomCrLf -LiteralPath $OutFile -Lines $reportLines
        Confirm-OutputContract -LiteralPath $OutFile `
            -ExpectedLastLineRegex "^PRECHECK_RESULT=(PASS|BLOCKED)$" `
            -ExpectedSha256 $writeInfo.ExpectedSha256
        $outputOk = $true
    } catch {
        $writeErrType = $_.Exception.GetType().FullName
        $writeErrMsg  = $_.Exception.Message
        Write-FallbackFile -LiteralPath $FallbackFile `
            -FailureType $writeErrType -FailureMsg $writeErrMsg
        $exitCode = 3
    }

    # Always write the debug sidecar -- runtime types + writer SHA.
    $textType   = "<unknown>"
    $textLen    = -1
    $hasNul     = $false
    $byteCount  = -1
    $preLen     = -1
    $expSha     = ""
    if ($writeInfo) {
        $textType  = [string]$writeInfo.TextType
        $textLen   = [int]$writeInfo.TextLength
        $hasNul    = [bool]$writeInfo.TextHasNul
        $byteCount = [int]$writeInfo.EncodedByteCount
        $preLen    = [int]$writeInfo.PreambleLength
        $expSha    = [string]$writeInfo.ExpectedSha256
    }
    $writeOutcome = "OK"
    if (-not $outputOk) { $writeOutcome = "FAIL: " + $writeErrType + " :: " + $writeErrMsg }
    Write-DebugSidecar -LiteralPath $DebugFile `
        -LinesType $linesType -LinesCount $linesCount `
        -TextType $textType -TextLength $textLen -TextHasNul $hasNul `
        -EncodedByteCount $byteCount -PreambleLength $preLen `
        -ExpectedSha256 $expSha -ScriptVersion $ScriptVersion `
        -WriteOutcome $writeOutcome

    if ($outputOk) {
        Write-Host ("Preflight written to: " + $OutFile)
        Write-Host ("Debug sidecar       : " + $DebugFile)
    } else {
        Write-Host "PRECHECK OUTPUT VALIDATION FAILED"
        Write-Host ("Failure type : " + $writeErrType)
        Write-Host ("Detail       : " + $writeErrMsg)
        Write-Host ("Fallback     : " + $FallbackFile)
        Write-Host ("Debug        : " + $DebugFile)
    }
}

exit $exitCode
