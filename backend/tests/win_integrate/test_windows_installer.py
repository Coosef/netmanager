"""WIN-INTEGRATE Windows installer invariants — Section H 11-stage.

Pins the v2 installer contract emitted by `_windows_installer()`:

  - 11-stage flow ([1/11] .. [11/11]) with the correct stage 2B
    transaction recovery preflight + four-probe SCM agreement +
    canonically-restorable registration gate (corrections #70 + #71)
  - Stage 6B private-runtime sanity-fire with byte-exact RUNTIME_OK
    (correction #46)
  - Stage 9A A0 pre-quiesce process snapshot using PID + path +
    creation-time triple (correction #72)
  - Stage 9B M1..M6 atomic-swap file-move ledger (correction #41)
  - Stage 10 structured `Invoke-HostInstall` reading `.ExitCode` —
    bare `& $HostExe install ; $LASTEXITCODE` pipeline pollution is
    forbidden (corrections #58 + #66)
  - Stage 11.A/B/C/D commit barrier: SCM registration semantic
    equivalence verified BEFORE backups are LOGICAL_DELETEd
    (correction #69)
  - Rollback paths: three terminal modes
    (SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING /
    SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED /
    SUCCESSFUL_CLEAN_INSTALL_ROLLBACK) + ROLLBACK_INCOMPLETE /
    MANUAL INTERVENTION REQUIRED exit 2 (correction #67)
  - PR #1 / PR #2 invariants carried forward:
      * locale-independent admin + SIDs
      * iwr | iex hard rejection
      * Linux byte-equal golden still applies (verified separately)
      * Runtime endpoints downloaded from `/download/runtime/...`
        added in PR #2
      * Host endpoint at `/download/host/windows-amd64` reused

Forbidden patterns (must NEVER appear in executable code):

  - `Start-Service`, `Stop-Service` (Section H uses host-CLI start/stop)
  - `sc.exe create` / `sc.exe delete` / `sc.exe failure`
  - `Expand-Archive` (Section F requires native ZipFile.OpenRead)
  - `Invoke-Expression` / `iwr | iex` on an executable line
  - `winget install` / `pip install` (private runtime is preinstalled)
  - `Get-Command python` (no system Python lookup)
  - `$env:Path +=` (no PATH mutation)
  - `SECURELY DELETE` / `secure erase` (the doctrine is LOGICAL_DELETE)
  - Bare `& $HostExe install` followed by `$LASTEXITCODE` (stdout
    pollution; install MUST go through `Invoke-HostInstall`)
"""
import re

import pytest


SAMPLE_AGENT_ID = "test-agent-abcd1234"
SAMPLE_AGENT_KEY = "test-key-9f8e7d6c"
SAMPLE_BACKEND_URL = "https://netmanager.example.app"


def _gen() -> str:
    from app.api.v1.endpoints.agents import _windows_installer
    return _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


def _executable_only(s: str) -> str:
    """Strip lines whose first non-whitespace char is `#` (PS comment)."""
    return "\n".join(l for l in s.split("\n") if not l.lstrip().startswith("#"))


# ── Architectural removals (legacy 9-stage + system-Python death) ─────────


def test_no_sc_exe_create():
    s = _gen()
    assert "sc.exe create" not in s


def test_no_sc_exe_start():
    s = _gen()
    assert "sc.exe start" not in s


def test_stage_10_start_validates_stdout_and_stderr():
    """PR #3 fast-follow: the [10/11] start invocation must validate the start CLI
    contract symmetrically with install/status (exact stdout + empty stderr), not
    exit-code-only. A start returning exit 0 with corrupt stdout / non-empty stderr
    must be rejected at the contract gate, not silently accepted."""
    s = _executable_only(_gen())
    assert '"start","--service-name"' in s                       # the start call
    assert "$startResult.Stdout.TrimEnd" in s                    # stdout captured + trimmed
    assert 'Start signal sent to "NetManagerAgent".' in s        # exact stdout contract (code 0)
    assert "$startResult.Stderr.Length -gt 0" in s               # stderr emptiness gate


def test_no_sc_exe_delete():
    s = _gen()
    assert "sc.exe delete" not in s


def test_no_sc_exe_failure():
    s = _gen()
    assert "sc.exe failure" not in s


def test_no_start_service_cmdlet_in_executable():
    s = _executable_only(_gen())
    assert "Start-Service" not in s, \
        "Section H uses charon-agent-host start; Start-Service forbidden"


def test_no_stop_service_cmdlet_in_executable():
    s = _executable_only(_gen())
    assert "Stop-Service" not in s, \
        "Section H uses charon-agent-host stop; Stop-Service forbidden"


def test_no_pause_cmdlet():
    s = _gen()
    executable = [l for l in s.split("\n")
                  if not l.strip().startswith("#") and l.strip()]
    pause_lines = [l for l in executable if re.search(r"^\s*pause\s*(;|$)", l)]
    assert not pause_lines
    assert "Read-Host" in s


def test_no_expand_archive():
    """Section F explicitly forbids `Expand-Archive` — it does not
    enforce per-entry namespace safety. Use ZipFile.OpenRead directly."""
    s = _executable_only(_gen())
    assert "Expand-Archive" not in s


def test_no_winget_install():
    """Private runtime is preinstalled. No third-party package fetch."""
    s = _executable_only(_gen())
    assert "winget install" not in s


def test_no_pip_install_in_executable():
    """Private runtime ships wheels pre-installed via offline `pip
    install --target` at build time. The installer must never call
    pip at runtime."""
    s = _executable_only(_gen())
    assert not re.search(r"\bpip\s+install\b", s), \
        "pip install must not appear in executable installer code"


def test_no_get_command_python():
    """No system-Python lookup — Section H runs the embedded
    `payload\\current\\runtime\\python\\python.exe` exclusively."""
    s = _executable_only(_gen())
    assert not re.search(r"\bGet-Command\s+python\b", s)


def test_no_path_env_mutation():
    s = _executable_only(_gen())
    assert not re.search(r"\$env:Path\s*\+=", s)


def test_no_microsoft_store_python_branch():
    """The Store-stub probe was for system Python; gone in v2."""
    s = _executable_only(_gen())
    assert "Microsoft Store stub detected" not in s
    assert "WindowsApps" not in s


def test_no_securely_delete_doctrine():
    """Section H + correction #57 use LOGICAL_DELETE (force-delete +
    non-existence verification). `SECURELY DELETE` / `secure erase`
    have specific filesystem-overwrite implications that we do NOT
    promise."""
    s = _gen()
    assert "SECURELY DELETE" not in s
    assert not re.search(r"secure\s*[- ]?\s*erase", s, re.IGNORECASE)


# ── ASCII-safe + smart-quote/emoji guard ──────────────────────────────────


def test_no_non_ascii_in_executable_script():
    s = _gen()
    non_ascii = sorted({c for c in s if ord(c) > 127})
    assert non_ascii == [], \
        f"non-ASCII in executable: {[(c, hex(ord(c))) for c in non_ascii]}"


def test_no_smart_quotes_or_emoji():
    s = _gen()
    forbidden = ['—', '–', '‘', '’', '“', '”',
                 '✓', '✗', '⚠', '✅']
    for ch in forbidden:
        assert ch not in s, f"Forbidden char: {ch!r} (U+{ord(ch):04X})"


# ── PS 7-only syntax must stay out ────────────────────────────────────────


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


# ── Locale-independent admin + SIDs (carried from PR #1) ──────────────────


def test_admin_check_uses_built_in_role_enum():
    s = _gen()
    assert "[Security.Principal.WindowsBuiltInRole]::Administrator" in s


def test_no_hardcoded_administrator_isinrole_string():
    s = _gen()
    assert 'IsInRole("Administrator")' not in s
    assert "IsInRole('Administrator')" not in s


def test_sid_based_acl_system():
    s = _gen()
    assert "S-1-5-18" in s, "SYSTEM SID missing"


def test_sid_based_acl_administrators():
    s = _gen()
    assert "S-1-5-32-544" in s, "Administrators SID missing"


def test_no_localized_acl_strings_in_executable_code():
    s = _executable_only(_gen())
    assert r"BUILTIN\Administrators" not in s
    assert r"NT AUTHORITY\SYSTEM" not in s


def test_acl_inheritance_disabled():
    s = _gen()
    assert "SetAccessRuleProtection" in s


def test_acl_failure_is_fail_closed():
    """ACL hardening failure must abort BEFORE config.env staging."""
    s = _gen()
    match = re.search(
        r"Set-Acl \$InstallDir \$acl[\s\S]+?\}\s*catch\s*\{([\s\S]+?)\n\s*\}\s*\n",
        s,
    )
    assert match
    catch_body = match.group(1)
    assert "exit 1" in catch_body
    assert "[ERROR]" in catch_body


