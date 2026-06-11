"""WIN-INTEGRATE Windows installer invariants.

Pins the 9-stage installer contract:
  - architectural removals (sc.exe create/start/failure blocks)
  - locale-independent admin + ACL (WindowsBuiltInRole + SIDs)
  - PR #75 hardening carried forward (BOM/CRLF/charset/ASCII-safe)
  - Go host download + SHA verify section
  - charon-agent-host install/start/status CLI calls
  - 10s + 30s EXACT-MATCH "Running" status check
  - iwr | iex hard rejection ($PSCommandPath required)
  - Response wrapper headers (Content-Disposition, Cache-Control,
    nosniff, X-Content-Type-Options)
"""
import re


SAMPLE_AGENT_ID = "test-agent-abcd1234"
SAMPLE_AGENT_KEY = "test-key-9f8e7d6c"
SAMPLE_BACKEND_URL = "https://netmanager.example.app"


# Lazy import so collection of this test module does not eagerly
# instantiate app.core.database's SQLAlchemy engine (which fights
# SQLite + pool_size kwargs at conftest-set test URL).
def _gen() -> str:
    from app.api.v1.endpoints.agents import _windows_installer
    return _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


# ── Architectural removals — broken sc.exe patterns ────────────────────────


def test_no_sc_exe_create():
    """sc.exe create with binPath= Python is the broken pattern; it must
    not return in any form."""
    s = _gen()
    assert "sc.exe create" not in s, "Architectural regression: sc.exe create returned"


def test_no_sc_exe_start():
    s = _gen()
    assert "sc.exe start" not in s


def test_no_sc_exe_failure():
    s = _gen()
    assert "sc.exe failure" not in s


def test_no_pause_cmdlet():
    s = _gen()
    executable_lines = [l for l in s.split("\n")
                        if not l.strip().startswith("#") and l.strip()]
    pause_lines = [l for l in executable_lines
                   if re.search(r"^\s*pause\s*(;|$)", l)]
    assert not pause_lines, f"pause cmdlet leaked: {pause_lines}"
    assert "Read-Host" in s


# ── ASCII-safe + smart-quote/emoji guard ───────────────────────────────────


def test_no_non_ascii_in_executable_script():
    s = _gen()
    non_ascii = sorted({c for c in s if ord(c) > 127})
    assert non_ascii == [], (
        f"non-ASCII in executable: {[(c, hex(ord(c))) for c in non_ascii]}"
    )


def test_no_smart_quotes_or_emoji():
    s = _gen()
    forbidden = ['—', '–', '‘', '’', '“', '”',
                 '✓', '✗', '⚠', '✅']
    for ch in forbidden:
        assert ch not in s, f"Forbidden character: {ch!r} (U+{ord(ch):04X})"


# ── PS 7-only syntax must stay out ─────────────────────────────────────────


def test_no_null_conditional_operator():
    s = _gen()
    matches = re.findall(r'[\w\)\]]\?\.', s)
    assert matches == []


def test_no_null_coalescing_operator():
    s = _gen()
    assert "??" not in s


def test_no_foreach_parallel():
    s = _gen()
    assert "-Parallel" not in s


# ── Locale-independent admin check ─────────────────────────────────────────


def test_admin_check_uses_built_in_role_enum():
    s = _gen()
    assert "[Security.Principal.WindowsBuiltInRole]::Administrator" in s


def test_no_hardcoded_administrator_isinrole_string():
    s = _gen()
    assert 'IsInRole("Administrator")' not in s
    assert "IsInRole('Administrator')" not in s


# ── Self-elevation + iwr|iex rejection ─────────────────────────────────────


def test_self_elevation_recursion_guard():
    s = _gen()
    assert "NETMANAGER_INSTALLER_ELEVATED" in s
    assert "Start-Process" in s
    assert "-Verb RunAs" in s


