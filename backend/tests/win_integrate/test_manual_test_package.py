"""Pytest mirror of `.github/workflows/windows-agent-manual-test-package.yml`.

Keeps the v4 package contract testable from the local
`pytest backend/tests/win_integrate/` loop as well as from CI.
Every assertion the workflow makes against the package tree has a
test here; an operator who edits a script in
`windows-agent-v2-manual-test/` should see a green / red status
without having to push and wait for GitHub Actions.

The package is greenfield in PR #5 — no prior contract to preserve.
Section L of Architecture Plan v11 is the source of truth.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_DIR = REPO_ROOT / "windows-agent-v2-manual-test"
OPS_SMOKE_LIST = REPO_ROOT / "ops" / "windows-runtime-bundle" / "runtime-smoke-imports.txt"


# ── Package layout sanity ────────────────────────────────────────────────


def test_package_directory_exists():
    assert PACKAGE_DIR.is_dir(), f"{PACKAGE_DIR} missing"


REQUIRED_FILES = (
    "00-README-START-HERE.txt",
    "01-preflight.ps1",
    "02-run-installer.ps1",
    "03-post-install-verify.ps1",
    "05-collect-diagnostics.ps1",
    "06-safe-cleanup.ps1",
    "SHA256SUMS.txt",
    "runtime-smoke-imports.txt",
    "test-config.example.json",
)


@pytest.mark.parametrize("name", REQUIRED_FILES)
def test_required_file_present(name):
    assert (PACKAGE_DIR / name).is_file(), f"{name} missing"


# ── SHA256SUMS.txt regenerable from tree (excluding itself) ───────────────


def test_sha256sums_regenerable_excluding_itself():
    expected = []
    for path in sorted(PACKAGE_DIR.iterdir()):
        if path.name == "SHA256SUMS.txt" or path.is_dir():
            continue
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        expected.append(f"{sha}  {path.name}")
    expected_text = "\n".join(expected) + "\n"
    actual = (PACKAGE_DIR / "SHA256SUMS.txt").read_text(encoding="utf-8")
    assert actual == expected_text, (
        f"SHA256SUMS.txt drift\n--- expected ---\n{expected_text}"
        f"\n--- actual ---\n{actual}"
    )


def test_sha256sums_does_not_list_itself():
    content = (PACKAGE_DIR / "SHA256SUMS.txt").read_text(encoding="utf-8")
    assert "  SHA256SUMS.txt" not in content


# ── README v4 contract ───────────────────────────────────────────────────


def test_readme_declares_v4_on_first_line():
    body = (PACKAGE_DIR / "00-README-START-HERE.txt").read_text(encoding="utf-8")
    assert body.split("\n", 1)[0] == "PACKAGE VERSION: v4"


def test_readme_rejects_legacy_versions():
    body = (PACKAGE_DIR / "00-README-START-HERE.txt").read_text(encoding="utf-8")
    assert "Do not use v1, v2, or v3" in body


@pytest.mark.parametrize("rule", [
    "Do not install Python manually",
    "Do not install winget manually",
    "Do not modify the system PATH",
    "Windows Agent installer provides its own private runtime",
    "HTTPS access only to the configured",
    "No direct access to python.org, PyPI, Microsoft Store",
])
def test_readme_contains_hard_rule(rule):
    body = (PACKAGE_DIR / "00-README-START-HERE.txt").read_text(encoding="utf-8")
    assert rule in body, f"hard rule missing: {rule!r}"


# ── 01-preflight.ps1 v4 contract ─────────────────────────────────────────


def test_preflight_emits_four_positive_report_lines():
    body = (PACKAGE_DIR / "01-preflight.ps1").read_text(encoding="utf-8")
    for line in (
        "Private Python runtime      : not installed",
        "Installer action            : private runtime will be downloaded and installed",
        "System Python required      : No",
        "winget required             : No",
    ):
        assert line in body, f"positive-report line missing: {line!r}"


def test_preflight_emits_precheck_result_lines():
    body = (PACKAGE_DIR / "01-preflight.ps1").read_text(encoding="utf-8")
    assert "PRECHECK_RESULT=PASS" in body
    assert "PRECHECK_RESULT=BLOCKED" in body


def test_preflight_has_no_python_or_winget_add_block():
    """Correction #11 + #32 — v4 must not re-introduce a Python /
    winget / Microsoft Store stub blocker."""
    body = (PACKAGE_DIR / "01-preflight.ps1").read_text(encoding="utf-8")
    pattern = re.compile(
        r"Add-Block.+(python|winget|microsoft\s*store)",
        re.IGNORECASE,
    )
    hit = pattern.search(body)
    assert hit is None, f"legacy preflight blocker re-emerged: {hit.group(0)!r}"


# ── 02-run-installer.ps1 — Section H landmarks + forbidden patterns ──────


REQUIRED_INSTALLER_LANDMARKS = (
    "Invoke-ProcessCaptured",
    "Invoke-HostInstall",
    "OldHostProcessSnapshot",
    "OldVerifiedChildPythonProcessSnapshot",
    "IsCanonicallyRestorable",
    "SERVICE_REGISTRATION_PROBE_INCONSISTENT",
    "REGISTRATION_NOT_CANONICALLY_RESTORABLE",
    "INCONSISTENT_LIVE_STATE",
    "UNRESOLVED_PREVIOUS_TRANSACTION",
    "SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING",
    "SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED",
    "SUCCESSFUL_CLEAN_INSTALL_ROLLBACK",
    "ROLLBACK_INCOMPLETE",
    "MANUAL INTERVENTION REQUIRED",
    "Stage 11.A/B/C",
    "Stage 11.D",
    "[11/11]",
    "[9/11]",
    "[2/11]",
)


@pytest.mark.parametrize("needle", REQUIRED_INSTALLER_LANDMARKS)
def test_installer_orchestrator_landmark_present(needle):
    body = (PACKAGE_DIR / "02-run-installer.ps1").read_text(encoding="utf-8")
    assert needle in body, f"landmark missing in 02-run-installer.ps1: {needle!r}"


FORBIDDEN_INSTALLER_PATTERNS = (
    r"\bcharon-agent-host\.exe\s+install\b",
    r"&\s*\$HostExe(Live|Bak|New)?\s+install\b",
    r"\$LASTEXITCODE",
    r"\bInvoke-Expression\b",
    r"\|\s*iex\b",
    r"SECURELY DELETE",
    r"secure[ -]erase",
    r"\bsc\.exe\s+(create|delete|failure)\b",
    r"\bStart-Service\b",
    r"\bStop-Service\b",
    r"\bExpand-Archive\b",
    r"compatible_host_(versions|semver)\b",
    r"\bSemVer\b",
    r"Sysinternals\b",
    r"\bhandle\.exe\b",
    r"config\.env\.failed-",
    r"winget\s+install",
    r"\bGet-Command\s+python\b",
    r"\$env:Path\s*\+=",
)


def _executable_lines(body: str) -> str:
    """Strip PS-comment lines so commentary about a forbidden pattern
    doesn't trip its own ban (mirrors the workflow's grep filter)."""
    return "\n".join(
        line for line in body.split("\n")
        if not line.lstrip().startswith("#")
    )


@pytest.mark.parametrize("pattern", FORBIDDEN_INSTALLER_PATTERNS)
def test_installer_orchestrator_forbidden_pattern_absent(pattern):
    body = (PACKAGE_DIR / "02-run-installer.ps1").read_text(encoding="utf-8")
    executable = _executable_lines(body)
    hit = re.search(pattern, executable)
    assert hit is None, \
        f"forbidden pattern present in executable lines: {pattern} -> {hit.group(0)!r}"


def test_installer_orchestrator_pip_install_requires_no_index():
    body = (PACKAGE_DIR / "02-run-installer.ps1").read_text(encoding="utf-8")
    executable = _executable_lines(body)
    for m in re.finditer(r"\bpip\s+install\b[^\n]*", executable):
        assert "--no-index" in m.group(0), \
            f"pip install without --no-index: {m.group(0)!r}"


# ── 03-post-install-verify.ps1 — private runtime + 11.C ─────────────────


REQUIRED_VERIFIER_LANDMARKS = (
    r"C:\ProgramData\NetManagerAgent",
    r"payload\current\runtime\python\python.exe",
    r"payload\current\metadata\runtime-smoke-imports.txt",
    "Invoke-ProcessCaptured",
    "RUNTIME_OK",
    '"status","--service-name"',
    "Get-CimInstance Win32_Service",
    "--display-name",
    "--child-exe",
    "--child-arg",
    "--work-dir",
    "--env-file",
    "--log-dir",
    "--service-account",
    "LocalSystem",
    "POST_INSTALL_RESULT=PASS",
)


@pytest.mark.parametrize("needle", REQUIRED_VERIFIER_LANDMARKS)
def test_post_install_verifier_landmark_present(needle):
    body = (PACKAGE_DIR / "03-post-install-verify.ps1").read_text(encoding="utf-8")
    assert needle in body, f"verifier landmark missing: {needle!r}"


# ── 05-collect-diagnostics.ps1 — secret-bearing exclusions ──────────────


@pytest.mark.parametrize("needle", [
    'config.env"',
    'config.env.bak"',
    'config.env.new"',
    'rollback-config.failed"',
    "proc-capture",
])
def test_diagnostics_excludes_secret_bearing_path(needle):
    body = (PACKAGE_DIR / "05-collect-diagnostics.ps1").read_text(encoding="utf-8")
    assert needle in body, f"diagnostics missing exclusion: {needle!r}"


# ── 06-safe-cleanup.ps1 — wipe targets + forbid Start/Stop-Service / sc.exe ──


@pytest.mark.parametrize("needle", [
    r"$InstallDir\payload",
    r"$InstallDir\staging",
    r"$InstallDir\bin",
    r"$InstallDir\config.env",
    r"$InstallDir\config.env.bak",
    r"$InstallDir\staging\rollback-config.failed",
])
def test_safe_cleanup_includes_wipe_target(needle):
    body = (PACKAGE_DIR / "06-safe-cleanup.ps1").read_text(encoding="utf-8")
    assert needle in body, f"safe-cleanup missing wipe target: {needle!r}"


def test_safe_cleanup_does_not_use_start_stop_service_or_sc():
    body = (PACKAGE_DIR / "06-safe-cleanup.ps1").read_text(encoding="utf-8")
    executable = _executable_lines(body)
    assert "Start-Service" not in executable
    assert "Stop-Service" not in executable
    assert not re.search(r"\bsc\.exe\b", executable)


# ── Smoke list byte-identical to ops/ ───────────────────────────────────


def test_smoke_list_byte_identical_to_ops():
    pkg = (PACKAGE_DIR / "runtime-smoke-imports.txt").read_bytes()
    ops = OPS_SMOKE_LIST.read_bytes()
    assert pkg == ops, "package smoke list drifted from ops/"


def test_smoke_list_canonical_103_bytes_no_bom_no_cr():
    data = (PACKAGE_DIR / "runtime-smoke-imports.txt").read_bytes()
    assert len(data) == 103, f"smoke list size {len(data)} != 103"
    assert not data.startswith(b"\xef\xbb\xbf")
    assert b"\r" not in data


# ── ASCII-safe doctrine ─────────────────────────────────────────────────


@pytest.mark.parametrize("name", REQUIRED_FILES)
def test_package_file_is_ascii_only(name):
    path = PACKAGE_DIR / name
    data = path.read_bytes()
    non_ascii = sorted({b for b in data if b > 0x7F})
    assert non_ascii == [], (
        f"{name}: non-ASCII bytes {[hex(b) for b in non_ascii]}"
    )


# ── No real agent key shape anywhere ────────────────────────────────────


def test_test_config_example_uses_change_me_placeholders():
    body = (PACKAGE_DIR / "test-config.example.json").read_text(encoding="utf-8")
    assert '"agent_id": "CHANGE-ME-AGENT-ID"' in body
    assert '"agent_key": "CHANGE-ME-AGENT-KEY"' in body


def test_no_real_shape_agent_key_in_ps_files():
    """Any PowerShell file that literally assigns an `agent_key=` token
    of 8+ alphanum chars is a leak. The reference shape allowed is the
    placeholder `CHANGE-ME-AGENT-KEY` which starts with non-alphanum
    `-` after CHANGE."""
    pattern = re.compile(r"\bagent[_-]?key\s*=\s*\"[A-Za-z0-9_-]{8,}", re.IGNORECASE)
    for ps in PACKAGE_DIR.glob("*.ps1"):
        body = ps.read_text(encoding="utf-8")
        # CHANGE-ME-AGENT-KEY pattern is exempted because it's an
        # explicit placeholder rather than a real key.
        for m in pattern.finditer(body):
            assert "CHANGE-ME" in m.group(0), \
                f"{ps.name}: agent_key literal {m.group(0)!r}"
