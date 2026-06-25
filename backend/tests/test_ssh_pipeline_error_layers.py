"""SSH Error Classification v1 (2026-06-25) — runtime behavior pins.

Background
----------
Device 96 fetch-info 502 ROOT CAUSE AUDIT (P0.2.2 follow-on, 2026-06-24)
surfaced two complementary opaque layers:

  1. Backend's `fetch-info` endpoint collapses every agent SSH failure
     into `HTTPException(502, detail=f"SSH error: {result.error}")`.
  2. The agent's `_ssh_command` returned the failure via a catch-all
     `except Exception as e: return {"success": False, "error": str(e)}`,
     so the upstream `result.error` carried no layer signal.

The compounded effect: operator sees "SSH error: Failed to enter enable
mode" or "SSH error: <opaque netmiko text>" as a 502 toast with no
machine-readable hint about which transport / handshake / auth stage
failed. The Device 96 audit specifically could not differentiate the
27/27 failures across three latency buckets (120ms FAST / 450ms BANNER /
1700ms LATE) — each could be a different layer.

This PR (SSH Error Classification v1) introduces a pure classifier
`_classify_ssh_exception(exc, msg=...)` in the agent script that
deterministically maps a netmiko / socket / generic exception to one
of six canonical layer codes. The classifier is applied ONLY to
`_ssh_command`; this is the load-bearing call path for `fetch-info`.
Other paths (`_ssh_test`, `_ssh_config`, `_ssh_command_stream_sync`)
are intentionally left untouched to keep the diff minimal — they each
have their own audit follow-ups.

Test strategy
-------------
The agent script is not importable as a Python module — its top-level
contains argparse, WebSocket init, and signal handlers that would
fire on import. Existing tests (QF-5, HF#10A, HF#11, HF#12) work around
this by reading the file and using `ast.parse` for source-level
assertions. **Per operator directive for v1, this file goes one step
further: extract the classifier function bodies via ast.get_source_segment
and exec them into a controlled namespace pre-loaded with the netmiko
exception classes. That gives us real runtime behavior pinning — the
mapping for each exception class is exercised against the actual
classifier code, not against a regex over the source text.**

The classifier is by design side-effect-free (no I/O, no `time.time`,
no pool access), so this slice-and-exec approach is clean and stable.
"""
from __future__ import annotations

import ast
import socket
from pathlib import Path
from typing import Any

import pytest
from netmiko.exceptions import (
    NetmikoAuthenticationException,
    NetmikoTimeoutException,
)

try:
    from netmiko.exceptions import ReadTimeout as _NetmikoReadTimeout
except Exception:  # pragma: no cover — older netmiko
    _NetmikoReadTimeout = None  # type: ignore[assignment]


AGENT_SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent
    / "agent_script"
    / "netmanager_agent.py"
)


def _agent_source() -> str:
    return AGENT_SCRIPT_PATH.read_text()


def _extract_classifier_namespace() -> dict[str, Any]:
    """Slice the classifier-related symbols out of the agent script and
    exec them into a fresh namespace pre-loaded with the netmiko
    exception classes the classifier resolves against.

    Symbols extracted:
      - constants: _SSH_LAYER_CODES, _ENABLE_FAIL_SIGNS, _PROMPT_FAIL_SIGNS
      - functions: _redact_secrets, _classify_ssh_exception

    The namespace is seeded with NetmikoAuthenticationException /
    NetmikoTimeoutException / NetmikoReadTimeout under the EXACT names
    the agent script's classifier references (the agent imports them
    at top level with those identifiers). This means a future rename
    in the agent script will fail this extraction step loud and clear.
    """
    src = _agent_source()
    tree = ast.parse(src)

    wanted_assigns = {"_SSH_LAYER_CODES", "_ENABLE_FAIL_SIGNS", "_PROMPT_FAIL_SIGNS"}
    wanted_funcs = {"_redact_secrets", "_classify_ssh_exception"}

    sliced_pieces: list[str] = []
    found_assigns: set[str] = set()
    found_funcs: set[str] = set()

    for node in tree.body:
        if isinstance(node, ast.Assign):
            # Module-level constant tuple literal.
            targets = [
                t.id for t in node.targets if isinstance(t, ast.Name)
            ]
            for t in targets:
                if t in wanted_assigns:
                    seg = ast.get_source_segment(src, node)
                    assert seg, f"Could not extract source for {t}"
                    sliced_pieces.append(seg)
                    found_assigns.add(t)
        elif isinstance(node, ast.FunctionDef):
            if node.name in wanted_funcs:
                seg = ast.get_source_segment(src, node)
                assert seg, f"Could not extract source for {node.name}"
                sliced_pieces.append(seg)
                found_funcs.add(node.name)

    # If a downstream refactor removes a symbol, the test gets a useful
    # message instead of an opaque NameError later.
    assert wanted_assigns <= found_assigns, (
        f"Missing classifier constants in agent script: "
        f"{sorted(wanted_assigns - found_assigns)}"
    )
    assert wanted_funcs <= found_funcs, (
        f"Missing classifier functions in agent script: "
        f"{sorted(wanted_funcs - found_funcs)}"
    )

    namespace: dict[str, Any] = {
        "__name__": "extracted_classifier",
        # Pre-seed with the netmiko exception classes under the EXACT
        # identifiers the classifier references. Resilient against
        # NetmikoReadTimeout being None on older netmiko releases.
        "NetmikoAuthenticationException": NetmikoAuthenticationException,
        "NetmikoTimeoutException": NetmikoTimeoutException,
        "NetmikoReadTimeout": _NetmikoReadTimeout,
    }
    code = "\n\n".join(sliced_pieces)
    exec(compile(code, str(AGENT_SCRIPT_PATH), "exec"), namespace)
    return namespace


