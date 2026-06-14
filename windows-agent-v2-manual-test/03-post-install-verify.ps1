# 03-post-install-verify.ps1 - NetManager Windows Agent v2 (Architecture Plan v11)
#
# Confirm the installed agent is running with the PRIVATE Python runtime
# from payload\current\runtime\python\ and that its SCM registration
# matches the canonical Stage-10 ImagePath argv shape.
#
# Verifications (each emits [OK] / [FAIL]):
#
#   1. payload\current\runtime\python\python.exe exists.
#   2. Its --version matches Python 3.12.x.
#   3. The on-disk smoke list at
#        payload\current\metadata\runtime-smoke-imports.txt
#      is byte-identical to the verification-only copy that ships in
#      this package (catches a tampered deployed mirror; correction #63).
#   4. The smoke imports succeed under -E -I (isolated mode) and print
#      the byte-exact literal RUNTIME_OK on stdout, with stderr empty
#      (correction #46 + #66).
#   5. The Go host CLI reports `status -> Running` via the canonical
#      Invoke-ProcessCaptured contract (.ExitCode == 0 + .Stdout TrimEnd
#      == "Running" + .Stderr empty).
#   6. The currently-Running host process has exactly one Python child
#      whose ExecutablePath equals payload\current\runtime\python\python.exe
#      (NOT a system Python on PATH).
#   7. The SCM registration ImagePath argv matches the Stage 11.C
#      canonical-equivalence shape (correction #69 / #70).
#
# Exit codes:
#   0  all verifications PASS
#   1  any verification FAIL
#   3  the agent is not installed in the expected location

$ErrorActionPreference = "Stop"

$InstallDir       = "C:\ProgramData\NetManagerAgent"
$BinDir           = "$InstallDir\bin"
$LogDir           = "$InstallDir\logs"
$PayloadCurrent   = "$InstallDir\payload\current"
$AppDir           = "$PayloadCurrent\app"
$Entrypoint       = "$AppDir\run_agent.py"
$PrivatePython    = "$PayloadCurrent\runtime\python\python.exe"
$MetadataDir      = "$PayloadCurrent\metadata"
$SmokeListLive    = "$MetadataDir\runtime-smoke-imports.txt"
$ConfigEnvLive    = "$InstallDir\config.env"
$HostExeLive      = "$BinDir\charon-agent-host.exe"
$ServiceName      = "NetManagerAgent"
$DisplayName      = "NetManager Proxy Agent"
$ServiceDescription = "Charon agent host - manages the NetManager proxy agent child process."

if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host "[FAIL] $InstallDir does not exist; agent is not installed." -ForegroundColor Red
    exit 3
}

$failures = New-Object System.Collections.ArrayList
function Add-Fail { param([string]$r) [void]$script:failures.Add($r) }

# Invoke-ProcessCaptured -- mirror of the installer's PS 5.1 helper that
# captures stdout / stderr / exit code separately so the agent key never
# leaks via call-operator pipeline pollution. Temp files are
# LOGICAL_DELETEd in the finally block (correction #57 + #66).
function Invoke-ProcessCaptured {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ArgumentList
    )
    $tmpDir = Join-Path $env:TEMP ("nm-verify-" + [guid]::NewGuid().ToString())
    [System.IO.Directory]::CreateDirectory($tmpDir) | Out-Null
    $stdoutPath = Join-Path $tmpDir "o.txt"
    $stderrPath = Join-Path $tmpDir "e.txt"
    $exitCode = 1; $stdoutText = ""; $stderrText = ""
    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError  $stderrPath
        if ($proc -and $proc.ExitCode -ne $null) { $exitCode = [int]$proc.ExitCode }
        if (Test-Path -LiteralPath $stdoutPath) {
            $stdoutText = [System.IO.File]::ReadAllText($stdoutPath)
        }
        if (Test-Path -LiteralPath $stderrPath) {
            $stderrText = [System.IO.File]::ReadAllText($stderrPath)
        }
    }
    finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Stdout   = [string]$stdoutText
        Stderr   = [string]$stderrText
    }
}

# 1. Private Python runtime exists.
if (Test-Path -LiteralPath $PrivatePython) {
    Write-Host "[OK] Private Python runtime present at $PrivatePython"
} else {
    Add-Fail "private python missing at $PrivatePython"
}

# 2. Private python --version matches Python 3.12.x.
if (Test-Path -LiteralPath $PrivatePython) {
    $ver = Invoke-ProcessCaptured -FilePath $PrivatePython -ArgumentList @("-E","-I","--version")
    $verTrim = $ver.Stdout.TrimEnd("`r","`n")
    if ($ver.ExitCode -eq 0 -and $verTrim -match '^Python 3\.12\.\d+$') {
        Write-Host "[OK] Private Python runtime version: $verTrim"
    } else {
        Add-Fail "private python --version unexpected (exit=$($ver.ExitCode), out=$verTrim)"
    }
}