# ── iwr | iex hard rejection + self-elevation ─────────────────────────────


def test_self_elevation_recursion_guard():
    s = _gen()
    assert "NETMANAGER_INSTALLER_ELEVATED" in s
    assert "Start-Process" in s
    assert "-Verb RunAs" in s


def test_psc_command_path_required_for_self_elevation():
    s = _gen()
    assert "$PSCommandPath" in s
    assert "iwr | iex" in s or "iwr|iex" in s


def test_no_inline_iwr_pipe_iex_installer_call():
    s = _gen()
    forbidden_patterns = [
        r"Invoke-WebRequest\s+[^\n]+\|\s*Invoke-Expression",
        r"\biwr\s+[^|]*\|\s*iex\b",
    ]
    for pat in forbidden_patterns:
        m = re.search(pat, s)
        if m:
            start = s.rfind("\n", 0, m.start()) + 1
            line = s[start:m.end()]
            assert line.lstrip().startswith("#"), \
                f"installer contains executable iwr|iex pipeline: {line!r}"


def test_no_invoke_expression():
    s = _executable_only(_gen())
    assert "Invoke-Expression" not in s


def test_self_elevation_parent_waits_for_child():
    s = _gen()
    assert "Start-Process" in s
    assert "-Wait" in s
    assert "-PassThru" in s
    assert "$proc.ExitCode" in s


def test_self_elevation_parent_cleans_on_uac_failure():
    s = _gen()
    parent_block = re.search(
        r"if \(-not \$isAdmin\) \{[\s\S]+?exit \$childExit\s*\}",
        s,
    )
    assert parent_block is not None
    body = parent_block.group(0)
    assert "finally" in body
    assert "Remove-Item -LiteralPath $PSCommandPath" in body


# ── BOM-less config + run wrapper ─────────────────────────────────────────


def test_config_uses_writeAllText_no_bom():
    s = _gen()
    assert "[System.IO.File]::WriteAllText" in s
    assert "System.Text.UTF8Encoding($false)" in s


def test_config_staged_under_staging_path_not_install_root():
    """Section A — config.env.new must be written under
    $StagingDir\\config.env.new (then M6 moves it to live).
    The legacy direct-write to $InstallDir\\config.env is forbidden."""
    s = _gen()
    assert "StagingConfigNew" in s
    assert "config.env.new" in s


# ── 11-stage labels ───────────────────────────────────────────────────────


def test_all_11_stage_labels_present():
    s = _gen()
    for i in range(1, 12):
        assert f"[{i}/11]" in s, f"Stage label [{i}/11] missing"


def test_no_legacy_9_stage_labels():
    """The 9-stage labels must be gone — drift between the stage
    count and the labels would mislead operators."""
    s = _gen()
    for i in range(1, 10):
        assert f"[{i}/9]" not in s, f"Legacy stage label [{i}/9] still present"


# ── Helpers: Invoke-ProcessCaptured / Invoke-HostInstall / LOGICAL_DELETE ─


def test_invoke_process_captured_defined():
    """Correction #66 — PS 5.1 compatible capture helper."""
    s = _gen()
    assert "function Invoke-ProcessCaptured" in s
    assert "[pscustomobject]" in s
    assert "RedirectStandardOutput" in s
    assert "RedirectStandardError" in s
    assert "ExitCode" in s
    assert "Stdout" in s
    assert "Stderr" in s


def _window_after(s: str, start_marker: str, end_marker: str | None = None,
                  max_chars: int = 6000) -> str:
    """Return the substring from `start_marker` up to `end_marker`
    (exclusive) or up to `max_chars` chars — whichever comes first."""
    idx = s.find(start_marker)
    assert idx >= 0, f"marker {start_marker!r} not found"
    tail = s[idx:idx + max_chars]
    if end_marker is not None:
        end_idx = tail.find(end_marker, len(start_marker))
        if end_idx > 0:
            tail = tail[:end_idx]
    return tail


def test_invoke_process_captured_logical_deletes_temp_files():
    """Correction #57 — captured stdout/stderr files are
    LOGICAL_DELETEd in a finally block."""
    s = _gen()
    fn = _window_after(s, "function Invoke-ProcessCaptured",
                       "function Invoke-HostInstall")
    assert "finally" in fn
    assert "Remove-Item -LiteralPath $p" in fn
    assert 'throw "Invoke-ProcessCaptured: failed to LOGICAL_DELETE' in fn


def test_invoke_process_captured_temp_dir_has_locked_acl():
    """Stdout/stderr temp files live under $StagingProcCapture which
    is locked to SYSTEM + Administrators (the captured payload should
    NEVER carry the agent key, but the ACL is defence in depth)."""
    s = _gen()
    fn = _window_after(s, "function Invoke-ProcessCaptured",
                       "function Invoke-HostInstall")
    assert "StagingProcCapture" in fn
    assert "S-1-5-18" in fn or "sid_sys" in fn
    assert "S-1-5-32-544" in fn or "sid_adm" in fn


def test_invoke_host_install_defined():
    """Correction #58 + #66 — canonical install invocation helper."""
    s = _gen()
    assert "function Invoke-HostInstall" in s
    fn = _window_after(s, "function Invoke-HostInstall",
                       "function Invoke-LogicalDelete")
    for flag in (
        '"install"',
        '"--service-name"',
        '"--display-name"',
        '"--description"',
        '"--child-exe"',
        '"--child-arg"',
        '"-E"',
        '"-I"',
        '"--work-dir"',
        '"--env-file"',
        '"--log-dir"',
        '"--service-account"',
        '"LocalSystem"',
    ):
        assert flag in fn, f"Invoke-HostInstall canonical flag missing: {flag}"
    assert "Invoke-ProcessCaptured" in fn
    assert "pscustomobject" in fn


def test_invoke_host_install_uses_isolated_python_args():
    """The --child-arg sequence must be `-E -I <entrypoint>` in that
    exact order (correction #58 — explicit isolated mode)."""
    s = _gen()
    fn = _window_after(s, "function Invoke-HostInstall",
                       "function Invoke-LogicalDelete")
    # The three --child-arg entries appear in order
    assert re.search(
        r'"--child-arg",\s*"-E",\s*"--child-arg",\s*"-I",\s*"--child-arg",\s*\$Entrypoint',
        fn,
    ), "Invoke-HostInstall child-arg sequence must be -E -I <entrypoint>"


def test_invoke_logical_delete_defined():
    s = _gen()
    assert "function Invoke-LogicalDelete" in s


# ── No bare `& $HostExe install` / no $LASTEXITCODE near install ──────────


def test_no_bare_charon_install_call():
    """Correction #58 — bare `charon-agent-host.exe install` (whether
    via `&` or via PATH lookup) is forbidden; install MUST go through
    Invoke-HostInstall."""
    s = _executable_only(_gen())
    bad = re.search(r"\bcharon-agent-host\.exe\s+install\b", s)
    assert bad is None, f"bare host install: {bad.group(0)!r}"
    # Also catch `& $HostExe(Live)? install`
    bad2 = re.search(r"&\s*\$HostExe(?:Live|Bak|New)?\s+install\b", s)
    assert bad2 is None, f"bare `& \\$HostExe install`: {bad2.group(0)!r}"


def test_no_lastexitcode_anywhere_in_install_template():
    """Correction #66 — the new template routes EVERY host CLI call
    through Invoke-ProcessCaptured, so `$LASTEXITCODE` never has to
    be sampled. A `$LASTEXITCODE` reference would suggest a regression
    to the pollution-prone pipeline pattern."""
    s = _executable_only(_gen())
    occurrences = re.findall(r"\$LASTEXITCODE\b", s)
    assert occurrences == [], \
        f"$LASTEXITCODE must not appear in executable installer code; found {len(occurrences)}"


# ── Stage 2B — transaction-recovery preflight + four-probe ───────────────


def test_stage_2b_transaction_recovery_preflight_present():
    s = _gen()
    assert "TRANSACTION_RECOVERY_RESULT=BLOCKED" in s
    assert "UNRESOLVED_PREVIOUS_TRANSACTION" in s


def test_stage_2b_four_probes_present():
    """Correction #71 — Get-Service + Test-Path Registry +
    Get-CimInstance Win32_Service + host status."""
    s = _gen()
    assert "Get-Service -Name $ServiceName" in s
    assert "Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services" in s
    assert "Get-CimInstance Win32_Service" in s
    # P4 is the host status call
    assert '"status","--service-name",$ServiceName' in s