# Module-scoped fixture so exec only runs once per pytest session — the
# classifier code does not mutate global state, so test isolation is
# preserved by re-using the namespace.
@pytest.fixture(scope="module")
def classifier_ns() -> dict[str, Any]:
    return _extract_classifier_namespace()


# ─── 1. Layer enumeration pin ──────────────────────────────────────────


def test_canonical_layer_codes_set(classifier_ns: dict[str, Any]) -> None:
    """The six canonical layer codes are EXACTLY what the operator
    specified in the v1 brief. A future widening must be deliberate
    (this test catches both addition and removal)."""
    expected = (
        "AUTH_FAILED",
        "CONNECTION_TIMEOUT",
        "CONNECTION_RESET",
        "ENABLE_MODE_FAILED",
        "PROMPT_OR_COMMAND_FAILED",
        "UNKNOWN",
    )
    assert classifier_ns["_SSH_LAYER_CODES"] == expected


# ─── 2. Exception-class → layer-code mapping (RUNTIME, not source-string) ─


def test_netmiko_authentication_exception_maps_to_auth_failed(
    classifier_ns: dict[str, Any],
) -> None:
    classify = classifier_ns["_classify_ssh_exception"]
    layer, detail = classify(
        NetmikoAuthenticationException("auth failure on the device"),
        msg={},
    )
    assert layer == "AUTH_FAILED"
    # Detail preserves the diagnostic text (with secrets redacted via
    # _redact_secrets; empty msg means no secrets to redact).
    assert "auth failure" in detail


def test_netmiko_timeout_exception_maps_to_connection_timeout(
    classifier_ns: dict[str, Any],
) -> None:
    classify = classifier_ns["_classify_ssh_exception"]
    layer, detail = classify(
        NetmikoTimeoutException("Connection timed out after 30s"),
        msg={},
    )
    assert layer == "CONNECTION_TIMEOUT"
    assert "30s" in detail


def test_connection_reset_error_maps_to_connection_reset(
    classifier_ns: dict[str, Any],
) -> None:
    classify = classifier_ns["_classify_ssh_exception"]
    layer, _ = classify(ConnectionResetError("Connection reset by peer"), msg={})
    assert layer == "CONNECTION_RESET"


def test_connection_refused_error_grouped_as_connection_reset(
    classifier_ns: dict[str, Any],
) -> None:
    """Per the v1 design doc: TCP refused is operationally a 'device
    side terminated the attempt' signal — group under CONNECTION_RESET
    rather than minting a separate code for a single edge case."""
    classify = classifier_ns["_classify_ssh_exception"]
    layer, _ = classify(ConnectionRefusedError("Connection refused"), msg={})
    assert layer == "CONNECTION_RESET"


def test_python_timeout_error_maps_to_connection_timeout(
    classifier_ns: dict[str, Any],
) -> None:
    """Python 3.10+ unified TimeoutError (was socket.timeout pre-3.10).
    The classifier must treat the unified class as a transport timeout."""
    classify = classifier_ns["_classify_ssh_exception"]
    layer, _ = classify(TimeoutError("read timed out"), msg={})
    assert layer == "CONNECTION_TIMEOUT"