def test_psc_command_path_required_for_self_elevation():
    """iwr | iex pipeline leaves $PSCommandPath empty, so self-
    elevation would silently fail. Installer must reject that path."""
    s = _gen()
    assert "$PSCommandPath" in s
    assert "iwr | iex" in s or "iwr|iex" in s, "iwr|iex must be mentioned for user diagnostics"


def test_no_inline_iwr_pipe_iex_installer_call():
    """The installer must not be authored in a way that requires a
    pipeline-execution boot path. (We allow `iwr | iex` to appear in
    a diagnostic STRING; we do NOT allow it as actual installer code.)"""
    s = _gen()
    # The phrase `iwr | iex unsupported` is fine (diagnostic);
    # the actual pattern `iwr <url> | iex` as an executable command must not appear.
    forbidden_patterns = [
        r"Invoke-WebRequest\s+[^\n]+\|\s*Invoke-Expression",
        r"\biwr\s+[^|]*\|\s*iex\b",
    ]
    for pat in forbidden_patterns:
        m = re.search(pat, s)
        # Reject only when the pattern is on an executable line
        if m:
            # Walk back to start of line and check leading non-comment
            start = s.rfind("\n", 0, m.start()) + 1
            line = s[start:m.end()]
            assert line.lstrip().startswith("#"), \
                f"installer contains executable iwr|iex pipeline: {line!r}"


# ── SID-based ACL (locale-independent) ─────────────────────────────────────


def test_sid_based_acl_system():
    s = _gen()
    assert "S-1-5-18" in s, "SYSTEM SID missing"


def test_sid_based_acl_administrators():
    s = _gen()
    assert "S-1-5-32-544" in s, "Administrators SID missing"


def test_no_localized_acl_strings_in_executable_code():
    """Localized account names like BUILTIN\\Administrators fail in TR
    Windows where the group is called Yoneticiler. Use SIDs instead.

    Only EXECUTABLE lines are inspected — the comment block that
    documents what the SIDs are still mentions the localized names
    for human readers, which is fine."""
    s = _gen()
    executable = "\n".join(
        l for l in s.split("\n")
        if not l.lstrip().startswith("#")
    )
    assert r"BUILTIN\Administrators" not in executable
    assert r"NT AUTHORITY\SYSTEM" not in executable


def test_acl_inheritance_disabled():
    s = _gen()
    assert "SetAccessRuleProtection" in s


def test_acl_failure_is_fail_closed():
    """ACL hardening failure must abort the installer BEFORE config.env
    is written. The catch block must exit 1 — no warning + continue."""
    s = _gen()
    match = re.search(
        r"Set-Acl \$InstallDir \$acl[\s\S]+?\}\s*catch\s*\{([\s\S]+?)\n\s*\}\s*\n",
        s,
    )
    assert match, "ACL try/catch block not found"
    catch_body = match.group(1)
    assert "exit 1" in catch_body, \
        f"ACL catch body must exit 1, got: {catch_body!r}"
    assert "[ERROR]" in catch_body, \
        "ACL catch body must surface a user-facing [ERROR] line"
    # No warning-and-continue path
    assert "[WARNING] ACL hardening failed" not in catch_body, \
        "ACL catch must NOT log warning + continue"


def test_acl_catch_does_not_echo_raw_exception_to_user():
    """The post-CI review explicitly bans echoing the localized raw
    exception message to the user (could leak 'Yoneticiler' or other
    locale-specific account names). Technical detail belongs in an
    internal log file, not Write-Host."""
    s = _gen()
    match = re.search(
        r"Set-Acl \$InstallDir \$acl[\s\S]+?\}\s*catch\s*\{([\s\S]+?)\n\s*\}\s*\n",
        s,
    )
    assert match
    catch_body = match.group(1)
    # Forbid raw exception interpolation into the console
    assert "$($_.Exception.Message)" not in catch_body, \
        "ACL catch must not echo raw $_.Exception.Message to console"
    assert "$AgentKey" not in catch_body
    assert "$AgentId" not in catch_body


# ── BOM-less config + run wrapper ──────────────────────────────────────────