def test_stage_2b_probe_disagreement_blocks():
    s = _gen()
    assert "SERVICE_REGISTRATION_PROBE_INCONSISTENT" in s
    # Exit 3 on probe-disagreement
    assert "exit 3" in s


def test_stage_2b_initial_service_state_classification():
    s = _gen()
    assert "InitialServiceState" in s
    assert '"Absent"' in s
    assert '"Running"' in s
    assert '"Stopped"' in s


def test_stage_2b_initial_registration_snapshot_captured():
    """Correction #65 — snapshot the read-only registration when a
    service exists, then compare against the canonical-restorable
    shape (correction #70)."""
    s = _gen()
    assert "InitialRegistrationSnapshot" in s
    assert "IsCanonicallyRestorable" in s


def test_stage_2b_canonically_restorable_gate_blocks():
    s = _gen()
    assert "REGISTRATION_NOT_CANONICALLY_RESTORABLE" in s


def test_stage_2b_install_mode_matrix():
    """Correction #52 — CLEAN_INSTALL / HEALTHY_UPGRADE /
    INCONSISTENT_LIVE_STATE."""
    s = _gen()
    assert "CLEAN_INSTALL" in s
    assert "HEALTHY_UPGRADE" in s
    assert "INCONSISTENT_LIVE_STATE" in s


# ── Stage 4 + 5 — runtime endpoints downloaded ────────────────────────────


def test_runtime_manifest_endpoint_used():
    s = _gen()
    assert "/api/v1/agents/$AgentId/download/runtime/windows-amd64/manifest" in s
    assert "X-Charon-Runtime-Version" in s
    assert "X-Charon-Runtime-Zip-Sha256" in s
    assert "X-Charon-Compatible-Host-Core-Range" in s


def test_runtime_zip_endpoint_used():
    s = _gen()
    assert "/api/v1/agents/$AgentId/download/runtime/windows-amd64" in s


def test_runtime_zip_sha_cross_checked_against_manifest():
    s = _gen()
    # Both header AND manifest field must equal actual disk SHA
    assert "$actualZipSha -cne $zipShaHeader" in s
    assert "$actualZipSha -cne $manifestZipSha" in s


def test_runtime_zip_sha_failure_does_not_touch_live_payload():
    """SHA mismatch must delete only the staged ZIP."""
    s = _gen()
    assert "Remove-Item -LiteralPath $StagingRuntimeZip" in s


# ── Stage 6A — Section F per-entry rejection list ─────────────────────────


def test_stage_6a_uses_native_zipfile_open_read():
    s = _gen()
    assert "[System.IO.Compression.ZipFile]::OpenRead" in s


def test_stage_6a_rejects_traversal_and_namespace_violations():
    s = _gen()
    for needle in (
        "explicit directory entry",
        "leading separator",
        "drive-letter prefix",
        "empty segment",
        "dot segment",
        "dotdot segment",
        "trailing dot",
        "trailing space",
        "colon in segment",
        "reserved device name",
        "symlink entry",
        "escapes extraction root",
    ):
        assert needle in s, f"Section F rejection clause missing: {needle}"


def test_stage_6a_root_containment_check():
    s = _gen()
    assert "StartsWith($extractionRoot" in s
    assert "OrdinalIgnoreCase" in s


def test_stage_6a_smoke_list_line_format_validated():
    s = _gen()
    assert "metadata\\\\runtime-smoke-imports.txt" in s.replace("\\\\","\\\\\\\\") or \
           "metadata\\runtime-smoke-imports.txt" in s
    # Regex line format for smoke list entries
    assert r"'^[A-Za-z_][A-Za-z0-9_.]*$'" in s


# ── Stage 6B — atomic rename + byte-exact RUNTIME_OK ──────────────────────


def test_stage_6b_atomic_rename_to_payload_new():
    s = _gen()
    assert "[System.IO.Directory]::Move($StagingExtracted, $PayloadNew)" in s


def test_stage_6b_sanity_fire_byte_exact_runtime_ok():
    """Correction #46 + #66 — `RUNTIME_OK` is byte-exact, stderr empty."""
    s = _gen()
    assert "Invoke-ProcessCaptured" in s
    assert "import $ModuleArg; print('RUNTIME_OK')" in s
    assert '$smokeStdoutTrim -cne "RUNTIME_OK"' in s
    assert "$smokeResult.Stderr.Length -gt 0" in s


def test_stage_6b_python_runs_in_isolated_mode():
    s = _gen()
    # -E and -I appear together with --version + smoke
    assert '"-E","-I","--version"' in s
    assert '"-E","-I","-c"' in s


def test_no_bare_python_exe_invocation():
    """The private runtime python is at
    $PayloadCurrent\\runtime\\python\\python.exe. A bare
    `python.exe`/`python` invocation would search PATH and could hit
    a system Python."""
    s = _executable_only(_gen())
    assert not re.search(r"&\s*python\.exe\b", s)
    assert not re.search(r"&\s*python\b(?!Exe|ExeLive|Path)", s)


# ── Stage 8 — Go host binary download to staging ──────────────────────────


def test_host_binary_download_to_hostexe_new():
    s = _gen()
    assert "$HostExeNew" in s
    assert "/api/v1/agents/$AgentId/download/host/windows-amd64" in s
    assert "X-Host-SHA256" in s
    assert "Get-FileHash" in s
    # Direct overwrite of live host forbidden
    assert "-OutFile $HostExeLive" not in s
    assert "-OutFile $HostExe " not in s


def test_host_sha_check_runs_on_stage_file():
    s = _gen()
    assert "Get-FileHash -LiteralPath $HostExeNew" in s


def test_host_url_built_from_agent_id():
    s = _gen()
    assert "/api/v1/agents/$AgentId/download/host/windows-amd64" in s


def test_agent_key_in_host_header_not_url():
    s = _gen()
    assert '"X-Agent-Key" = $AgentKey' in s
    assert re.search(r"download/host[^\"\n]*\?[^\"\n]*agent_key=", s) is None


# ── Stage 9A — pre-quiesce process snapshot (correction #72) ──────────────


def test_stage_9a_a0_snapshot_taken_before_branching():
    s = _gen()
    assert "OldHostProcessSnapshot" in s
    assert "OldVerifiedChildPythonProcessSnapshot" in s
    # PID + path + creation-time triple — look at the populated
    # snapshot block, not the @() initialiser.
    fn = _window_after(s, "# 9A.A0 - pre-quiesce process snapshot",
                       "9A.A1 / A1.post / A2 / A2.post branching")
    assert "ProcessId" in fn
    assert "ExecutablePath" in fn
    assert "CreationDate" in fn


def test_stage_9a_a3_uses_pid_path_creation_time_triple():
    s = _gen()
    # A3 polling must compare all three to defeat PID reuse.
    chunk = _window_after(
        s,
        "# 9A.A3 - process closure verification using PID + path",
        "9B: ATOMIC SWAP",
    )
    assert "ExecutablePath" in chunk
    assert "CreationDate" in chunk


def test_stage_9a_stop_uninstall_use_invoke_process_captured():
    s = _gen()
    assert re.search(
        r'Invoke-ProcessCaptured -FilePath \$HostExeLive\s+`\s*\n\s+-ArgumentList @\("stop"',
        s,
    )
    assert re.search(
        r'Invoke-ProcessCaptured -FilePath \$HostExeLive\s+`\s*\n\s+-ArgumentList @\("uninstall"',
        s,
    )
    assert re.search(
        r'Invoke-ProcessCaptured -FilePath \$HostExeLive\s+`\s*\n\s+-ArgumentList @\("status"',
        s,
    )


def test_stage_9a_no_stop_when_initial_stopped():
    """Correction #60 — stop on Stopped returns exit 1; branch skips A1."""
    s = _gen()
    assert 'elseif ($InitialServiceState -ceq "Stopped")' in s
    assert "correction #60" in s


# ── Stage 9B — M1..M6 atomic-swap ledger ─────────────────────────────────


def test_stage_9b_m1_m6_markers_initialized():
    s = _gen()
    for m in (
        "MovedPayloadCurrentToPrevious",
        "MovedPayloadNewToCurrent",
        "MovedHostLiveToBackup",
        "MovedHostNewToLive",
        "MovedConfigLiveToBackup",
        "MovedConfigNewToLive",
    ):
        assert f"${m}" in s, f"M-ledger marker missing: ${m}"
        assert f"${m}" in s and re.search(rf"\${m}\s*=\s*\$true", s), \
            f"M-ledger marker {m} is never set to true"


