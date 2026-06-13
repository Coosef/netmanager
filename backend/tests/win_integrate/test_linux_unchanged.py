"""Linux installer regression seat-belt — PR #1 edition.

PR #1 ships only the pure-Python foundation. It MUST NOT touch any
code that affects the Linux installer flow. The full byte-equal
golden assertion lives in PR #2; here we enforce the smaller
invariant: PR #1's foundation tree contains no edit to
`backend/app/api/v1/endpoints/agents.py` and no edit to any other
file referenced from Linux's installer path.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]

# Files that PR #1 (and PR #1 only) is forbidden to modify.
LINUX_TOUCHPOINTS = (
    "backend/app/api/v1/endpoints/agents.py",
    # Pre-existing Windows installer / host tests — PR #1 doesn't touch
    # them; they continue to pass as-is.
    "backend/tests/win_integrate/test_windows_installer.py",
    "backend/tests/win_integrate/test_host_binary_endpoint.py",
    "backend/tests/win_integrate/test_host_endpoint_http.py",
    "backend/tests/win_integrate/test_linux_isolation.py",
)


def _git_diff_main() -> set[str]:
    """Set of repository-relative paths changed vs origin/main."""
    try:
        out = subprocess.check_output(
            ["git", "diff", "--name-only", "origin/main...HEAD"],
            cwd=REPO_ROOT,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip("git diff vs origin/main not available")
    return {line.strip() for line in out.splitlines() if line.strip()}


def test_pr1_does_not_touch_linux_touchpoints():
    changed = _git_diff_main()
    for path in LINUX_TOUCHPOINTS:
        assert path not in changed, (
            f"PR #1 must not modify {path}; that change belongs in a "
            f"later PR. PR #1 ships only the pure-Python foundation."
        )


def test_pr1_does_not_touch_manual_test_package():
    changed = _git_diff_main()
    for path in changed:
        assert not path.startswith("windows-agent-v2-manual-test/"), (
            f"PR #1 must not modify {path}; manual test package edits "
            f"belong to PR #5."
        )


def test_pr1_does_not_touch_installer_generator():
    """`_windows_installer()` lives in agents.py:1992; it is refactored
    in PR #3. PR #1 doesn't touch agents.py at all."""
    changed = _git_diff_main()
    assert "backend/app/api/v1/endpoints/agents.py" not in changed