def test_config_uses_writeAllText_no_bom():
    s = _gen()
    assert "[System.IO.File]::WriteAllText" in s
    assert "System.Text.UTF8Encoding($false)" in s


def test_no_out_file_utf8_for_config():
    s = _gen()
    bad = re.search(
        r"Out-File\s+-FilePath\s+[^|]*config\.env[^|]*-Encoding\s+UTF8(?!NoBom)",
        s,
    )
    assert bad is None


# ── Stages 6–7: Go host binary download + SHA verify ───────────────────────


def test_host_binary_download_section_present():
    s = _gen()
    assert "/download/host/windows-amd64" in s
    assert "X-Host-SHA256" in s
    assert "Get-FileHash" in s


def test_host_binary_downloads_to_staging_not_final():
    """P0 #1: Direct -OutFile to $HostExe would refuse on Windows
    file-lock if the existing service has the binary open, AND
    a download/SHA failure would destroy the previous working
    binary. Force staging download path."""
    s = _gen()
    assert "$HostStage" in s
    assert "charon-agent-host.exe.new" in s
    assert "-OutFile $HostStage" in s
    # The forbidden direct-overwrite must not appear:
    assert "-OutFile $HostExe" not in s, \
        "host download must target $HostStage, never $HostExe directly"


def test_sha_check_runs_on_stage_file():
    s = _gen()
    assert "Get-FileHash -LiteralPath $HostStage" in s
    # Mismatch must clean only the stage, never touch $HostExe
    assert "Remove-Item -LiteralPath $HostStage" in s
    # Sequence: integrity-fail message followed by stage-remove,
    # NOT followed by $HostExe removal
    fail_window = re.search(
        r"integrity check failed[\s\S]{0,400}",
        s,
    )
    assert fail_window is not None
    assert "Remove-Item -LiteralPath $HostExe" not in fail_window.group(0), \
        "SHA mismatch path must not delete $HostExe"


def test_atomic_move_stage_to_final():
    s = _gen()
    assert "Move-Item -LiteralPath $HostStage -Destination $HostExe -Force" in s


def test_existing_host_backed_up_before_replace():
    """The previous host binary is moved to $HostBackup before the
    staged binary takes its place — that backup enables rollback in
    [9/9] if 10s/30s status fails."""
    s = _gen()
    assert "$HostBackup" in s
    assert "charon-agent-host.exe.bak" in s
    assert "Move-Item -LiteralPath $HostExe -Destination $HostBackup -Force" in s


def test_rollback_on_install_or_status_failure():
    """install / start / 10s status / 30s status — any failure
    AFTER the move must roll the .bak back into place."""
    s = _gen()
    assert "$rollbackAvailable" in s
    # rollback move appears multiple times (install/start/10s/30s)
    rollback_moves = s.count(
        "Move-Item -LiteralPath $HostBackup -Destination $HostExe -Force"
    )
    assert rollback_moves >= 4, \
        f"expected ≥4 rollback move sites (install/start/10s/30s), got {rollback_moves}"


def test_no_remove_item_on_host_exe_direct():
    """Old fail pattern: Remove-Item $HostExe -Force on SHA failure
    would destroy the working binary. The new path only ever
    removes $HostStage, $HostBackup, or moves $HostBackup → $HostExe."""
    s = _gen()
    bad = re.search(r"Remove-Item\s+-?[A-Za-z]*\s*\$HostExe\b", s)
    assert bad is None, \
        f"forbidden Remove-Item against $HostExe: {bad.group(0)!r}"


def test_host_binary_url_built_from_agent_id():
    s = _gen()
    assert "/api/v1/agents/$AgentId/download/host/windows-amd64" in s


def test_agent_key_in_host_download_header_not_url():
    s = _gen()
    assert '"X-Agent-Key" = $AgentKey' in s
    bad_url_pat = re.search(r"download/host[^\"\n]*\?[^\"\n]*agent_key=", s)
    assert bad_url_pat is None, f"agent_key in URL: {bad_url_pat.group(0)}"


# ── Stage 8: Go host CLI install/start (PR #76 contract) ───────────────────