def test_stage_9b_uses_io_directory_move_and_io_file_move():
    """Atomic moves through .NET — Move-Item on a directory falls
    back to copy+delete which is NOT atomic."""
    s = _gen()
    assert "[System.IO.Directory]::Move($PayloadCurrent, $PayloadPrevious)" in s
    assert "[System.IO.Directory]::Move($PayloadNew, $PayloadCurrent)" in s
    assert "[System.IO.File]::Move($HostExeLive, $HostExeBak)" in s
    assert "[System.IO.File]::Move($HostExeNew, $HostExeLive)" in s
    assert "[System.IO.File]::Move($ConfigEnvLive, $ConfigEnvBak)" in s
    assert "[System.IO.File]::Move($StagingConfigNew, $ConfigEnvLive)" in s


def test_stage_9b_optional_move_dest_must_not_exist_precondition():
    """M1/M3/M5 destinations are backup paths — they must not exist
    when we move into them (Stage 2B blocks any state where they do)."""
    s = _gen()
    for d in ("$PayloadPrevious", "$HostExeBak", "$ConfigEnvBak"):
        assert f"if (Test-Path -LiteralPath {d}) {{" in s


# ── Stage 10 — structured install + exit 17 anomaly ──────────────────────


def test_stage_10_calls_invoke_host_install():
    s = _gen()
    assert "Invoke-HostInstall `" in s
    assert "$installResult = Invoke-HostInstall" in s


def test_stage_10_reads_exitcode_from_structured_result():
    """Correction #66 — read .ExitCode from the structured return,
    NEVER $LASTEXITCODE."""
    s = _gen()
    assert "$installResult.ExitCode" in s
    assert "$installResult.Stdout" in s
    assert "$installResult.Stderr" in s


def test_stage_10_success_stdout_validated_byte_exact():
    """The success literal `Service "NetManagerAgent" installed.\\n`
    must be matched byte-exact (-cne)."""
    s = _gen()
    assert '-cne \'Service "NetManagerAgent" installed.\'' in s


def test_stage_10_exit_17_anomaly_handled():
    """Correction #51 — exit 17 is `service: already exists`; the
    template MUST recognise it and route into Phase 1 teardown
    rather than treat it as a generic failure."""
    s = _gen()
    assert "$installResult.ExitCode -eq 17" in s
    assert '-cne "install: service: already exists"' in s
    assert "L6P_NewServiceRegistrationPossiblyExists" in s


def test_stage_10_does_not_silently_swallow_other_exit_codes():
    s = _gen()
    # The else branch surfaces the actual exit code in an [ERROR] line
    assert 'Write-Host "[ERROR] install exit $($installResult.ExitCode)' in s


# ── Stage 11 — commit barrier ─────────────────────────────────────────────


def test_stage_11_running_verification_at_10s_and_30s():
    s = _gen()
    assert "Start-Sleep -Seconds 10" in s
    assert "Start-Sleep -Seconds 20" in s
    assert '$s10Trim -cne "Running"' in s
    assert '$s30Trim -cne "Running"' in s


def test_stage_11_running_check_uses_invoke_process_captured():
    s = _gen()
    assert re.search(
        r'\$s10\s*=\s*Invoke-ProcessCaptured -FilePath \$HostExeLive',
        s,
    )
    assert re.search(
        r'\$s30\s*=\s*Invoke-ProcessCaptured -FilePath \$HostExeLive',
        s,
    )


def test_stage_11_commit_barrier_semantic_equivalence_before_delete():
    """Correction #69 — Stage 11.D LOGICAL_DELETE of backups runs
    AFTER Stage 11.A/B/C semantic-equivalence verification."""
    s = _gen()
    assert "Stage 11.A/B/C: SCM registration semantic equivalence" in s
    assert "Stage 11.D" in s
    # Verify the source-order: 11.C error path appears BEFORE the
    # backup-delete loop.
    idx_11c = s.find("Stage 11.C: registration semantic mismatch")
    idx_11d = s.find("Stage 11.D - LOGICAL_DELETE")
    assert 0 < idx_11c < idx_11d, \
        "Stage 11.D backup-delete must source-order AFTER Stage 11.C check"


def test_stage_11_backup_deletion_targets_correct_paths():
    s = _gen()
    block = re.search(
        r"Stage 11\.D[\s\S]+?Invoke-LogicalDelete -Path \$b",
        s,
    )
    assert block is not None
    chunk = block.group(0)
    for b in ("$PayloadPrevious", "$ConfigEnvBak", "$HostExeBak"):
        assert b in chunk, f"Stage 11.D missing backup path: {b}"


def test_stage_11_uses_logical_delete_not_remove_item_direct():
    """Per correction #57 the backup-delete loop must call
    Invoke-LogicalDelete (which verifies non-existence after the
    Remove-Item) rather than a bare Remove-Item."""
    s = _gen()
    block = re.search(
        r"Stage 11\.D[\s\S]+?Invoke-LogicalDelete -Path \$b",
        s,
    )
    assert block is not None
    chunk = block.group(0)
    assert "Invoke-LogicalDelete" in chunk


# ── Section G rollback paths ──────────────────────────────────────────────


def test_section_g_three_rollback_modes_named():
    s = _gen()
    for mode in (
        "SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING",
        "SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED",
        "SUCCESSFUL_CLEAN_INSTALL_ROLLBACK",
    ):
        assert mode in s, f"rollback mode label missing: {mode}"


def test_rollback_incomplete_path_exits_2():
    s = _gen()
    assert "ROLLBACK_INCOMPLETE" in s
    assert "MANUAL INTERVENTION REQUIRED" in s
    assert "exit 2" in s


def test_rollback_phase_2_reverses_in_m6_to_m1_order():
    """Section G.5 — reverse markers in M6 → M5 → M4 → M3 → M2 → M1."""
    s = _gen()
    block = re.search(
        r"Phase 2 - file reverse-rollback[\s\S]+?ROLLBACK_INCOMPLETE",
        s,
    )
    assert block is not None
    chunk = block.group(0)
    idx_m6 = chunk.find("MovedConfigNewToLive")
    idx_m5 = chunk.find("MovedConfigLiveToBackup")
    idx_m4 = chunk.find("MovedHostNewToLive")
    idx_m3 = chunk.find("MovedHostLiveToBackup")
    idx_m2 = chunk.find("MovedPayloadNewToCurrent")
    idx_m1 = chunk.find("MovedPayloadCurrentToPrevious")
    assert 0 < idx_m6 < idx_m5 < idx_m4 < idx_m3 < idx_m2 < idx_m1, \
        f"Phase 2 reverse-order mismatch: {idx_m6} {idx_m5} {idx_m4} {idx_m3} {idx_m2} {idx_m1}"


def test_rollback_clean_install_orphan_cleanup():
    """Correction #67 — when M5 / M3 / M1 are NOT set but their
    M6 / M4 / M2 counterparts ARE, the reverse pass must
    LOGICAL_DELETE the orphan transient."""
    s = _gen()
    block = re.search(
        r"Phase 2 - file reverse-rollback[\s\S]+?ROLLBACK_INCOMPLETE",
        s,
    )
    chunk = block.group(0)
    # The clean-install orphan-cleanup elseifs must reference each
    # of the three pairings.
    assert "elseif ($MovedConfigNewToLive)" in chunk
    assert "elseif ($MovedHostNewToLive)" in chunk
    assert "elseif ($MovedPayloadNewToCurrent)" in chunk


def test_rollback_phase_3_does_not_start_when_initially_stopped():
    """Correction #61 — Stopped rollback re-installs (if needed) but
    must NOT call start."""
    s = _gen()
    phase3 = _window_after(
        s, "# ---- Phase 3 - restart old service",
        'Write-InstallerRunTxt @(\n                    "ROLLBACK_INCOMPLETE"',
    )
    # Carve out the Stopped branch specifically; the Running branch
    # above DOES call start.
    stopped_idx = phase3.find('elseif ($InitialServiceState -ceq "Stopped")')
    assert stopped_idx >= 0, "Phase 3 Stopped branch not found"
    stopped_chunk = phase3[stopped_idx:]
    # Stop the slice at the closing `}` of the Stopped elseif by
    # finding the next `} catch {` or end-of-window.
    end_idx = stopped_chunk.find("} catch {")
    if end_idx > 0:
        stopped_chunk = stopped_chunk[:end_idx]
    assert '"start","--service-name"' not in stopped_chunk, \
        "Phase 3 Stopped branch must not call start (correction #61)"


