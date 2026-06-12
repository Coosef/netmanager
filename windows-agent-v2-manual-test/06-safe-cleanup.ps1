# NetManager / Charon -- safe cleanup
#
# Default behaviour: NO-OP, prints what each flag would do.
#
# Flags (each one requires an explicit typed confirmation):
#   -CleanupDiagnostics     Remove C:\Users\Public\CharonAgentTest only.
#   -UninstallAgent         Stop + remove the NetManagerAgent Windows
#                           service ONLY. Files on disk are kept.
#                           Operator must type: UNINSTALL-NETMANAGER-AGENT
#   -RemoveAgentFiles       Remove C:\ProgramData\NetManagerAgent.
#                           Requires -UninstallAgent.
#                           Operator must type: DELETE-AGENT-FILES
#
# NEVER uses wildcard deletes. Always -LiteralPath, always to a
# specific known directory.
#
# Exit code:
#   0 = all requested actions performed cleanly
#   1 = an action failed
#   3 = operator did not confirm OR no flags given (no-op)

[CmdletBinding()]
param(
    [switch]$CleanupDiagnostics,
    [switch]$UninstallAgent,
    [switch]$RemoveAgentFiles
)

$ErrorActionPreference = "Continue"

$DiagDir    = "C:\Users\Public\CharonAgentTest"
$InstallDir = "C:\ProgramData\NetManagerAgent"

Write-Host "NetManager Agent v2 - safe-cleanup wrapper"
Write-Host ""

if (-not $CleanupDiagnostics -and -not $UninstallAgent -and -not $RemoveAgentFiles) {
    Write-Host "No flags given. This script performs nothing by default."
    Write-Host "Available actions (each requires a typed confirmation):"
    Write-Host "  -CleanupDiagnostics  delete C:\Users\Public\CharonAgentTest"
    Write-Host "  -UninstallAgent      stop and remove the NetManagerAgent service only"
    Write-Host "  -RemoveAgentFiles    delete C:\ProgramData\NetManagerAgent (requires -UninstallAgent)"
    exit 3
}

if ($RemoveAgentFiles -and -not $UninstallAgent) {
    Write-Host "ERROR: -RemoveAgentFiles requires -UninstallAgent."
    exit 3
}

# Admin check for any action other than CleanupDiagnostics
$wp = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $wp.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (($UninstallAgent -or $RemoveAgentFiles) -and -not $isAdmin) {
    Write-Host "ERROR: -UninstallAgent / -RemoveAgentFiles require elevated PowerShell."
    exit 3
}

$failed = $false

# -------------------------------------------------------------------
# -CleanupDiagnostics
# -------------------------------------------------------------------
if ($CleanupDiagnostics) {
    Write-Host ("This will permanently remove: " + $DiagDir)
    $confirm = Read-Host "Type DELETE to confirm"
    if ($confirm -ne "DELETE") {
        Write-Host "Aborted (did not type DELETE)."
    } else {
        if (Test-Path -LiteralPath $DiagDir) {
            try {
                Remove-Item -LiteralPath $DiagDir -Recurse -Force -ErrorAction Stop
                Write-Host ("Removed: " + $DiagDir)
            } catch {
                Write-Host ("Failed to remove " + $DiagDir)
                $failed = $true
            }
        } else {
            Write-Host ("Already absent: " + $DiagDir)
        }
    }
}

# -------------------------------------------------------------------
# -UninstallAgent
# -------------------------------------------------------------------
if ($UninstallAgent) {
    Write-Host ""
    Write-Host "This will stop and remove the NetManagerAgent Windows service."
    Write-Host "Files under C:\ProgramData\NetManagerAgent will be kept unless"
    Write-Host "-RemoveAgentFiles was also passed."
    $confirm = Read-Host "Type UNINSTALL-NETMANAGER-AGENT to confirm"
    if ($confirm -ne "UNINSTALL-NETMANAGER-AGENT") {
        Write-Host "Aborted (did not type UNINSTALL-NETMANAGER-AGENT)."
        exit 3
    }

    # Prefer the host binary's own uninstall subcommand (Charon contract)
    $hostExe = Join-Path $InstallDir "bin\charon-agent-host.exe"
    $uninstallOk = $false

    if (Test-Path -LiteralPath $hostExe) {
        try {
            Write-Host ("Running: " + $hostExe + " uninstall")
            $proc = Start-Process -FilePath $hostExe -ArgumentList @("uninstall") -Wait -PassThru -NoNewWindow
            Write-Host ("Host uninstall exit code: " + $proc.ExitCode)
            if ($proc.ExitCode -eq 0) { $uninstallOk = $true }
        } catch {
            Write-Host "Host binary uninstall subcommand failed; falling back to SCM."
        }
    } else {
        Write-Host "Host binary missing; falling back to SCM."
    }

    if (-not $uninstallOk) {
        # SCM fallback via Stop-Service + sc.exe delete
        # NOTE: sc.exe delete is allowed; sc.exe create / sc.exe start are NOT used
        $svc = Get-Service -Name "NetManagerAgent" -ErrorAction SilentlyContinue
        if ($svc) {
            try {
                if ($svc.Status -ne "Stopped") {
                    Stop-Service -Name "NetManagerAgent" -Force -ErrorAction Stop
                    $deadline = (Get-Date).AddSeconds(30)
                    while ($svc.Status -ne "Stopped" -and (Get-Date) -lt $deadline) {
                        Start-Sleep -Seconds 1
                        $svc.Refresh()
                    }
                }
            } catch {
                Write-Host "Stop-Service failed."
                $failed = $true
            }
            $scExe = Join-Path $env:SystemRoot "System32\sc.exe"
            try {
                $proc = Start-Process -FilePath $scExe -ArgumentList @("delete","NetManagerAgent") -Wait -PassThru -NoNewWindow
                Write-Host ("sc.exe delete exit code: " + $proc.ExitCode)
                if ($proc.ExitCode -ne 0) { $failed = $true }
            } catch {
                Write-Host "sc.exe delete failed."
                $failed = $true
            }
        } else {
            Write-Host "NetManagerAgent service was already absent."
        }
    }
}

# -------------------------------------------------------------------
# -RemoveAgentFiles
# -------------------------------------------------------------------
if ($RemoveAgentFiles) {
    Write-Host ""
    Write-Host ("This will permanently remove: " + $InstallDir)
    Write-Host "All logs, backups (.bak), and the config.env will be deleted."
    $confirm = Read-Host "Type DELETE-AGENT-FILES to confirm"
    if ($confirm -ne "DELETE-AGENT-FILES") {
        Write-Host "Aborted (did not type DELETE-AGENT-FILES)."
    } else {
        if (Test-Path -LiteralPath $InstallDir) {
            try {
                Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
                Write-Host ("Removed: " + $InstallDir)
            } catch {
                Write-Host ("Failed to remove " + $InstallDir)
                $failed = $true
            }
        } else {
            Write-Host ("Already absent: " + $InstallDir)
        }
    }
}

if ($failed) { exit 1 } else { exit 0 }