def test_host_install_command_contract():
    s = _gen()
    # The host CLI flag set (from PR #76 main: cli/flags.go)
    for flag in (
        "--service-name",
        "--display-name",
        "--description",
        "--child-exe",
        "--child-arg",
        "--work-dir",
        "--env-file",
        "--log-dir",
        '--service-account "LocalSystem"',
    ):
        assert flag in s, f"host install flag missing: {flag}"


def test_host_start_command():
    s = _gen()
    assert "& $HostExe start --service-name $ServiceName" in s


# ── Reinstall race: uninstall exit-code handling + bounded poll ───────────


def test_uninstall_exit_codes_are_checked():
    """The pre-install uninstall step MUST distinguish exit codes per
    the Go host CLI contract:
        0  → fully cleaned up
        18 → ErrServiceNotFound (already gone — benign)
        19 → ErrDeletePending (poll until cleared)
        other → hard fail
    The previous `& $HostExe uninstall | Out-Null; Start-Sleep 2`
    pattern is forbidden — the sleep was a guess and PR #76 already
    saw an SCM cleanup race in that window."""
    s = _gen()
    # uninstall exit code captured + each contract code handled
    assert "$uninstallExit = $LASTEXITCODE" in s
    assert "$uninstallExit -eq 0" in s
    assert "$uninstallExit -eq 18" in s
    assert "$uninstallExit -eq 19" in s
    # Fall-through must abort (no silent continue)
    assert "[ERROR] Previous service uninstall failed" in s


def test_uninstall_bounded_poll_replaces_fixed_sleep():
    """Replace the static `Start-Sleep -Seconds 2` race with a
    bounded poll that exits as soon as `status` reports
    ErrServiceNotFound (exit 18). Ceiling at 30s."""
    s = _gen()
    assert "& $HostExe status --service-name $ServiceName" in s
    assert "$LASTEXITCODE -eq 18" in s
    # Loop must have a deadline
    assert "AddSeconds(30)" in s
    # Forbid the immediate post-uninstall Start-Sleep 2 race
    bad = re.search(
        r"& \$HostExe uninstall[^\n]*\n[^\n]*Start-Sleep\s+-Seconds\s+2(?!\d)",
        s,
    )
    assert bad is None, \
        f"old fixed-sleep race pattern still present near uninstall: {bad.group(0)!r}"


def test_uninstall_poll_failure_aborts():
    """If the bounded poll exhausts its deadline without seeing
    ErrServiceNotFound, the installer must abort with a clear
    message rather than silently proceeding."""
    s = _gen()
    assert "Previous service registration did not clear within 30s" in s


def test_host_install_exit_code_check():
    """install / start / status@10s / status@30s must each guard on
    exit code 0."""
    s = _gen()
    # pip install + host install + host start = 3 mandatory guards;
    # the 10s + 30s status checks combine $statusExit -ne 0 with the
    # exact-match Running test in a single if. So we expect at least 3
    # bare LASTEXITCODE guards plus the two `$exitN -ne 0` paths
    # accumulated.
    bare_guards = s.count("if ($LASTEXITCODE -ne 0)")
    exit_guards = s.count("$exit10 -ne 0") + s.count("$exit30 -ne 0")
    assert bare_guards + exit_guards >= 5, (
        f"expected at least 5 exit-code guards in installer body, "
        f"got bare={bare_guards} exit={exit_guards}"
    )


# ── Stage 9: 10s + 30s exact-match Running check ───────────────────────────


def test_status_check_10s():
    s = _gen()
    assert "Start-Sleep -Seconds 10" in s


def test_status_check_30s_total():
    s = _gen()
    assert "Start-Sleep -Seconds 20" in s


def test_status_exact_match_no_regex():
    """User explicit requirement: -ne 'Running' EXACT match; -match
    'Running' would false-positive NotRunning / RunningWithError."""
    s = _gen()
    assert "$status10 -ne \"Running\"" in s
    assert "$status30 -ne \"Running\"" in s
    # Also belt-and-suspenders: must AND with $statusExit -ne 0
    assert "$exit10 -ne 0" in s
    assert "$exit30 -ne 0" in s


