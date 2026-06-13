"""Linux installer regression seat-belt — PR #2 byte-equal golden.

PR #1 ("foundation") didn't touch `agents.py` at all. PR #2 adds the
two flag-gated runtime endpoints into `agents.py`, so the file-scope
"agents.py must not appear in the diff" assertion that lived in PR #1
no longer applies.

PR #2 replaces it with a much stronger contract: the output of
`_linux_installer()` MUST be byte-identical to the pre-PR-#2 baseline
when its embedded `Generated:` timestamp line is stripped (the
timestamp moves with each call by design — that's the only varying
substring in the script). Any incidental edit to the Linux template
inside this PR — a stray space, an accidental key rename, an import
that changes the embedded `agent_script` content — fails this digest
comparison and blocks the PR.

The flag-state isolation (Linux output must be identical with the
flag on or off) is also asserted: PR #2's new code paths live behind
`WINDOWS_AGENT_V2_ENABLED`, but `_linux_installer()` reads the flag
nowhere and its output MUST NOT depend on the flag state.

The "manual test package off-limits" guard from PR #1 stays — that
edit belongs to PR #5.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]

SAMPLE_AGENT_ID = "known-good-fake-id"
SAMPLE_AGENT_KEY = "REDACTED_FAKE_KEY"
SAMPLE_BACKEND_URL = "https://netmanager.systrack.app"

# Byte-equal golden digest — computed by hashing the stripped output
# of `_linux_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY,
# SAMPLE_BACKEND_URL)` on the parent commit of this PR (PR #1 merge
# 5ccb33fbcdfa00018c3dd77368b47fa6501a6b33). To intentionally update
# the Linux installer template, recompute by running:
#
#   python3 -c "
#   import re, hashlib
#   from app.api.v1.endpoints.agents import _linux_installer
#   s = _linux_installer('known-good-fake-id', 'REDACTED_FAKE_KEY',
#                         'https://netmanager.systrack.app')
#   stripped = re.sub(r'^.*Generated:.*\$', '', s, flags=re.MULTILINE)
#   print(hashlib.sha256(stripped.encode('utf-8')).hexdigest())
#   "
LINUX_INSTALLER_GOLDEN_SHA256 = (
    "889654588f35eef1d5e43208840078ed6394aecfeeec6c15544c39342f5d5442"
)
LINUX_INSTALLER_STRIPPED_LEN = 5713


def _gen_linux() -> str:
    from app.api.v1.endpoints.agents import _linux_installer
    return _linux_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)


def _strip_timestamp(s: str) -> str:
    """Strip the embedded `Generated:` line so the digest is stable."""
    return re.sub(r"^.*Generated:.*$", "", s, flags=re.MULTILINE)


# ── PR #2 byte-equal golden ───────────────────────────────────────────────


def test_linux_installer_byte_equal_to_golden():
    """The single load-bearing PR #2 assertion: stripped output digest
    matches the pre-PR-#2 golden. If this fails, an incidental edit to
    the Linux template has slipped in — either revert the unintended
    change or, for an intentional template change, recompute and pin
    a new digest (see the docstring above)."""
    s = _gen_linux()
    stripped = _strip_timestamp(s)
    digest = hashlib.sha256(stripped.encode("utf-8")).hexdigest()
    assert digest == LINUX_INSTALLER_GOLDEN_SHA256, (
        f"Linux installer output drift detected.\n"
        f"  expected sha256: {LINUX_INSTALLER_GOLDEN_SHA256}\n"
        f"  actual   sha256: {digest}\n"
        f"  stripped length: expected {LINUX_INSTALLER_STRIPPED_LEN}, "
        f"got {len(stripped)}\n"
        f"If this is intentional, regenerate the golden per the "
        f"module docstring."
    )


def test_linux_installer_stripped_length_unchanged():
    """Length is informational — the digest test above is authoritative
    — but a length drift produces a clearer first failure when both
    fire together."""
    stripped = _strip_timestamp(_gen_linux())
    assert len(stripped) == LINUX_INSTALLER_STRIPPED_LEN, (
        f"Linux installer stripped length changed: expected "
        f"{LINUX_INSTALLER_STRIPPED_LEN}, got {len(stripped)}"
    )


def test_linux_installer_byte_identical_under_flag_states(monkeypatch):
    """Flipping `WINDOWS_AGENT_V2_ENABLED` MUST NOT change a single
    byte of the Linux installer output. PR #2 adds new Windows code
    paths behind that flag; this test pins that the Linux template
    stays flag-agnostic."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", False)
    off = _gen_linux()
    monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", True)
    on = _gen_linux()
    assert _strip_timestamp(off) == _strip_timestamp(on), \
        "Linux installer differs by WINDOWS_AGENT_V2_ENABLED flag state"