def test_value_error_failed_to_enter_enable_maps_to_enable_mode_failed(
    classifier_ns: dict[str, Any],
) -> None:
    """The load-bearing path for Device 96: netmiko's RuijieOSBase auto-
    calls enable() in session_preparation; a wrong/missing enable
    secret raises ValueError('Failed to enter enable mode'). This must
    be visibly classified — it is the precise diagnostic the
    operator's audit needed."""
    classify = classifier_ns["_classify_ssh_exception"]
    layer, detail = classify(
        ValueError("Failed to enter enable mode"),
        msg={},
    )
    assert layer == "ENABLE_MODE_FAILED"
    assert "enable mode" in detail.lower()


def test_value_error_localized_enable_signature_also_classified(
    classifier_ns: dict[str, Any],
) -> None:
    """Defense-in-depth: a lower-cased or partial 'failed to enter enable'
    signature still classifies as ENABLE_MODE_FAILED."""
    classify = classifier_ns["_classify_ssh_exception"]
    for signature in (
        "failed to enter enable",
        "enable mode failed for some reason",
        "% Bad secrets — enable",
    ):
        layer, _ = classify(ValueError(signature), msg={})
        assert layer == "ENABLE_MODE_FAILED", (
            f"signature {signature!r} should map to ENABLE_MODE_FAILED, "
            f"got {layer}"
        )


def test_netmiko_read_timeout_maps_to_prompt_or_command_failed(
    classifier_ns: dict[str, Any],
) -> None:
    """netmiko.exceptions.ReadTimeout fires when send_command cannot
    detect the prompt after `read_timeout=120s` — the canonical signal
    for a prompt/command failure."""
    if _NetmikoReadTimeout is None:
        pytest.skip("netmiko build does not expose ReadTimeout")
    classify = classifier_ns["_classify_ssh_exception"]
    layer, _ = classify(
        _NetmikoReadTimeout("Pattern not detected: '\\#\\s*$'"),
        msg={},
    )
    assert layer == "PROMPT_OR_COMMAND_FAILED"


def test_generic_exception_with_prompt_signature_maps_to_prompt_failed(
    classifier_ns: dict[str, Any],
) -> None:
    """Fallback: when netmiko surfaces a prompt failure via a generic
    Exception (older releases / driver quirks), the substring detection
    still picks it up."""
    classify = classifier_ns["_classify_ssh_exception"]
    for signature in (
        "Search pattern never detected in send_command_timing",
        "Unable to enter configuration mode",
        "Unable to find prompt",
        "Timed-out reading channel",
    ):
        layer, _ = classify(Exception(signature), msg={})
        assert layer == "PROMPT_OR_COMMAND_FAILED", (
            f"signature {signature!r} should map to PROMPT_OR_COMMAND_FAILED, "
            f"got {layer}"
        )


def test_generic_unknown_exception_maps_to_unknown(
    classifier_ns: dict[str, Any],
) -> None:
    """Anything that does not match a class or substring signature
    falls through to UNKNOWN — the operator-facing surface still
    carries a layer label rather than a bare opaque string."""
    classify = classifier_ns["_classify_ssh_exception"]
    layer, detail = classify(RuntimeError("device exploded somehow"), msg={})
    assert layer == "UNKNOWN"
    assert "exploded" in detail


# ─── 3. Secret redaction (defense-in-depth) ────────────────────────────


def test_redaction_strips_ssh_password_from_detail(
    classifier_ns: dict[str, Any],
) -> None:
    """A defensive scenario: if netmiko or a downstream transport
    accidentally echoes the password into the exception message, the
    classifier MUST scrub it before returning the detail string. The
    test forces a worst-case where the exception text literally
    contains the password."""
    classify = classifier_ns["_classify_ssh_exception"]
    msg = {
        "ssh_username": "admin",
        "ssh_password": "SuperSecretP@ss!",
        "enable_secret": "EnableTime",
    }
    bad_text = "auth failed: bad password 'SuperSecretP@ss!' for admin"
    layer, detail = classify(
        NetmikoAuthenticationException(bad_text), msg=msg,
    )
    assert layer == "AUTH_FAILED"
    assert "SuperSecretP@ss!" not in detail
    assert "***REDACTED***" in detail


def test_redaction_strips_enable_secret_from_detail(
    classifier_ns: dict[str, Any],
) -> None:
    classify = classifier_ns["_classify_ssh_exception"]
    msg = {
        "ssh_username": "admin",
        "ssh_password": "p",
        "enable_secret": "MagicEnableSecret123",
    }
    layer, detail = classify(
        ValueError(
            "Failed to enter enable mode: provided 'MagicEnableSecret123'"
        ),
        msg=msg,
    )
    assert layer == "ENABLE_MODE_FAILED"
    assert "MagicEnableSecret123" not in detail
    assert "***REDACTED***" in detail


