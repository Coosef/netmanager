# NetManager / Charon -- diagnostics bundle (safe-to-send)
#
# Writes:
#   C:\Users\Public\CharonAgentTest\diagnostics\        (working folder)
#   C:\Users\Public\CharonAgentTest\CharonAgentDiagnostics-<UTC>.zip
#
# Always safe to run. Never includes:
#   - config.env contents
#   - charon-agent-host.exe.bak
#   - any value that looks like an agent key / Bearer token / JWT / UUID
#
# All collected text files are passed through Mask-Line before write.

$ErrorActionPreference = "Continue"

$OutDir   = "C:\Users\Public\CharonAgentTest"
$Work     = Join-Path $OutDir "diagnostics"
$null = New-Item -ItemType Directory -Force -Path $Work
# Reset working dir to avoid mixing with a prior run
foreach ($child in (Get-ChildItem -LiteralPath $Work -Force -ErrorAction SilentlyContinue)) {
    try {
        Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction Stop
    } catch {}
}

$utcNow  = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$ZipPath = Join-Path $OutDir ("CharonAgentDiagnostics-" + $utcNow + ".zip")

$summary = New-Object System.Collections.Generic.List[string]
function Add-S([string]$s) { $summary.Add($s) | Out-Null }

# Masking
$maskTokens = @(
    @{ Pat = "(?i)X-Agent-Key\s*[:=]\s*\S+";       Repl = "X-Agent-Key=***REDACTED***" }
    @{ Pat = "(?i)AGENT_KEY\s*=\s*\S+";            Repl = "AGENT_KEY=***REDACTED***" }
    @{ Pat = "(?i)Authorization\s*:\s*\S+\s*\S*"; Repl = "Authorization: ***REDACTED***" }
    @{ Pat = "(?i)Bearer\s+[A-Za-z0-9._\-]+";      Repl = "Bearer ***REDACTED***" }
    @{ Pat = "eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"; Repl = "***JWT_REDACTED***" }
    @{ Pat = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"; Repl = "***UUID_REDACTED***" }
    @{ Pat = "(?i)([?&])(agent_key|access_token|token|api_key)=([^&\s]+)"; Repl = '$1$2=***REDACTED***' }
    @{ Pat = "(?i)password\s*[:=]\s*\S+";          Repl = "password=***REDACTED***" }
)
function Mask-Line([string]$s) {
    $out = $s
    foreach ($m in $maskTokens) {
        $out = [regex]::Replace($out, $m.Pat, $m.Repl)
    }
    return $out
}

function Write-Masked-Copy {
    param([string]$Src, [string]$Dst)
    try {
        $tail = Get-Content -LiteralPath $Src -Tail 1000 -ErrorAction Stop
        $masked = $tail | ForEach-Object { Mask-Line $_ }
        $buf = ($masked -join "`r`n") + "`r`n"
        $bom = [byte[]](0xEF, 0xBB, 0xBF)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
        [System.IO.File]::WriteAllBytes($Dst, ($bom + $bytes))
    } catch {
        $err = "COULD_NOT_READ_OR_MASK_FILE`r`n"
        $bom = [byte[]](0xEF, 0xBB, 0xBF)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($err)
        [System.IO.File]::WriteAllBytes($Dst, ($bom + $bytes))
    }
}

Add-S "Charon agent diagnostics bundle"
Add-S ("Generated UTC : " + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
Add-S ("Hostname      : " + ($env:COMPUTERNAME))

# -------------------------------------------------------------------
# system_info.txt
# -------------------------------------------------------------------
$sysInfo = Join-Path $Work "system_info.txt"
$si = New-Object System.Collections.Generic.List[string]
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $si.Add("Caption          : " + $os.Caption) | Out-Null
    $si.Add("Version          : " + $os.Version) | Out-Null
    $si.Add("BuildNumber      : " + $os.BuildNumber) | Out-Null
    $si.Add("OSArchitecture   : " + $os.OSArchitecture) | Out-Null
    $si.Add("Locale (OS)      : " + $os.OSLanguage) | Out-Null
} catch {
    $si.Add("Win32_OperatingSystem unavailable") | Out-Null
}
$si.Add("PSVersion        : " + $PSVersionTable.PSVersion.ToString()) | Out-Null
$si.Add("PSEdition        : " + $PSVersionTable.PSEdition) | Out-Null
$si.Add("CurrentCulture   : " + (Get-Culture).Name) | Out-Null
$si.Add("CurrentUICulture : " + (Get-UICulture).Name) | Out-Null
$si.Add("SystemLocale     : " + ((Get-WinSystemLocale).Name)) | Out-Null
$si.Add("Is64BitOS        : " + [Environment]::Is64BitOperatingSystem) | Out-Null
$si.Add("CLR              : " + [Environment]::Version) | Out-Null

$buf = ($si -join "`r`n") + "`r`n"
$bom = [byte[]](0xEF, 0xBB, 0xBF)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($sysInfo, ($bom + $bytes))

# -------------------------------------------------------------------
# service.txt
# -------------------------------------------------------------------
$svcOut = Join-Path $Work "service.txt"
$so = New-Object System.Collections.Generic.List[string]
try {
    $svc = Get-Service -Name "NetManagerAgent" -ErrorAction Stop
    $so.Add("Name        : " + $svc.Name) | Out-Null
    $so.Add("DisplayName : " + $svc.DisplayName) | Out-Null
    $so.Add("Status      : " + $svc.Status) | Out-Null
    $so.Add("StartType   : " + $svc.StartType) | Out-Null
    $cim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" -ErrorAction Stop
    if ($cim) {
        $so.Add("PathName    : " + $cim.PathName) | Out-Null
        $so.Add("StartName   : " + $cim.StartName) | Out-Null
        $so.Add("ProcessId   : " + $cim.ProcessId) | Out-Null
        $so.Add("Description : " + $cim.Description) | Out-Null
    }
} catch {
    $so.Add("NetManagerAgent service not registered.") | Out-Null
}
$buf = ($so -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($svcOut, ($bom + $bytes))

# -------------------------------------------------------------------
# host_binary.txt + processes.txt
# -------------------------------------------------------------------
$hostOut = Join-Path $Work "host_binary.txt"
$ho = New-Object System.Collections.Generic.List[string]
$installDir = "C:\ProgramData\NetManagerAgent"
$hostExe = Join-Path $installDir "bin\charon-agent-host.exe"
if (Test-Path -LiteralPath $hostExe) {
    try {
        $fi = Get-Item -LiteralPath $hostExe
        $ho.Add("Path     : " + $hostExe) | Out-Null
        $ho.Add("Size     : " + $fi.Length) | Out-Null
        $ho.Add("LastWrite: " + $fi.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")) | Out-Null
        $ho.Add("SHA-256  : " + (Get-FileHash -LiteralPath $hostExe -Algorithm SHA256).Hash) | Out-Null
        $ver = & $hostExe version 2>&1 | Out-String
        $ho.Add("version  : " + ($ver.Trim())) | Out-Null
    } catch {
        $ho.Add("Could not stat or hash host binary.") | Out-Null
    }
} else {
    $ho.Add("charon-agent-host.exe missing.") | Out-Null
}
$buf = ($ho -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($hostOut, ($bom + $bytes))

$procOut = Join-Path $Work "processes.txt"
$po = New-Object System.Collections.Generic.List[string]
try {
    $hostPid = 0
    $cim = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" -ErrorAction SilentlyContinue
    if ($cim) { $hostPid = [int]$cim.ProcessId }
    $po.Add("Go host PID: " + $hostPid) | Out-Null
    if ($hostPid -gt 0) {
        $kids = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $hostPid) -ErrorAction SilentlyContinue
        foreach ($k in $kids) {
            $po.Add(("child PID=" + $k.ProcessId + "  Name=" + $k.Name + "  Exec=" + $k.ExecutablePath)) | Out-Null
        }
    }
    foreach ($n in @("charon-agent-host","python","python3","pythonw")) {
        $matches = Get-Process -Name $n -ErrorAction SilentlyContinue
        foreach ($m in $matches) {
            $po.Add(("by-name " + $n + ": PID=" + $m.Id + "  StartTime=" + ($m.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")))) | Out-Null
        }
    }
} catch {}
$buf = ($po -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($procOut, ($bom + $bytes))

# -------------------------------------------------------------------
# install_dir_listing.txt  (metadata only, no content)
# -------------------------------------------------------------------
$listOut = Join-Path $Work "install_dir_listing.txt"
$lo = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $installDir) {
    try {
        $items = Get-ChildItem -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue |
                 Where-Object { -not $_.PSIsContainer }
        foreach ($it in $items) {
            # Skip config.env content; only list metadata
            $lo.Add(("{0,12}  {1}  {2}" -f $it.Length, $it.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"), $it.FullName)) | Out-Null
        }
    } catch {
        $lo.Add("Listing failed.") | Out-Null
    }
} else {
    $lo.Add("Install directory missing.") | Out-Null
}
$buf = ($lo -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($listOut, ($bom + $bytes))

# -------------------------------------------------------------------
# logs/  (masked, last 1000 lines each)
# -------------------------------------------------------------------
$logsDest = Join-Path $Work "logs"
$null = New-Item -ItemType Directory -Force -Path $logsDest
$logSrc = Join-Path $installDir "logs"
if (Test-Path -LiteralPath $logSrc) {
    foreach ($lg in @("service-host.log", "agent.stdout.log", "agent.stderr.log")) {
        $src = Join-Path $logSrc $lg
        if (Test-Path -LiteralPath $src) {
            Write-Masked-Copy -Src $src -Dst (Join-Path $logsDest ($lg + ".masked.txt"))
        }
    }
}

# Test-package outputs (preflight / post-install / installer logs) -- already masked at source
foreach ($n in @("preflight.txt","post-install.txt","installer-run.txt","installer-exit-code.txt","installer-sha256.txt","installer-parser-result.txt","service-lifecycle.txt")) {
    $p = Join-Path $OutDir $n
    if (Test-Path -LiteralPath $p) {
        $dst = Join-Path $Work ("package_outputs__" + $n)
        # Re-mask defensively
        Write-Masked-Copy -Src $p -Dst $dst
    }
}

# -------------------------------------------------------------------
# event_log.txt
# -------------------------------------------------------------------
$evtOut = Join-Path $Work "event_log.txt"
$eo = New-Object System.Collections.Generic.List[string]
try {
    $evt = Get-WinEvent -FilterHashtable @{
        LogName = @("Application","System")
        ProviderName = @("NetManagerAgentHost","Service Control Manager")
    } -MaxEvents 200 -ErrorAction Stop
    foreach ($e in ($evt | Sort-Object TimeCreated -Descending)) {
        $ts = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        $first = ($e.Message -split "`r?`n")[0]
        $eo.Add(("[" + $ts + "] " + $e.ProviderName + " (" + $e.Id + ") " + $e.LevelDisplayName + ": " + (Mask-Line $first))) | Out-Null
    }
} catch {
    $eo.Add("Event log query failed (or no records).") | Out-Null
}
$buf = ($eo -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($evtOut, ($bom + $bytes))

# -------------------------------------------------------------------
# summary
# -------------------------------------------------------------------
Add-S ""
Add-S "Files in bundle:"
foreach ($it in (Get-ChildItem -LiteralPath $Work -Recurse -Force)) {
    if ($it.PSIsContainer) { continue }
    Add-S ("  " + $it.FullName.Substring($Work.Length).TrimStart("\"))
}
$summaryFile = Join-Path $Work "summary.txt"
$buf = ($summary -join "`r`n") + "`r`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
[System.IO.File]::WriteAllBytes($summaryFile, ($bom + $bytes))

# -------------------------------------------------------------------
# ZIP
# -------------------------------------------------------------------
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
try {
    Compress-Archive -Path (Join-Path $Work "*") -DestinationPath $ZipPath -Force -ErrorAction Stop
    Write-Host ("Diagnostics ZIP : " + $ZipPath)
    Write-Host "Send the ZIP back through AnyDesk."
    exit 0
} catch {
    Write-Host "Compress-Archive failed; the working folder is still on disk:"
    Write-Host ("  " + $Work)
    exit 1
}