def test_rollback_phase_3_uses_invoke_host_install_for_reregister():
    """Phase 3 reregister MUST go through Invoke-HostInstall — the
    bare `& $HostExe install` regression is forbidden."""
    s = _gen()
    chunk = _window_after(
        s, "# ---- Phase 3 - restart old service",
        'Write-InstallerRunTxt @(\n                "ROLLBACK_RESULT',
    )
    assert "Invoke-HostInstall" in chunk
    bad = re.search(r"&\s*\$HostExe\w*\s+install\b", chunk)
    assert bad is None, f"Phase 3 bare install regression: {bad.group(0)!r}"


# ── TLS 1.2 + installer self-cleanup ──────────────────────────────────────


def test_tls_12_enforced():
    s = _gen()
    assert "[Net.ServicePointManager]::SecurityProtocol" in s
    assert "Tls12" in s


def test_installer_self_cleanup_uses_literal_path():
    s = _gen()
    assert "Remove-Item -LiteralPath $PSCommandPath" in s


def test_all_path_cleanup_via_try_finally():
    s = _gen()
    assert "try {" in s
    assert "finally {" in s
    finally_idx = s.rfind("finally {")
    assert finally_idx > 0
    finally_tail = s[finally_idx:]
    assert "$AgentKey = $null" in finally_tail
    assert "Remove-Item -LiteralPath $PSCommandPath" in finally_tail


def test_agent_key_zeroed_in_finally():
    s = _gen()
    finally_idx = s.rfind("finally {")
    assert "$AgentKey = $null" in s[finally_idx:]


# ── Agent key never in URL / log / filename ──────────────────────────────


def test_agent_key_never_in_writehost():
    s = _gen()
    for forbidden in (
        "Write-Host $AgentKey",
        'Write-Host "$AgentKey',
        "Write-Output $AgentKey",
    ):
        assert forbidden not in s


def test_agent_key_not_in_filename_interpolations():
    s = _gen()
    bad = re.search(r'filename="[^"]*\$AgentKey[^"]*"', s)
    assert bad is None


def test_agent_key_never_appears_in_url_query():
    s = _gen()
    bad = re.search(r"\?\s*[^\"]*agent[_-]?key\s*=", s, re.IGNORECASE)
    assert bad is None, f"agent key in URL query: {bad.group(0)!r}"


def test_agent_key_only_in_x_agent_key_header_and_config_writer():
    """The $AgentKey variable must only appear:
      - in the head of the script (variable assignment / display)
      - inside the `"X-Agent-Key" = $AgentKey` header dictionaries
      - in the staged config.env.new write
      - in the finally block ($AgentKey = $null)
    """
    s = _gen()
    # Spot check: must NOT appear inside any -ArgumentList @(...) call
    for m in re.finditer(r"-ArgumentList\s+@\(([\s\S]+?)\)", s):
        chunk = m.group(1)
        assert "$AgentKey" not in chunk, \
            f"AgentKey leaked into ArgumentList: {chunk[:120]!r}"


# ── Single-quote escape (F1.3 defense) ────────────────────────────────────


def test_quote_injection_escaped():
    from app.api.v1.endpoints.agents import _windows_installer
    out = _windows_installer("evil'agent", "key'with'quote", "https://x")
    assert "$AgentId    = 'evil''agent'" in out
    assert "$AgentKey   = 'key''with''quote'" in out


# ── Structural sanity ────────────────────────────────────────────────────


def test_balanced_brace_pairs():
    s = _gen()
    assert s.count("{") == s.count("}"), \
        f"unbalanced braces: {{ {s.count('{')} vs }} {s.count('}')}"


def test_balanced_paren_pairs():
    s = _gen()
    assert s.count("(") == s.count(")"), \
        f"unbalanced parens: ( {s.count('(')} vs ) {s.count(')')}"


def test_first_line_is_section_h_header():
    s = _gen()
    first = s.lstrip().split("\n")[0]
    assert "Section H 11-stage" in first


# ============================================================================
# URL render hardening + secret-output guards (Run T1.02 BLOCKED-WITH-LEAK
# postmortem). Two root causes drove the postmortem:
#
#   1. Run T1.02 trailing-slash bug — `test-config.json` carried
#      `backend_url: "http://10.2.22.24/"`; the installer's `$BackendUrl`
#      string-concat with `/api/v1/...` produced a `//api/v1/...` URL.
#   2. Run T1.02 secret leak — debug curl of the installer endpoint
#      piped the rendered installer body (with embedded `$AgentKey`
#      literal) into chat output.
#
# Tests below pin the backend-side fix:
#
#   - `_windows_installer()` defensively normalizes the base URL it
#     receives so a trailing-slash value can't sneak through.
#   - The `_redact()` helper is used in every new test whose failure
#     message would otherwise carry the agent_key literal. The doctrine
#     for ALL future Windows-installer tests is: assertion failure
#     output is computed from the redacted body, never the raw body.
# ============================================================================


REAL_SHAPE_KEY_FIXTURE = (
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
)


def _redact(text: str, *secrets: str) -> str:
    """Replace every occurrence of each secret with `***REDACTED***`.

    Used by every test in this section whose failure output would
    otherwise contain a real-shape agent_key. The Run T1.02 leak
    happened because rendered installer bodies were echoed without
    a redaction pass — that doctrine is enforced here in the test
    layer to mirror what production debug code must also do.
    """
    out = text
    for s in secrets:
        if s:
            out = out.replace(s, "***REDACTED***")
    return out


# ── _redact helper contract ──────────────────────────────────────────────


def test_redact_helper_replaces_every_occurrence():
    s = REAL_SHAPE_KEY_FIXTURE + " middle " + REAL_SHAPE_KEY_FIXTURE
    out = _redact(s, REAL_SHAPE_KEY_FIXTURE)
    assert REAL_SHAPE_KEY_FIXTURE not in out
    assert out.count("***REDACTED***") == 2


def test_redact_helper_handles_empty_secret():
    assert _redact("untouched body", "") == "untouched body"


def test_redact_helper_handles_multiple_secrets():
    key = REAL_SHAPE_KEY_FIXTURE
    other = "secondary-secret-token"
    body = f"a={key} b={other} c={key}"
    out = _redact(body, key, other)
    assert key not in out and other not in out
    assert out.count("***REDACTED***") == 3


# ── URL render — $BackendUrl literal embed ───────────────────────────────


def test_windows_installer_embeds_backend_url_literal():
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)
    safe = _redact(body, SAMPLE_AGENT_KEY)
    assert f"$BackendUrl = '{SAMPLE_BACKEND_URL}'" in safe


def test_windows_installer_normalizes_trailing_slash_host_only():
    """A backend_url that ends in a trailing slash must NOT appear with
    the slash in the rendered `$BackendUrl` literal. Run T1.02 root
    cause #2: the embedded literal was concatenated with `/api/v1/...`
    producing a `//api/v1/...` URL."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, "https://staging.example.com/",
    )
    safe = _redact(body, SAMPLE_AGENT_KEY)
    assert "$BackendUrl = 'https://staging.example.com'" in safe
    assert "$BackendUrl = 'https://staging.example.com/'" not in safe


def test_windows_installer_normalizes_trailing_slash_path_prefix():
    """A backend_url whose path component ends in a trailing slash must
    also be normalized — covers reverse-proxy-with-prefix deployments."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, "https://gw.example.com/api/proxy/",
    )
    safe = _redact(body, SAMPLE_AGENT_KEY)
    assert "$BackendUrl = 'https://gw.example.com/api/proxy'" in safe


def test_windows_installer_preserves_path_prefix_without_trailing_slash():
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, "https://gw.example.com/api/proxy",
    )
    safe = _redact(body, SAMPLE_AGENT_KEY)
    assert "$BackendUrl = 'https://gw.example.com/api/proxy'" in safe


