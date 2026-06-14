"""Passive documentation shape tests for the Windows Agent V2
manual validation plan + execution report template.

This is a DOCUMENTATION-ONLY PR. The tests below are pure-Python
file-content shape checks: no code execution, no installer run, no
VPS contact, no flag flip. The goal is to keep the plan + the
operator-fill template in sync with the v4 baseline and to catch
drift before a human operator reads a stale path or stale artifact
name.

What the tests pin:

  - Plan + template files exist at the expected paths.
  - The plan declares it is staging-only (NOT a production rollout).
  - The plan references the correct v4 artifact ZIP filename.
  - The plan references all five v4 operator script names verbatim.
  - The plan references the test-config CHANGE-ME-* placeholder
    tokens (so the document doesn't silently teach operators to
    paste real keys).
  - The plan promises WINDOWS_AGENT_V2_ENABLED stays False before /
    during / after the plan.
  - The plan promises the Linux byte-equal golden is not affected.
  - The plan references the post-PR-#87 main baseline SHA.
  - The plan + template have no real-shape agent key embedded.
  - Both documents are ASCII-only (matches the project's locale-
    independent doctrine).
  - The execution report template covers every script the plan
    expects the operator to run, and asks for redacted-only fields
    (no production secret in the report).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
PLAN_PATH = REPO_ROOT / "docs" / "WINDOWS_AGENT_V2_MANUAL_VALIDATION_PLAN.md"
TEMPLATE_PATH = (
    REPO_ROOT
    / "windows-agent-v2-manual-test"
    / "EXECUTION_REPORT_TEMPLATE.md"
)

V4_ARTIFACT_ZIP = "windows-agent-v2-manual-test-v4.zip"
V4_SCRIPTS = (
    "01-preflight.ps1",
    "02-run-installer.ps1",
    "03-post-install-verify.ps1",
    "05-collect-diagnostics.ps1",
    "06-safe-cleanup.ps1",
)
PLACEHOLDERS = ("CHANGE-ME-AGENT-ID", "CHANGE-ME-AGENT-KEY")
LINUX_GOLDEN = (
    "889654588f35eef1d5e43208840078ed6394aecfeeec6c15544c39342f5d5442"
)
MAIN_BASELINE_SHA = "646ff665cda0fc01a7aa12e7c2ee825a7ed3916e"


# ── Files exist ──────────────────────────────────────────────────────────


def test_plan_file_exists():
    assert PLAN_PATH.is_file(), f"{PLAN_PATH} missing"


def test_template_file_exists():
    assert TEMPLATE_PATH.is_file(), f"{TEMPLATE_PATH} missing"


# ── Staging-only doctrine ────────────────────────────────────────────────


def test_plan_declares_staging_only():
    """Plan must explicitly state it is NOT a production rollout
    document. A reader skimming the first page must see this."""
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert "STAGING" in body or "Staging Only" in body
    # The exact phrase appears in the document blockquote.
    assert "NOT a production rollout" in body, \
        "plan must blockquote `NOT a production rollout`"


def test_plan_states_no_flag_flip():
    body = PLAN_PATH.read_text(encoding="utf-8")
    # WINDOWS_AGENT_V2_ENABLED must remain False before/during/after.
    assert "WINDOWS_AGENT_V2_ENABLED" in body
    assert re.search(
        r"`?WINDOWS_AGENT_V2_ENABLED`?[^.]{0,40}(False|stays?\s+False|does NOT flip)",
        body,
    ), "plan must promise WINDOWS_AGENT_V2_ENABLED stays False"


def test_plan_states_no_production_secret():
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert re.search(
        r"(no production secret|production secrets|production-tagged)",
        body, re.IGNORECASE,
    )


def test_plan_states_no_vps_no_deploy_no_installer_execution():
    """The plan must call out the non-actions explicitly so an
    operator cannot misinterpret it as a deploy approval."""
    body = PLAN_PATH.read_text(encoding="utf-8")
    for needle in (
        "NOT a production rollout",
        "NOT a deploy approval",
        "NOT a flag-flip rehearsal",
    ):
        assert needle in body, f"plan missing non-action statement: {needle!r}"


def test_plan_references_main_baseline_sha():
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert MAIN_BASELINE_SHA in body, \
        f"plan must reference main baseline SHA {MAIN_BASELINE_SHA}"


def test_plan_references_linux_golden_sha():
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert LINUX_GOLDEN in body, \
        f"plan must reference the Linux installer golden SHA {LINUX_GOLDEN}"


# ── v4 artifact + script references ─────────────────────────────────────


def test_plan_references_correct_artifact_name():
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert V4_ARTIFACT_ZIP in body, \
        f"plan must reference {V4_ARTIFACT_ZIP}"
    # A drift to v3 / v5 would be silently confusing -- guard.
    for wrong in ("windows-agent-v2-manual-test-v3.zip",
                  "windows-agent-v2-manual-test-v5.zip"):
        assert wrong not in body, f"plan references wrong artifact: {wrong}"


@pytest.mark.parametrize("script", V4_SCRIPTS)
def test_plan_references_v4_script_name(script):
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert script in body, f"plan does not reference {script}"


@pytest.mark.parametrize("script", V4_SCRIPTS)
def test_template_references_v4_script_name(script):
    body = TEMPLATE_PATH.read_text(encoding="utf-8")
    assert script in body, f"template does not reference {script}"


@pytest.mark.parametrize("placeholder", PLACEHOLDERS)
def test_plan_references_change_me_placeholder(placeholder):
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert placeholder in body, \
        f"plan must reference placeholder {placeholder}"


# ── 11 sections present ─────────────────────────────────────────────────


REQUIRED_PLAN_SECTIONS = (
    "## 1. Purpose and Scope",
    "## 2. Prerequisites",
    "## 3. Test Matrix",
    "## 4. Preflight Checklist",
    "## 5. Manual Execution Flow",
    "## 6. Expected Successful Results",
    "## 7. Failure Classes",
    "## 8. Evidence Collection",
    "## 9. Rollback / Safe Cleanup",
    "## 10. Go / No-Go Criteria",
    "## 11. Execution Report Template",
)


@pytest.mark.parametrize("header", REQUIRED_PLAN_SECTIONS)
def test_plan_has_section_header(header):
    body = PLAN_PATH.read_text(encoding="utf-8")
    assert header in body, f"plan missing required section header: {header!r}"


# ── Execution report template covers every plan-mandated field ──────────


REQUIRED_TEMPLATE_FIELDS = (
    "Run ID",
    "Test date",
    "Operator name",
    "Reviewer name",
    "OS name",
    "OS build",
    "PowerShell version",
    "Backend URL type",
    "v4 artifact",
    "SHA-256",
    "PRECHECK_RESULT=PASS",
    "POST_INSTALL_RESULT=PASS",
    "Diagnostics ZIP",
    "Failure class",
    "Final decision",
    "Reviewer counter-signature",
)


@pytest.mark.parametrize("field", REQUIRED_TEMPLATE_FIELDS)
def test_template_has_required_field(field):
    body = TEMPLATE_PATH.read_text(encoding="utf-8")
    assert field in body, f"template missing required field: {field!r}"


def test_template_includes_production_non_touch_attestation():
    body = TEMPLATE_PATH.read_text(encoding="utf-8")
    # The verbatim attestation from Section 9.3 of the plan.
    assert "did NOT contact the production NetManager backend" in body
    assert "did NOT flip" in body
    assert "production secrets storage" in body
    assert "production-tagged" in body


def test_template_includes_hard_stop_checklist():
    body = TEMPLATE_PATH.read_text(encoding="utf-8")
    # Every Section 10.4 plan trigger appears as a check-box row.
    for trigger in (
        "leaked a secret-bearing path",
        "Production `WINDOWS_AGENT_V2_ENABLED`",
        "Linux byte-equal golden drifted",
        "contacted the production NetManager backend",
        "`ROLLBACK_INCOMPLETE`",
        "Production secret was found",
    ):
        assert trigger in body, \
            f"template hard-STOP row missing trigger: {trigger!r}"


# ── No real-shape secret in either document ─────────────────────────────


_AGENT_KEY_SHAPE = re.compile(
    r"\bagent[_-]?key\s*[=:\"]\s*\"?([A-Za-z0-9]{20,})\"?",
    re.IGNORECASE,
)


@pytest.mark.parametrize("path", [PLAN_PATH, TEMPLATE_PATH])
def test_doc_has_no_real_shape_agent_key(path):
    body = path.read_text(encoding="utf-8")
    for match in _AGENT_KEY_SHAPE.finditer(body):
        token = match.group(1)
        assert (
            "CHANGE-ME" in token.upper()
            or token == "STAGING-KEY-REDACTED"
            or "REDACTED" in token.upper()
            or "X" * 8 in token.upper()
        ), f"{path.name}: real-shape agent key literal {token!r}"


# ── ASCII-only doctrine ─────────────────────────────────────────────────


@pytest.mark.parametrize("path", [PLAN_PATH, TEMPLATE_PATH])
def test_doc_is_ascii_only(path):
    """The locale-independent doctrine that governs the v4 scripts +
    workflows extends to the documentation they reference. A smart
    quote or em-dash in the plan would be a tripwire for an operator
    on a Turkish / German Windows console."""
    data = path.read_bytes()
    non_ascii = sorted({b for b in data if b > 0x7F})
    assert non_ascii == [], (
        f"{path.name}: non-ASCII bytes {[hex(b) for b in non_ascii]}"
    )


# ── SHA256SUMS regenerated to include the new template ─────────────────


def test_sha256sums_includes_execution_report_template():
    pkg = REPO_ROOT / "windows-agent-v2-manual-test"
    sha256sums = (pkg / "SHA256SUMS.txt").read_text(encoding="utf-8")
    assert "  EXECUTION_REPORT_TEMPLATE.md" in sha256sums, (
        "SHA256SUMS.txt does not list EXECUTION_REPORT_TEMPLATE.md; "
        "regenerate with: "
        "cd windows-agent-v2-manual-test && for f in $(ls | grep -v "
        "'^SHA256SUMS.txt$' | sort); do printf '%s  %s\\n' "
        "\"$(sha256sum \"$f\" | awk '{print $1}')\" \"$f\"; done "
        "> SHA256SUMS.txt"
    )


# ── Plan references the right operator-script package ──────────────────


def test_plan_links_use_relative_paths_to_repo_files():
    """Operator browsing the plan on GitHub must be able to click
    every referenced file. Plan uses ../-prefixed relative links
    from docs/."""
    body = PLAN_PATH.read_text(encoding="utf-8")
    # Spot-check: every reference to the manual-test directory uses
    # the relative ../windows-agent-v2-manual-test/ form.
    assert "../windows-agent-v2-manual-test/" in body
    # And references to backend code likewise.
    assert "../backend/" in body


def test_plan_links_have_no_absolute_filesystem_paths():
    body = PLAN_PATH.read_text(encoding="utf-8")
    # An accidental `/Users/.../netmanager/...` in a markdown link
    # would leak the author's home directory; refuse.
    assert not re.search(r"/Users/[A-Za-z0-9._-]+/", body)
    assert not re.search(r"C:\\\\Users\\\\[A-Za-z0-9._-]+\\\\", body)
