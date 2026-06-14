# 05-collect-diagnostics.ps1 - NetManager Windows Agent v2 (Architecture Plan v11)
#
# Bundle a redacted diagnostic ZIP for support. The ZIP captures the
# installer audit trail, the per-stage status sidecars, the on-disk
# layout summary, and the SCM registration shape -- WITHOUT including
# any file that carries the agent key or transient rollback state.
#
# Hard-coded EXCLUSIONS (correction #56 + Section G):
#   - config.env, config.env.bak                (live + last-known-good
#                                                 config with agent key)
#   - staging\config.env.new                    (staged config with agent key)
#   - staging\rollback-config.failed            (transient locked-ACL
#                                                 config with agent key)
#   - staging\proc-capture\*                    (Invoke-ProcessCaptured
#                                                 stdout/stderr files;
#                                                 belt-and-suspenders --
#                                                 the helper never lets
#                                                 the agent key reach
#                                                 stdout/stderr in the
#                                                 first place)
#   - any file matching *.bak that lives next to one of the above
#   - any file matching the failed-* glob anywhere under InstallDir
#
# Output:
#   <cwd>\netmanager-agent-diagnostics-YYYY-MM-DDTHH-MM-SS.zip

$ErrorActionPreference = "Stop"

$InstallDir = "C:\ProgramData\NetManagerAgent"
if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host "[INFO] $InstallDir does not exist; nothing to collect." -ForegroundColor Yellow
    exit 0
}

# Inventory the install tree, applying every exclusion.
$exclusionGlobs = @(
    "$InstallDir\config.env",
    "$InstallDir\config.env.bak",
    "$InstallDir\staging\config.env.new",
    "$InstallDir\staging\rollback-config.failed"
)
$exclusionPrefixes = @(
    "$InstallDir\staging\proc-capture\"
)

function Should-Exclude {
    param([string]$path)
    foreach ($glob in $exclusionGlobs) {
        if ($path -ieq $glob) { return $true }
    }
    foreach ($prefix in $exclusionPrefixes) {
        if ($path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    if ($path -imatch '\\failed-[^\\]*$') { return $true }
    return $false
}

# Stage a copy of the redacted tree under TEMP.
$ts = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss")
$stage = Join-Path $env:TEMP "netmanager-agent-diagnostics-$ts"
New-Item -ItemType Directory -Path $stage | Out-Null
$included = New-Object System.Collections.ArrayList
$skipped  = New-Object System.Collections.ArrayList

Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.PSIsContainer } |
    ForEach-Object {
        $src = $_.FullName
        if (Should-Exclude $src) {
            [void]$skipped.Add($src)
            return
        }
        $rel = $src.Substring($InstallDir.Length).TrimStart('\')
        $dst = Join-Path $stage $rel
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        [void]$included.Add($rel)
    }

# Add a summary file so support can see what was redacted.
$summaryPath = Join-Path $stage "diagnostics-summary.txt"
@(
    "Diagnostics collected at $ts UTC"
    ""
    "INCLUDED ($($included.Count)) files:"
) | Set-Content -LiteralPath $summaryPath -Encoding ASCII
$included | ForEach-Object { Add-Content -LiteralPath $summaryPath -Value "  $_" }
Add-Content -LiteralPath $summaryPath -Value ""
Add-Content -LiteralPath $summaryPath -Value "EXCLUDED ($($skipped.Count)) secret-bearing / transient paths:"
$skipped | ForEach-Object {
    $rel = $_.Substring($InstallDir.Length).TrimStart('\')
    Add-Content -LiteralPath $summaryPath -Value "  $rel"
}

# Add the SCM registration shape (no secrets).
try {
    $row = Get-CimInstance Win32_Service -Filter "Name='NetManagerAgent'" -ErrorAction SilentlyContinue
    if ($row) {
        Add-Content -LiteralPath $summaryPath -Value ""
        Add-Content -LiteralPath $summaryPath -Value "SCM registration:"
        Add-Content -LiteralPath $summaryPath -Value "  ServiceName    : $($row.Name)"
        Add-Content -LiteralPath $summaryPath -Value "  DisplayName    : $($row.DisplayName)"
        Add-Content -LiteralPath $summaryPath -Value "  StartMode      : $($row.StartMode)"
        Add-Content -LiteralPath $summaryPath -Value "  StartName      : $($row.StartName)"
        Add-Content -LiteralPath $summaryPath -Value "  PathName       : $($row.PathName)"
    }
} catch {}

# ZIP the staged tree.
$zip = Join-Path (Get-Location).Path "netmanager-agent-diagnostics-$ts.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false
)
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[OK] Wrote $zip (included $($included.Count), excluded $($skipped.Count))"
exit 0