def test_redaction_handles_overlapping_secrets_longest_first(
    classifier_ns: dict[str, Any],
) -> None:
    """If ssh_password is a prefix of enable_secret (or vice versa),
    the longer secret MUST be scrubbed first so the shorter one cannot
    leak via the residue. Order matters."""
    classify = classifier_ns["_classify_ssh_exception"]
    short = "Secret"
    long = "Secret123Long"
    msg = {"ssh_password": short, "enable_secret": long}
    detail_text = f"Bad creds: {long} then {short}"
    _, detail = classify(NetmikoAuthenticationException(detail_text), msg=msg)
    assert short not in detail
    assert long not in detail


def test_no_msg_passed_means_no_secret_replacement(
    classifier_ns: dict[str, Any],
) -> None:
    """A defensive caller can omit `msg` entirely — classifier must
    still return a useful detail without crashing or scrubbing
    incorrectly."""
    classify = classifier_ns["_classify_ssh_exception"]
    layer, detail = classify(
        NetmikoTimeoutException("timed out talking to host 10.0.0.1"),
    )
    assert layer == "CONNECTION_TIMEOUT"
    assert "10.0.0.1" in detail
    assert "***REDACTED***" not in detail


def test_redact_secrets_helper_short_circuits_on_empty_msg_or_secrets(
    classifier_ns: dict[str, Any],
) -> None:
    """The helper is a pure string transform; tested in isolation to
    pin the no-side-effect contract."""
    redact = classifier_ns["_redact_secrets"]
    assert redact("nothing to scrub", msg=None) == "nothing to scrub"
    assert redact("nothing to scrub", msg={}) == "nothing to scrub"
    # Empty-string secrets are not real secrets — must not produce
    # a redaction marker on every space character.
    assert (
        redact("nothing to scrub", msg={"ssh_password": "", "enable_secret": ""})
        == "nothing to scrub"
    )
    # Non-string secret (e.g. credential_id integer from vault path) is
    # silently ignored at the redaction layer — vault path inputs never
    # reach the agent's plaintext fields anyway.
    assert (
        redact("hello", msg={"ssh_password": 12345}) == "hello"
    )


# ─── 4. Success path is untouched ──────────────────────────────────────


def test_success_path_does_not_invoke_classifier_logic_at_runtime() -> None:
    """The classifier helper is only reached when an exception fires
    inside `_ssh_command`. The success path (line containing
    `return {"success": True, ...}`) makes no reference to the
    classifier, so a successful command cannot pick up a spurious
    layer code prefix. Pinned at source level — runtime smoke would
    require netmiko mocking inside an exec'd `_ssh_command` body,
    which is out of scope for v1 (separate test follows up under
    `_ssh_command` runtime suite if needed)."""
    src = _agent_source()
    tree = ast.parse(src)
    target = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_ssh_command":
            target = node
            break
    assert target is not None, "_ssh_command not found"
    body_src = ast.get_source_segment(src, target)
    assert body_src
    # The success return uses `"success": True` literal. The classifier
    # CALL SITE (not the identifier mentioned in docstring) is only
    # reached from the `except Exception as e:` block — that is the
    # contract being pinned. Search for the call-with-paren form so the
    # docstring's bare reference to the helper name does not satisfy
    # the assertion.
    success_idx = body_src.find('"success": True')
    classifier_call_idx = body_src.find("_classify_ssh_exception(")
    assert success_idx >= 0, "success path missing"
    assert classifier_call_idx >= 0, "classifier not wired into except branch"
    assert classifier_call_idx > success_idx, (
        "classifier call site appears before success branch — "
        "v1 contract requires it to live ONLY inside the except branch"
    )


# ─── 5. _ssh_command except branch wires classifier (source-level pin) ─


def test_ssh_command_except_branch_uses_classifier_and_layer_prefix() -> None:
    """Pins the exact textual pattern `layer, detail = _classify_ssh_exception(e, msg=msg)`
    and the result construction `"error": "{}: {}".format(layer, detail)`.
    A future refactor that drops the prefix (or names the variables
    differently) would silently re-introduce the v0 opaque behavior;
    this guard catches that."""
    src = _agent_source()
    tree = ast.parse(src)
    target = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_ssh_command":
            target = node
            break
    assert target is not None
    body_src = ast.get_source_segment(src, target)
    assert body_src
    assert "_classify_ssh_exception(e, msg=msg)" in body_src
    # The prefix concatenation must be present so the wire-format
    # "<LAYER>: <detail>" surface is stable for the backend's
    # passthrough into the 502 detail.
    assert '"{}: {}".format(layer, detail)' in body_src


