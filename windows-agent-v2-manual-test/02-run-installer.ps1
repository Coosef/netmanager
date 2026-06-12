# NetManager / Charon -- Windows Agent v2 installer wrapper
#
# Validates a .ps1 installer (byte contract + ParseFile + forbidden
# patterns + required markers) and runs it via -File under UAC.
#
# NEVER pipes the installer body into Invoke-Expression. NEVER prints
# the installer body. NEVER writes the agent key to a log.
#
# Exit code contract:
#   0 = installer succeeded
#   1 = installer failed
#   2 = installer failed AND the test machine needs manual intervention
#   3 = wrapper precondition not met / operator cancellation

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$InstallerPath
)

$ErrorActionPreference = "Continue"

$OutDir = "C:\Users\Public\CharonAgentTest"
$null = New-Item -ItemType Directory -Force -Path $OutDir
$RunLog       = Join-Path $OutDir "installer-run.txt"
$ExitLog      = Join-Path $OutDir "installer-exit-code.txt"
$ShaLog       = Join-Path $OutDir "installer-sha256.txt"
$ParserLog    = Join-Path $OutDir "installer-parser-result.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) {
    $lines.Add($s) | Out-Null
}

$utcNow = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Line "NetManager Agent v2 - Installer wrapper"
Add-Line ("Generated UTC: " + $utcNow)
Add-Line ("Wrapper script: 02-run-installer.ps1")
Add-Line ("InstallerPath parameter: " + $InstallerPath)