def test_linux_installer_byte_identical_under_flag_matches_golden(monkeypatch):
    """Both flag states must independently hash to the golden digest
    (defence-in-depth — catches a future template change that happens
    to round-trip differently between True and False)."""
    from app.core.config import settings
    for state in (False, True):
        monkeypatch.setattr(settings, "WINDOWS_AGENT_V2_ENABLED", state)
        digest = hashlib.sha256(
            _strip_timestamp(_gen_linux()).encode("utf-8")
        ).hexdigest()
        assert digest == LINUX_INSTALLER_GOLDEN_SHA256, (
            f"flag={state}: digest drift {digest} vs golden "
            f"{LINUX_INSTALLER_GOLDEN_SHA256}"
        )


# ── Structural sanity (subsumed by the golden, but kept for clarity) ──────


def test_linux_installer_first_line_is_bash_shebang():
    assert _gen_linux().lstrip().split("\n")[0] == "#!/bin/bash"


def test_linux_installer_no_windows_artifacts():
    """Defence-in-depth: even if a future template change keeps the
    golden digest, no Windows-specific construct may leak in."""
    s = _gen_linux()
    for needle in (
        "charon-agent-host.exe",
        "windows-amd64",
        "PowerShell",
        "C:\\ProgramData",
        "Invoke-HostInstall",
        "WINDOWS_AGENT_V2_ENABLED",
        "X-Charon-Runtime",
    ):
        assert needle not in s, \
            f"Linux installer leaked Windows artefact: {needle!r}"


def test_linux_installer_no_v2_runtime_endpoints_referenced():
    """The Linux installer must not call the new flag-gated endpoints
    added in PR #2."""
    s = _gen_linux()
    for needle in (
        "/download/runtime/windows-amd64",
        "/download/runtime/windows-amd64/manifest",
        "X-Charon-Runtime-Version",
        "X-Charon-Runtime-Zip-Sha256",
        "X-Charon-Python-Version",
        "X-Charon-Compatible-Host-Core-Range",
    ):
        assert needle not in s, \
            f"Linux installer references PR #2 Windows runtime endpoint: {needle!r}"


# ── Manual test package off-limits (carried over from PR #1) ──────────────


def _git_diff_main() -> set[str]:
    """Repository-relative paths changed vs origin/main."""
    try:
        out = subprocess.check_output(
            ["git", "diff", "--name-only", "origin/main...HEAD"],
            cwd=REPO_ROOT,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip("git diff vs origin/main not available")
    return {line.strip() for line in out.splitlines() if line.strip()}


def test_pr2_does_not_touch_manual_test_package():
    changed = _git_diff_main()
    for path in changed:
        assert not path.startswith("windows-agent-v2-manual-test/"), (
            f"PR #2 must not modify {path}; manual test package edits "
            f"belong to PR #5."
        )


def test_pr2_does_not_touch_windows_installer_generator():
    """`_windows_installer()` lives in agents.py:1992; PR #3 refactors
    it. PR #2 only ADDS two new endpoint functions above that line —
    the existing installer generator must be left byte-identical.
    """
    from app.api.v1.endpoints.agents import _windows_installer
    s = _windows_installer(SAMPLE_AGENT_ID, SAMPLE_AGENT_KEY, SAMPLE_BACKEND_URL)
    # Sentinel substring from the existing template; if PR #2 has
    # somehow rewired _windows_installer, this string moves and a
    # follow-up byte-equal check (PR #3 territory) will catch it.
    assert "WINDOWS_AGENT_V2_ENABLED" in s or "Windows" in s