# ─── 6. _ssh_test is intentionally NOT touched in this PR ──────────────


def test_ssh_test_still_uses_legacy_classification_for_now() -> None:
    """`_ssh_test` keeps its own pre-v1 classification ('Kimlik
    dogrulama hatasi:' / 'Baglanti zaman asimi:'). Operator brief
    explicitly limited scope to `_ssh_command` for v1. This pin makes
    the scope boundary machine-enforced — a future PR that widens to
    `_ssh_test` should land with its own classification migration.
    """
    src = _agent_source()
    tree = ast.parse(src)
    target = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_ssh_test":
            target = node
            break
    assert target is not None
    body_src = ast.get_source_segment(src, target)
    assert body_src
    assert "Kimlik dogrulama hatasi" in body_src
    assert "Baglanti zaman asimi" in body_src
    # Defensive: v1 must NOT accidentally wire the new classifier into
    # _ssh_test (out of scope).
    assert "_classify_ssh_exception" not in body_src


# ─── 7. Backend fetch-info 502 passthrough preserves layer prefix ──────


def test_backend_fetch_info_502_preserves_layer_prefix() -> None:
    """Backend `fetch-info` endpoint concatenates the agent's
    `result.error` into its 502 detail as `f"SSH error: {result.error}"`.
    With the v1 classifier producing `"ENABLE_MODE_FAILED: <detail>"`,
    the operator-visible HTTP detail becomes
    `"SSH error: ENABLE_MODE_FAILED: <detail>"` — the prefix MUST be
    preserved so downstream tooling (the audit log analyzer, the future
    layer-aware UI toast, log monitoring rules) can match on it.

    Source-level pin on the exact `f"SSH error: {result.error}"`
    pattern in devices.py's fetch_device_info; runtime mocking of the
    full HTTPException → toast chain belongs to a separate frontend
    test family.
    """
    devices_py = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "api"
        / "v1"
        / "endpoints"
        / "devices.py"
    )
    src = devices_py.read_text()
    # Find the fetch_device_info function body.
    tree = ast.parse(src)
    target = None
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "fetch_device_info":
            target = node
            break
    assert target is not None, "fetch_device_info endpoint not found"
    body_src = ast.get_source_segment(src, target)
    assert body_src
    # The 502 line must carry the canonical prefix that v1 wraps around.
    assert 'f"SSH error: {result.error}"' in body_src
    # Defensive: the agent passthrough path must NOT mutate result.error
    # before raising — any transformation would risk stripping the
    # layer prefix.
    upto_502 = body_src.split("raise HTTPException(status_code=502", 1)[0]
    assert "result.error =" not in upto_502, (
        "fetch-info must not rewrite result.error before raising 502 "
        "(v1 contract — layer prefix passthrough)"
    )


# ─── 8. End-to-end shape: classifier output is exactly two-tuple ───────


def test_classifier_returns_tuple_of_two_strings_for_every_branch(
    classifier_ns: dict[str, Any],
) -> None:
    """Defensive shape pin — the caller (`_ssh_command`'s except
    branch) unpacks `layer, detail = _classify_ssh_exception(e, msg=msg)`.
    Every branch MUST return a 2-tuple of strings. A future refactor
    that returns dict / None / single string would break the
    `.format(layer, detail)` line silently in the agent."""
    classify = classifier_ns["_classify_ssh_exception"]
    test_exceptions: list[Exception] = [
        NetmikoAuthenticationException("a"),
        NetmikoTimeoutException("b"),
        ConnectionResetError("c"),
        ConnectionRefusedError("d"),
        TimeoutError("e"),
        ValueError("Failed to enter enable mode"),
        Exception("Unable to find prompt"),
        RuntimeError("genuinely unknown"),
    ]
    if _NetmikoReadTimeout is not None:
        test_exceptions.append(_NetmikoReadTimeout("prompt"))
    for exc in test_exceptions:
        result = classify(exc, msg={})
        assert isinstance(result, tuple), (
            f"{type(exc).__name__} did not return a tuple"
        )
        assert len(result) == 2, (
            f"{type(exc).__name__} returned tuple of len {len(result)}"
        )
        layer, detail = result
        assert isinstance(layer, str) and layer in classifier_ns["_SSH_LAYER_CODES"]
        assert isinstance(detail, str)