function Write-Output-Files([int]$Code) {
    $buf = ($lines -join "`r`n") + "`r`n"
    $bom = [byte[]](0xEF, 0xBB, 0xBF)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($buf)
    [System.IO.File]::WriteAllBytes($RunLog + ".tmp", ($bom + $bytes))
    Move-Item -LiteralPath ($RunLog + ".tmp") -Destination $RunLog -Force
    [System.IO.File]::WriteAllText($ExitLog, $Code.ToString() + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

# -------------------------------------------------------------------
# Pre-condition: path resolution + existence
# -------------------------------------------------------------------
try {
    $resolved = Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop
    $InstallerPath = $resolved.Path
} catch {
    Add-Line "ERROR: Resolve-Path failed; installer file not found at the given path."
    Write-Output-Files 3
    Write-Host "Wrapper precondition failed (installer path missing)."
    exit 3
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    Add-Line "ERROR: The given path is not a file."
    Write-Output-Files 3
    exit 3
}
Add-Line ("Installer resolved to: " + $InstallerPath)

# -------------------------------------------------------------------
# SHA-256
# -------------------------------------------------------------------
try {
    $sha = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash
    Add-Line ("Installer SHA-256: " + $sha)
    $shaLine = $sha + "  " + (Split-Path -Leaf $InstallerPath) + "`r`n"
    [System.IO.File]::WriteAllText($ShaLog, $shaLine, (New-Object System.Text.UTF8Encoding($false)))
} catch {
    Add-Line ("ERROR: Get-FileHash failed: " + $_.Exception.GetType().FullName)
    Write-Output-Files 3
    exit 3
}

# -------------------------------------------------------------------
# Byte-level checks: BOM, double BOM, CRLF only, ASCII payload
# -------------------------------------------------------------------
$bytes = [System.IO.File]::ReadAllBytes($InstallerPath)
if ($bytes.Length -lt 64) {
    Add-Line "ERROR: Installer file is suspiciously small."
    Write-Output-Files 3
    exit 3
}
$bomOk = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$doubleBom = $false
if ($bytes.Length -ge 6) {
    $doubleBom = ($bytes[3] -eq 0xEF -and $bytes[4] -eq 0xBB -and $bytes[5] -eq 0xBF)
}
Add-Line ("BOM ok          : " + $bomOk)
Add-Line ("Double BOM      : " + $doubleBom)
if (-not $bomOk) {
    Add-Line "ERROR: First three bytes are not the UTF-8 BOM (EF BB BF)."
    Write-Output-Files 3
    exit 3
}
if ($doubleBom) {
    Add-Line "ERROR: Double BOM detected."
    Write-Output-Files 3
    exit 3
}

# Decode body (skip BOM) and check CRLF-only + ASCII-only
$text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
$crlfCount = ([regex]::Matches($text, "`r`n")).Count
$bareLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
Add-Line ("CRLF pairs       : " + $crlfCount)
Add-Line ("Bare LF          : " + $bareLf)
if ($bareLf -gt 0) {
    Add-Line "ERROR: Installer contains bare LF; not CRLF-only."
    Write-Output-Files 3
    exit 3
}
$nonAscii = 0
foreach ($c in $text.ToCharArray()) {
    if ([int][char]$c -gt 127) { $nonAscii++ }
}
Add-Line ("Non-ASCII chars  : " + $nonAscii)
if ($nonAscii -gt 0) {
    Add-Line "ERROR: Installer contains non-ASCII characters (cp1254 decode risk on tr-TR)."
    Write-Output-Files 3
    exit 3
}

# -------------------------------------------------------------------
# Forbidden / required pattern check (PRE-EXEC)
# -------------------------------------------------------------------
$forbidden = @(
    '\|\s*iex\b',
    '\|\s*Invoke-Expression\b',
    '\bsc\.exe\s+create\b',
    '\bsc\.exe\s+start\b',
    'IsInRole\("Administrator"\)'
)
$required = @(
    '\[Security\.Principal\.WindowsBuiltInRole\]::Administrator',
    'S-1-5-18',
    'S-1-5-32-544',
    'charon-agent-host',
    '--child-arg',
    'Get-FileHash',
    'Restore-PreviousAgentService'
)
$forbiddenHits = New-Object System.Collections.Generic.List[string]
foreach ($pat in $forbidden) {
    if ($text -match $pat) { $forbiddenHits.Add($pat) | Out-Null }
}
$missing = New-Object System.Collections.Generic.List[string]
foreach ($pat in $required) {
    if ($text -notmatch $pat) { $missing.Add($pat) | Out-Null }
}
Add-Line ""
Add-Line "Forbidden pattern hits:"
if ($forbiddenHits.Count -eq 0) {
    Add-Line "  (none)"
} else {
    foreach ($p in $forbiddenHits) { Add-Line ("  " + $p) }
}
Add-Line "Required pattern misses:"
if ($missing.Count -eq 0) {
    Add-Line "  (none)"
} else {
    foreach ($p in $missing) { Add-Line ("  " + $p) }
}
if ($forbiddenHits.Count -gt 0 -or $missing.Count -gt 0) {
    Add-Line "ERROR: Installer pattern contract failed; not executing."
    Write-Output-Files 3
    exit 3
}

# -------------------------------------------------------------------
# Parser gate (Windows PowerShell 5.1)
# -------------------------------------------------------------------
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    $InstallerPath, [ref]$tokens, [ref]$errors
)
$parserSummary = New-Object System.Collections.Generic.List[string]
if ($errors -and $errors.Count -gt 0) {
    foreach ($e in $errors) {
        $parserSummary.Add(("[ERR] " + $e.Message + " @ line " + $e.Extent.StartLineNumber)) | Out-Null
    }
} else {
    $parserSummary.Add("Parser errors: 0") | Out-Null
}
[System.IO.File]::WriteAllText(
    $ParserLog,
    ((($parserSummary -join "`r`n")) + "`r`n"),
    (New-Object System.Text.UTF8Encoding($false))
)
Add-Line ""
Add-Line "Parser result:"
foreach ($l in $parserSummary) { Add-Line ("  " + $l) }
if ($errors -and $errors.Count -gt 0) {
    Add-Line "ERROR: ParseFile reported errors; not executing."
    Write-Output-Files 3
    exit 3
}

# -------------------------------------------------------------------
# Self-elevation if we're not admin
# -------------------------------------------------------------------
$wp = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $wp.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
Add-Line ("Wrapper IsAdministrator: " + $isAdmin)

if (-not $isAdmin) {
    if ($env:CHARON_WRAPPER_ELEVATED -eq "1") {
        Add-Line "ERROR: Wrapper re-entered without elevation; bailing."
        Write-Output-Files 3
        exit 3
    }
    Add-Line "Wrapper is not elevated; relaunching elevated copy via UAC."
    $psExe = (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
    $childExit = 3
    $env:CHARON_WRAPPER_ELEVATED = "1"
    try {
        $proc = Start-Process -FilePath $psExe `
            -Verb RunAs `
            -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", ('"' + $PSCommandPath + '"'),
                "-InstallerPath", ('"' + $InstallerPath + '"')
            ) `
            -Wait -PassThru
        if ($proc -and ($proc.ExitCode -ne $null)) {
            $childExit = $proc.ExitCode
        }
    } catch {
        Add-Line "ERROR: UAC elevation request denied or failed."
        $childExit = 3
    }
    Add-Line ("Elevated child exit code: " + $childExit)
    Write-Output-Files $childExit
    exit $childExit
}

# -------------------------------------------------------------------
# Run installer via -File (NOT iex)
# -------------------------------------------------------------------
$psExe = (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe")
Add-Line ""
Add-Line ("Launching installer with: " + $psExe + " -NoProfile -ExecutionPolicy Bypass -File <installerPath>")
$installerExit = 1
try {
    $proc = Start-Process -FilePath $psExe `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", ('"' + $InstallerPath + '"')
        ) `
        -Wait -PassThru -NoNewWindow
    if ($proc -and ($proc.ExitCode -ne $null)) {
        $installerExit = $proc.ExitCode
    } else {
        $installerExit = 1
    }
} catch {
    Add-Line "ERROR: Could not launch the installer process."
    $installerExit = 1
}
Add-Line ("Installer exit code: " + $installerExit)
Write-Output-Files $installerExit

# Translate installer exit code through the wrapper contract:
#   installer 0   -> wrapper 0
#   installer 1   -> wrapper 1
#   installer 2   -> wrapper 2 (manual intervention; see installer code)
#   anything else -> wrapper 1
switch ($installerExit) {
    0 { exit 0 }
    1 { exit 1 }
    2 { exit 2 }
    default { exit 1 }
}