def test_no_match_running_regex():
    s = _gen()
    assert '-match "Running"' not in s
    assert "-match 'Running'" not in s


# ── TLS 1.2 + installer cleanup ────────────────────────────────────────────


def test_tls_12_enforced():
    s = _gen()
    assert "[Net.ServicePointManager]::SecurityProtocol" in s
    assert "Tls12" in s


def test_installer_self_cleanup_uses_literal_path():
    """P0 #2: -LiteralPath is required so a path containing PowerShell
    wildcard chars (`[`, `]`, `?`, `*`) cannot accidentally expand and
    delete other files."""
    s = _gen()
    assert "Remove-Item -LiteralPath $PSCommandPath" in s


def test_all_path_cleanup_via_try_finally():
    """P0 #2: The elevated execution body MUST be wrapped in a
    try { ... } finally { cleanup } so the installer file (which
    embeds the agent key in its header) is removed regardless of
    success, ACL fail, download fail, SHA fail, install fail or
    status fail."""
    s = _gen()
    # The body opens with a top-level `try {{` and the matching
    # `finally {{` lives near the end.
    assert "try {" in s
    assert "finally {" in s
    # Mirror invariants from the elevated body to the finally:
    finally_idx = s.rfind("finally {")
    assert finally_idx > 0
    finally_tail = s[finally_idx:]
    assert "$AgentKey = $null" in finally_tail
    assert "Remove-Item -LiteralPath $PSCommandPath" in finally_tail


def test_agent_key_zeroed_in_finally():
    """Defensive: zero the in-memory $AgentKey before exit so a
    crash dump cannot recover it."""
    s = _gen()
    finally_idx = s.rfind("finally {")
    assert finally_idx > 0
    assert "$AgentKey = $null" in s[finally_idx:]


def test_self_elevation_parent_waits_for_child():
    """P0 #2 corollary: the non-admin parent process MUST Wait for
    the elevated child to finish before cleaning the installer.
    Otherwise the parent races the child's open-file handle and
    cleanup fails — leaving the agent-key-bearing installer on disk."""
    s = _gen()
    assert "Start-Process" in s
    assert "-Wait" in s
    assert "-PassThru" in s
    # Parent must capture ExitCode
    assert "$proc.ExitCode" in s


def test_self_elevation_parent_cleans_on_uac_failure():
    """If UAC is denied or Start-Process throws, the parent must
    STILL remove the installer (its own header contains the agent
    key as a single-quoted literal)."""
    s = _gen()
    # The parent block has its own try/catch/finally pair around
    # Start-Process; the finally must contain the cleanup.
    parent_block = re.search(
        r"if \(-not \$isAdmin\) \{[\s\S]+?exit \$childExit\s*\}",
        s,
    )
    assert parent_block is not None, "self-elevation parent block not found"
    body = parent_block.group(0)
    # Inside parent's finally
    assert "finally" in body
    assert "Remove-Item -LiteralPath $PSCommandPath" in body


# ── Agent key never in command line / log ──────────────────────────────────


def test_agent_key_never_in_writehost():
    s = _gen()
    for forbidden in (
        "Write-Host $AgentKey",
        "Write-Host \"$AgentKey",
        "Write-Output $AgentKey",
    ):
        assert forbidden not in s


def test_agent_key_not_in_filename():
    s = _gen()
    # filename references must not interpolate agent key
    bad = re.search(r'filename="[^"]*\$AgentKey[^"]*"', s)
    assert bad is None


# ── Single-quote escape (F1.3 defense) ─────────────────────────────────────


def test_quote_injection_escaped():
    from app.api.v1.endpoints.agents import _windows_installer
    out = _windows_installer("evil'agent", "key'with'quote", "https://x")
    assert "$AgentId    = 'evil''agent'" in out
    assert "$AgentKey   = 'key''with''quote'" in out