# 3. Deployed smoke list matches the verification-only copy byte-for-byte.
$packageSmoke = Join-Path $PSScriptRoot "runtime-smoke-imports.txt"
if ((Test-Path -LiteralPath $SmokeListLive) -and (Test-Path -LiteralPath $packageSmoke)) {
    $live = [System.IO.File]::ReadAllBytes($SmokeListLive)
    $pkg  = [System.IO.File]::ReadAllBytes($packageSmoke)
    if (($live.Length -eq $pkg.Length) -and -not (Compare-Object $live $pkg -SyncWindow 0)) {
        Write-Host "[OK] Deployed smoke list byte-identical to v4 package copy ($($live.Length) bytes)."
    } else {
        Add-Fail "smoke list mismatch: deployed=$($live.Length)B vs package=$($pkg.Length)B"
    }
} else {
    Add-Fail "smoke list missing at $SmokeListLive or $packageSmoke"
}

# 4. RUNTIME_OK byte-exact smoke probe via Invoke-ProcessCaptured.
if (Test-Path -LiteralPath $PrivatePython) {
    [string[]]$modules = @()
    foreach ($line in (Get-Content -LiteralPath $packageSmoke)) {
        if ($line -match '^[A-Za-z_][A-Za-z0-9_.]*$') { $modules += $line }
    }
    $modArg = $modules -join ", "
    $smoke = Invoke-ProcessCaptured -FilePath $PrivatePython `
        -ArgumentList @("-E","-I","-c","import $modArg; print('RUNTIME_OK')")
    $smokeTrim = $smoke.Stdout.TrimEnd("`r","`n")
    if ($smoke.ExitCode -eq 0 -and $smokeTrim -ceq "RUNTIME_OK" -and $smoke.Stderr.Length -eq 0) {
        Write-Host "[OK] Smoke probe: byte-exact RUNTIME_OK, stderr empty."
    } else {
        Add-Fail ("smoke probe failed (exit=$($smoke.ExitCode), stdout=$smokeTrim, " +
                  "stderr-bytes=$($smoke.Stderr.Length))")
    }
}

# 5. Go host CLI status -> Running via canonical Invoke-ProcessCaptured.
if (Test-Path -LiteralPath $HostExeLive) {
    $st = Invoke-ProcessCaptured -FilePath $HostExeLive `
        -ArgumentList @("status","--service-name",$ServiceName)
    $stTrim = $st.Stdout.TrimEnd("`r","`n")
    if ($st.ExitCode -eq 0 -and $stTrim -ceq "Running" -and $st.Stderr.Length -eq 0) {
        Write-Host "[OK] Service status: Running (exit 0, stderr empty)."
    } else {
        Add-Fail "service status not Running (exit=$($st.ExitCode), out=$stTrim, stderr=$($st.Stderr.Length)B)"
    }
} else {
    Add-Fail "Go host binary missing at $HostExeLive"
}

# 6. Running host process has a Python child whose ExecutablePath equals
# the PRIVATE python.exe (catches a misconfigured ImagePath that hands
# off to a system Python on PATH).
try {
    $hostProcs = @(Get-CimInstance Win32_Process -Filter "ExecutablePath='$($HostExeLive.Replace('\','\\'))'" -ErrorAction SilentlyContinue)
    if ($hostProcs.Count -ne 1) {
        Add-Fail "expected exactly one running host process; found $($hostProcs.Count)"
    } else {
        $hostPid = [int]$hostProcs[0].ProcessId
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$hostPid" -ErrorAction SilentlyContinue)
        $pyChildren = @($children | Where-Object { "$($_.ExecutablePath)" -ceq $PrivatePython })
        if ($pyChildren.Count -lt 1) {
            Add-Fail "host child is not the private python.exe (found: $($children.ExecutablePath -join ', '))"
        } else {
            Write-Host "[OK] Host child process is the PRIVATE python.exe at $PrivatePython"
        }
    }
} catch {
    Add-Fail "could not enumerate host process tree: $($_.Exception.Message)"
}

# 7. SCM registration ImagePath argv matches the Stage 11.C canonical
# equivalence shape (correction #69 + #70). This catches a foreign
# DisplayName, a non-LocalSystem service account, a wrong --child-exe,
# a missing -E -I --child-arg triple, or a wrong --env-file.
try {
    $row = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    if (-not $row) {
        Add-Fail "Win32_Service has no row for $ServiceName"
    } else {
        $expectedImagePath = "$HostExeLive run --service-name $ServiceName --display-name `"$DisplayName`" --description `"$ServiceDescription`" --child-exe $PrivatePython --child-arg -E --child-arg -I --child-arg $Entrypoint --work-dir $AppDir --env-file $ConfigEnvLive --log-dir $LogDir --service-account LocalSystem"
        if ("$($row.PathName)" -cne $expectedImagePath) {
            Add-Fail "ImagePath drift vs Stage 11.C canonical shape"
        } elseif ("$($row.StartMode)" -cne "Auto") {
            Add-Fail "StartMode $($row.StartMode) is not Auto"
        } elseif ("$($row.StartName)" -cne "LocalSystem") {
            Add-Fail "Service account $($row.StartName) is not LocalSystem"
        } else {
            Write-Host "[OK] SCM registration matches Stage 11.C canonical-equivalence shape."
        }
    }
} catch {
    Add-Fail "SCM probe failed: $($_.Exception.Message)"
}

Write-Host ""
if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "[FAIL] $f" -ForegroundColor Red }
    "POST_INSTALL_RESULT=FAIL" | Tee-Object -FilePath post-install.txt
    exit 1
}

"POST_INSTALL_RESULT=PASS" | Tee-Object -FilePath post-install.txt
exit 0