def test_windows_installer_no_double_slash_in_endpoint_path_concatenations():
    """The template builds endpoint URLs by string concat with `$BackendUrl`.
    A double-slash run must never appear after the scheme separator."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, "http://10.2.22.24/",
    )
    safe = _redact(body, SAMPLE_AGENT_KEY)
    # Strip the legitimate `://` so the test isn't fooled by `https://`.
    after_scheme = safe.replace("https://", "").replace("http://", "")
    assert "//api/v1/" not in after_scheme, (
        "rendered installer contains // before /api/v1/ — trailing-slash "
        "normalization regressed (Run T1.02 root cause #2). "
        f"safe body length: {len(safe)} bytes."
    )


# ── _normalize_windows_installer_base_url helper contract ────────────────


def test_normalize_strip_trailing_slash_host_only():
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    assert _normalize_windows_installer_base_url("https://x.com/") == "https://x.com"


def test_normalize_strip_trailing_slash_path_prefix():
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    assert (
        _normalize_windows_installer_base_url("https://x.com/api/proxy/")
        == "https://x.com/api/proxy"
    )


def test_normalize_preserves_already_clean_url():
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    assert _normalize_windows_installer_base_url("https://x.com") == "https://x.com"


def test_normalize_preserves_port():
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    assert (
        _normalize_windows_installer_base_url("https://x.com:8443/")
        == "https://x.com:8443"
    )


def test_normalize_rejects_empty():
    from fastapi import HTTPException
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    import pytest as _pt
    with _pt.raises(HTTPException) as ei:
        _normalize_windows_installer_base_url("")
    assert ei.value.status_code == 503


def test_normalize_rejects_non_http_scheme():
    from fastapi import HTTPException
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    import pytest as _pt
    for url in ("ftp://x.com", "javascript:alert(1)", "file:///etc/passwd",
                "data:text/plain,foo", "ssh://user@host"):
        with _pt.raises(HTTPException) as ei:
            _normalize_windows_installer_base_url(url)
        assert ei.value.status_code == 503, f"scheme not rejected: {url}"


def test_normalize_rejects_missing_netloc():
    from fastapi import HTTPException
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    import pytest as _pt
    with _pt.raises(HTTPException) as ei:
        _normalize_windows_installer_base_url("https://")
    assert ei.value.status_code == 503


def test_normalize_rejects_shell_meta_chars():
    """Defense-in-depth on top of `_psq` single-quote escaping inside
    `_windows_installer()`. A value with a stray `'`, `;`, `|`, newline,
    etc. is almost certainly a misconfiguration."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.agents import _normalize_windows_installer_base_url
    import pytest as _pt
    for url in (
        "https://x.com';dropdb",
        'https://x.com"',
        "https://x.com|whoami",
        "https://x.com`id`",
        "https://x.com$VAR",
        "https://x.com&touch",
        "https://x.com\\backslash",
        "https://x.com\nnewline",
        "https://x.com\rcr",
        "https://x.com<tag>",
        "https://x.com space",
    ):
        with _pt.raises(HTTPException) as ei:
            _normalize_windows_installer_base_url(url)
        assert ei.value.status_code == 503, f"shell-meta not rejected: {url!r}"


# ── Endpoint-level integration tests for the new settings field ──────────


@pytest.fixture
def installer_app_with_overrides(monkeypatch):
    """Minimal FastAPI app for exercising /download/{platform} with a
    stubbed agent + DB. Mirrors test_host_endpoint_http.py but for the
    `download_installer` endpoint."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.v1.endpoints import agents as agents_mod
    from app.api.v1.endpoints.agents import agents_public_router
    from app.core.config import settings

    # Flag default off — each test opts in.
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", False)
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", None)
    monkeypatch.setattr(settings, "AGENT_WS_URL", "")

    FAKE_AGENT_ID = "endpoint-test-agent"
    FAKE_AGENT_KEY = REAL_SHAPE_KEY_FIXTURE

    class _FakeAgent:
        id = FAKE_AGENT_ID
        is_active = True
        agent_key_hash = "stub-hash"

    class _StubExecute:
        def __init__(self, v):
            self._v = v
        def scalar_one_or_none(self):
            return self._v

    class _FakeDB:
        async def execute(self, stmt):
            if "set_config" in str(stmt):
                return _StubExecute(None)
            return _StubExecute(_FakeAgent())

    async def _fake_get_db():
        yield _FakeDB()

    def _fake_verify(plain, _hashed):
        return plain == FAKE_AGENT_KEY

    monkeypatch.setattr(agents_mod, "verify_password", _fake_verify)

    app = FastAPI()
    app.include_router(agents_public_router, prefix="/api/v1/agents")
    app.dependency_overrides[agents_mod.get_db] = _fake_get_db

    return {
        "client": TestClient(app),
        "agent_id": FAKE_AGENT_ID,
        "agent_key": FAKE_AGENT_KEY,
        "settings": settings,
    }


def test_endpoint_uses_external_base_url_when_set(
    installer_app_with_overrides, monkeypatch,
):
    """When `WINDOWS_AGENT_V2_EXTERNAL_BASE_URL` is set, the rendered
    installer's `$BackendUrl` literal MUST equal that value (after
    trailing-slash normalization), not the request-derived base URL."""
    s = installer_app_with_overrides["settings"]
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_ENABLED", True)
    monkeypatch.setattr(
        s, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", "https://staging.example.com",
    )

    client = installer_app_with_overrides["client"]
    aid = installer_app_with_overrides["agent_id"]
    akey = installer_app_with_overrides["agent_key"]

    r = client.get(
        f"/api/v1/agents/{aid}/download/windows",
        headers={"X-Agent-Key": akey},
    )
    assert r.status_code == 200
    # Body carries a UTF-8 BOM + CRLF — decode and normalize line endings
    # to LF for the substring check (matches what every Windows test does).
    body = r.content.lstrip(b"\xef\xbb\xbf").decode("utf-8").replace("\r\n", "\n")
    safe = _redact(body, akey)
    assert "$BackendUrl = 'https://staging.example.com'" in safe
    # The request landed at TestClient's "http://testserver" base — that
    # value MUST NOT have leaked through into the rendered body.
    assert "testserver" not in safe


def test_endpoint_normalizes_external_base_url_trailing_slash(
    installer_app_with_overrides, monkeypatch,
):
    """Even when the operator sets the setting with a trailing slash —
    `http://10.2.22.24/` was Run T1.02 root cause #2 — the rendered
    installer must embed the normalized form."""
    s = installer_app_with_overrides["settings"]
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_ENABLED", True)
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", "http://10.2.22.24/")

    client = installer_app_with_overrides["client"]
    aid = installer_app_with_overrides["agent_id"]
    akey = installer_app_with_overrides["agent_key"]

    r = client.get(
        f"/api/v1/agents/{aid}/download/windows",
        headers={"X-Agent-Key": akey},
    )
    assert r.status_code == 200
    body = r.content.lstrip(b"\xef\xbb\xbf").decode("utf-8").replace("\r\n", "\n")
    safe = _redact(body, akey)
    assert "$BackendUrl = 'http://10.2.22.24'" in safe
    assert "$BackendUrl = 'http://10.2.22.24/'" not in safe


def test_endpoint_falls_back_to_request_url_when_setting_unset(
    installer_app_with_overrides, monkeypatch,
):
    """With `WINDOWS_AGENT_V2_EXTERNAL_BASE_URL` unset (None), the
    request-derived base URL must drive `$BackendUrl`. Guards against an
    accidental "always read the setting" regression that would break
    deployments which legitimately rely on X-Forwarded-Host."""
    s = installer_app_with_overrides["settings"]
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_ENABLED", True)
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", None)

    client = installer_app_with_overrides["client"]
    aid = installer_app_with_overrides["agent_id"]
    akey = installer_app_with_overrides["agent_key"]

    r = client.get(
        f"/api/v1/agents/{aid}/download/windows",
        headers={"X-Agent-Key": akey, "X-Forwarded-Host": "fwd-host.example.com",
                 "X-Forwarded-Proto": "https"},
    )
    assert r.status_code == 200
    body = r.content.lstrip(b"\xef\xbb\xbf").decode("utf-8").replace("\r\n", "\n")
    safe = _redact(body, akey)
    # X-Forwarded-Host is the canonical fallback chain entry. The
    # rendered literal must reflect it (defensive sanitization keeps
    # only `[A-Za-z0-9.:-]` chars from the header value).
    assert "$BackendUrl = 'https://fwd-host.example.com'" in safe


def test_endpoint_503s_when_external_base_url_misconfigured(
    installer_app_with_overrides, monkeypatch,
):
    """A misconfigured setting (shell-meta / non-http scheme) must
    fail-closed at 503 — the rendered installer would otherwise be
    a guaranteed install failure, and `503 - temporarily unavailable`
    matches the semantics the endpoint already uses for flag-off."""
    s = installer_app_with_overrides["settings"]
    monkeypatch.setattr(s, "WINDOWS_AGENT_V2_ENABLED", True)
    monkeypatch.setattr(
        s, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", "ftp://wrong.scheme.example.com",
    )

    client = installer_app_with_overrides["client"]
    aid = installer_app_with_overrides["agent_id"]
    akey = installer_app_with_overrides["agent_key"]

    r = client.get(
        f"/api/v1/agents/{aid}/download/windows",
        headers={"X-Agent-Key": akey},
    )
    assert r.status_code == 503


def test_endpoint_linux_ignores_external_base_url_setting(
    installer_app_with_overrides, monkeypatch,
):
    """The override is Windows-only — Linux installer rendering must
    NOT use it. Guards Linux byte-equal golden against this PR."""
    s = installer_app_with_overrides["settings"]
    monkeypatch.setattr(
        s, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL", "https://windows-only.example.com",
    )

    client = installer_app_with_overrides["client"]
    aid = installer_app_with_overrides["agent_id"]
    akey = installer_app_with_overrides["agent_key"]

    r = client.get(
        f"/api/v1/agents/{aid}/download/linux",
        headers={"X-Agent-Key": akey},
    )
    assert r.status_code == 200
    body = r.content.decode("utf-8")
    safe = _redact(body, akey)
    # The Linux installer must not have picked up the Windows-only
    # setting under any code path.
    assert "windows-only.example.com" not in safe


# ── Secret-output discipline (Run T1.02 root cause #3) ───────────────────


def test_windows_installer_embeds_agent_key_exactly_once():
    """The agent_key MUST be embedded into the rendered installer
    exactly once — in the `$AgentKey = '<key>'` literal. Anywhere else
    is a debug-echo / log statement that would have leaked the key into
    the calling process's stdout when the file is curl'd. Run T1.02
    leaked the key because the rendered body was echoed without any
    redaction; this test makes the "agent_key occurrences" surface
    auditable on every PR."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, REAL_SHAPE_KEY_FIXTURE, SAMPLE_BACKEND_URL,
    )
    count = body.count(REAL_SHAPE_KEY_FIXTURE)
    # Use the redacted view to size the failure output — never embed
    # the raw key in the AssertionError.
    safe_len = len(_redact(body, REAL_SHAPE_KEY_FIXTURE))
    assert count == 1, (
        f"agent_key appears {count} times in rendered Windows installer "
        f"(expected exactly 1, in the $AgentKey literal). "
        f"Redacted body length: {safe_len} bytes. "
        f"Any new occurrence is a probable secret-leak path — audit the "
        f"diff for debug `Write-Host $AgentKey`, log lines, or curl-style "
        f"interpolation."
    )


def test_redacted_failure_output_contains_no_key():
    """Sanity that the documented `_redact()` doctrine works as a guard:
    after redaction the agent_key literal is gone, but the placeholder
    is left behind so failure output is still actionable."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, REAL_SHAPE_KEY_FIXTURE, SAMPLE_BACKEND_URL,
    )
    safe = _redact(body, REAL_SHAPE_KEY_FIXTURE)
    assert REAL_SHAPE_KEY_FIXTURE not in safe
    assert "$AgentKey   = '***REDACTED***'" in safe


# ── Source-level invariants for the new setting field + endpoint hook ────


def test_settings_module_declares_external_base_url_field():
    """The new field is declared with the expected name + default None.
    Defends against an accidental rename or default-flip in a future PR."""
    from app.core.config import settings
    assert hasattr(settings, "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL"), (
        "config.Settings is missing WINDOWS_AGENT_V2_EXTERNAL_BASE_URL"
    )
    # Default must be None so existing deployments keep their current
    # request-derived base URL behavior.
    from app.core.config import Settings as _S
    fields = getattr(_S, "model_fields", None) or getattr(_S, "__fields__", {})
    field = fields["WINDOWS_AGENT_V2_EXTERNAL_BASE_URL"]
    default = getattr(field, "default", None)
    assert default is None, (
        f"WINDOWS_AGENT_V2_EXTERNAL_BASE_URL default must be None, got {default!r}"
    )


def test_download_installer_reads_external_base_url_setting():
    """Source-level guard: the endpoint must reference both the new
    setting and the normalization helper. Catches an accidental import
    deletion or branch-removal."""
    import inspect
    from app.api.v1.endpoints import agents as agents_mod
    src = inspect.getsource(agents_mod.download_installer)
    assert "WINDOWS_AGENT_V2_EXTERNAL_BASE_URL" in src, (
        "download_installer no longer references the external base URL setting"
    )
    assert "_normalize_windows_installer_base_url" in src, (
        "download_installer no longer normalizes the base URL"
    )


def test_normalization_helper_is_module_level():
    """The helper MUST be module-level (not nested inside the endpoint)
    so unit tests + future callers can import it directly. Importing
    from agents.py is the contract."""
    from app.api.v1.endpoints import agents as agents_mod
    assert callable(getattr(agents_mod, "_normalize_windows_installer_base_url"))


# ============================================================================
# Headless / non-interactive exit + rollback Phase 2 cleanup guarantee
# (Run T1.03 BLOCKED-WITH-FINDING postmortem).
#
# Two coupled problems Run T1.03 surfaced:
#
#   1. Read-Host hang. Every exit path in the rendered installer called
#      `Read-Host "Press Enter to exit"`, which blocks indefinitely when
#      there is no console attached -- the v4 wrapper's
#      `Start-Process -Wait` never returned, the validation session went
#      idle, and the operator had to terminate the chain manually.
#
#   2. Rollback Phase 2 cleanup gap. The Section G.7
#      SUCCESSFUL_CLEAN_INSTALL_ROLLBACK post-condition says
#      payload\new\, staging\runtime-new.zip, staging\runtime-new.manifest.json,
#      staging\runtime-new\, staging\config.env.new MUST be absent after a
#      clean-install rollback. The original implementation only reverses
#      the M1..M6 markers; if the install aborted BEFORE any M-marker was
#      set (Stage 6B sanity-fire failure in T1.03), those transients
#      survived even though ROLLBACK_RESULT=SUCCESSFUL_CLEAN_INSTALL_ROLLBACK
#      was written.
#
# Tests below pin the fix in three layers:
#
#   - `Wait-ForUserIfInteractive` helper + `$NonInteractive` gate exist
#     and gate every prompt.
#   - No raw `Read-Host "Press Enter to exit"` literals remain.
#   - Phase 2.0 transient cleanup runs BEFORE the M-reverse block AND
#     BEFORE the ROLLBACK_RESULT write; if the cleanup fails the
#     installer degrades to ROLLBACK_INCOMPLETE.
#   - Section G.7 post-condition is verified at runtime before
#     SUCCESSFUL_CLEAN_INSTALL_ROLLBACK is written.
# ============================================================================


def test_non_interactive_env_gate_present():
    """The `$NonInteractive` flag is the single gate every prompt
    consults. CHARON_NONINTERACTIVE=1 forces headless mode; absent
    that the gate falls back to [Environment]::UserInteractive."""
    s = _gen()
    assert "$env:CHARON_NONINTERACTIVE -eq '1'" in s, (
        "$NonInteractive must check CHARON_NONINTERACTIVE env var"
    )
    assert "[Environment]::UserInteractive" in s, (
        "$NonInteractive must fall back to UserInteractive"
    )
    assert "$NonInteractive" in s


def test_wait_for_user_helper_defined():
    s = _gen()
    assert "function Wait-ForUserIfInteractive" in s
    # The helper must be a no-op when $NonInteractive is true.
    assert "if (-not $NonInteractive)" in s
    # Read-Host inside the helper is the ONLY surviving Read-Host call.
    assert "Read-Host $Prompt" in s


def test_no_raw_read_host_press_enter_to_exit():
    """The Read-Host literal that caused Run T1.03's headless hang
    must NOT appear anywhere in the rendered installer outside the
    helper body."""
    s = _gen()
    assert 'Read-Host "Press Enter to exit"' not in s, (
        'rendered installer still contains raw Read-Host "Press Enter to exit" '
        '(Run T1.03 headless-hang regression)'
    )
    assert 'Read-Host "Press Enter to close this window"' not in s


def test_only_one_read_host_call_remains_in_executable_code():
    """The only surviving `Read-Host` call in EXECUTABLE code must be
    the one inside `Wait-ForUserIfInteractive`. Anything else is a new
    headless-hang code path. (Comments referencing Read-Host as a
    string don't count.)"""
    s = _executable_only(_gen())
    assert s.count("Read-Host") == 1, (
        f"expected exactly 1 executable Read-Host occurrence "
        f"(inside Wait-ForUserIfInteractive), got {s.count('Read-Host')} "
        f"-- a new prompt was added without the helper gate"
    )


def test_every_press_enter_prompt_uses_the_helper():
    """Every prompt that wants to pause for the operator must route
    through `Wait-ForUserIfInteractive`. Catches a regression where a
    new exit path drops in a raw Read-Host."""
    s = _executable_only(_gen())
    # `Wait-ForUserIfInteractive` should appear in many exit paths;
    # we only need the count to be > 1 here (the actual number drifts
    # as new error paths are added).
    count = s.count("Wait-ForUserIfInteractive")
    assert count >= 20, (
        f"expected many Wait-ForUserIfInteractive calls (the rendered installer "
        f"has dozens of exit paths); got {count}. Did a refactor drop the helper?"
    )


def test_close_this_window_prompt_uses_the_helper():
    """The final happy-path pause must also go through the helper.
    Otherwise the post-install file removal block + the wrapper's
    Start-Process -Wait would block on a real Read-Host."""
    s = _gen()
    assert (
        'Wait-ForUserIfInteractive -Prompt "Press Enter to close this window"'
    ) in s


# ── Phase 2.0 transient cleanup guarantee ────────────────────────────────


def test_phase_2_0_transient_cleanup_block_present():
    """Run T1.03 root cause: the rollback driver only reversed
    M-markers. When the abort happened before any M was set, the
    staging+payload\\new transients survived even though
    SUCCESSFUL_CLEAN_INSTALL_ROLLBACK was written. The Phase 2.0
    cleanup block fixes this."""
    s = _gen()
    assert "Phase 2.0 - pre-M-reverse transient cleanup" in s, (
        "Phase 2.0 transient cleanup block missing"
    )


def test_phase_2_0_cleans_all_documented_transients():
    """Architecture plan Section F lists the transients that must
    be wiped on any rejection. Phase 2.0 must enumerate the same
    set so a Stage 6B-abort run leaves a clean staging slate."""
    s = _gen()
    # Slice to the Phase 2.0 try block so we know we're matching
    # inside the new block (not in some unrelated location).
    start = s.index("Phase 2.0 - pre-M-reverse transient cleanup")
    end = s.index("# ---- Phase 2 - file reverse-rollback", start)
    block = s[start:end]
    for var in ("$PayloadNew", "$StagingExtracted", "$StagingRuntimeZip",
                "$StagingRuntimeManifest", "$StagingConfigNew"):
        assert var in block, (
            f"Phase 2.0 cleanup missing {var}; "
            f"Section F transient list incomplete"
        )
    # The cleanup uses Invoke-LogicalDelete (the existing helper) and
    # is guarded by Test-Path so non-existent paths are no-ops.
    assert "Invoke-LogicalDelete" in block
    assert "Test-Path -LiteralPath" in block


def test_phase_2_0_failure_writes_rollback_incomplete():
    """A failure inside Phase 2.0 (e.g. an open file handle that
    Invoke-LogicalDelete cannot defeat) must degrade the run to
    ROLLBACK_INCOMPLETE -- never silently fall through to
    SUCCESSFUL_CLEAN_INSTALL_ROLLBACK."""
    s = _gen()
    start = s.index("Phase 2.0 - pre-M-reverse transient cleanup")
    end = s.index("# ---- Phase 2 - file reverse-rollback", start)
    block = s[start:end]
    assert "ROLLBACK_INCOMPLETE" in block
    assert "MANUAL INTERVENTION REQUIRED" in block
    assert "PHASE: 2.0 (transient cleanup)" in block
    assert "exit 2" in block


def test_phase_2_0_runs_before_m_reverse_block():
    """Ordering is load-bearing. If Phase 2 M-reverse runs first
    and Phase 2.0 second, an exception in M-reverse could short-
    circuit the transient cleanup. Phase 2.0 must come first."""
    s = _gen()
    p20 = s.index("Phase 2.0 - pre-M-reverse transient cleanup")
    p2  = s.index("# ---- Phase 2 - file reverse-rollback")
    assert p20 < p2, "Phase 2.0 must precede Phase 2 M-reverse"


def test_phase_2_0_runs_before_rollback_result_write():
    """Defense-in-depth: the ROLLBACK_RESULT line MUST be written
    AFTER Phase 2.0. Otherwise a clean rollback claim could be made
    while transients are still on disk."""
    s = _gen()
    p20 = s.index("Phase 2.0 - pre-M-reverse transient cleanup")
    rb_write = s.index('"ROLLBACK_RESULT=$rbMode"')
    assert p20 < rb_write


# ── Section G.7 post-condition gate ──────────────────────────────────────


def test_clean_install_rollback_postcondition_gate_present():
    s = _gen()
    assert "Section G.7 post-condition verification" in s, (
        "G.7 post-condition gate missing"
    )


def test_clean_install_rollback_postcondition_enumerates_required_absent_set():
    """The gate must check every artifact Section G.7 says must
    be absent. A missing path here would let SUCCESSFUL_CLEAN_INSTALL_ROLLBACK
    slip through with that artifact still on disk."""
    s = _gen()
    start = s.index("Section G.7 post-condition verification")
    end = s.index('"ROLLBACK_RESULT=$rbMode"', start)
    gate = s[start:end]
    for var in ("$PayloadNew", "$StagingExtracted", "$StagingRuntimeZip",
                "$StagingRuntimeManifest", "$StagingConfigNew",
                "$StagingRollbackConfig"):
        assert var in gate, (
            f"G.7 post-condition gate missing {var}"
        )


def test_clean_install_rollback_postcondition_failure_degrades_to_incomplete():
    """If the gate finds any artifact still present, the run MUST
    write ROLLBACK_INCOMPLETE and exit 2, NOT SUCCESSFUL_CLEAN_INSTALL_ROLLBACK."""
    s = _gen()
    start = s.index("Section G.7 post-condition verification")
    end = s.index('"ROLLBACK_RESULT=$rbMode"', start)
    gate = s[start:end]
    assert "ROLLBACK_INCOMPLETE" in gate
    assert "G.7 post-condition verification" in gate
    assert "exit 2" in gate


def test_clean_install_rollback_only_for_clean_install_mode():
    """The gate is scoped to CLEAN_INSTALL specifically (the only
    mode Section G.7 says leaves everything absent). UPGRADE_RUNNING
    and UPGRADE_STOPPED post-conditions are different and are not
    in scope for this PR."""
    s = _gen()
    assert '$rbMode -ceq "SUCCESSFUL_CLEAN_INSTALL_ROLLBACK"' in s


# ── Manual-test wrapper sets CHARON_NONINTERACTIVE=1 ─────────────────────


def test_manual_test_wrapper_sets_charon_noninteractive():
    """02-run-installer.ps1 starts the rendered installer via
    Start-Process -Wait. Without CHARON_NONINTERACTIVE=1 the child's
    Wait-ForUserIfInteractive would fall back to UserInteractive,
    which on a foreground console is true -- exactly the Run T1.03
    hang scenario. The wrapper MUST set the env var so the helper
    becomes a no-op for the child."""
    from pathlib import Path
    repo_root = Path(__file__).resolve().parents[3]
    wrapper = repo_root / "windows-agent-v2-manual-test" / "02-run-installer.ps1"
    body = wrapper.read_text(encoding="utf-8")
    assert '$env:CHARON_NONINTERACTIVE = "1"' in body, (
        "02-run-installer.ps1 must set CHARON_NONINTERACTIVE=1 before "
        "Start-Process so the rendered installer's Wait-ForUserIfInteractive "
        "becomes a no-op (Run T1.03 hang fix)"
    )
    # The env var assignment must happen BEFORE the EXECUTABLE Start-Process
    # call (not just a comment mentioning it). We look at the call that
    # binds to `$proc` -- that's the one that spawns the rendered installer.
    env_set_idx = body.index('$env:CHARON_NONINTERACTIVE = "1"')
    sp_idx = body.index("$proc = Start-Process")
    assert env_set_idx < sp_idx, (
        "CHARON_NONINTERACTIVE must be set BEFORE the $proc = Start-Process call"
    )


# ── Cross-cutting invariants (must still hold after the headless fix) ────


def test_headless_fix_does_not_regress_agent_key_occurrence_count():
    """PR #89 invariant: the agent_key value must appear exactly
    once in the rendered installer (inside the $AgentKey literal).
    The Read-Host -> Wait-ForUserIfInteractive refactor MUST NOT
    add any debug echo / log line that re-introduces the key."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, REAL_SHAPE_KEY_FIXTURE, SAMPLE_BACKEND_URL,
    )
    assert body.count(REAL_SHAPE_KEY_FIXTURE) == 1


def test_headless_fix_does_not_regress_pr89_url_normalization():
    """PR #89 invariant: the rendered installer's $BackendUrl literal
    must be the normalized form, never with a trailing slash."""
    from app.api.v1.endpoints.agents import _windows_installer
    body = _windows_installer(
        SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, "https://staging.example.com/",
    )
    safe = _redact(body, SAMPLE_AGENT_KEY)
    assert "$BackendUrl = 'https://staging.example.com'" in safe
    assert "$BackendUrl = 'https://staging.example.com/'" not in safe
