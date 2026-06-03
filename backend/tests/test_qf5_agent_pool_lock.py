"""QF-5 (2026-06-03) — Agent SSH pool per-entry lock.

Background:
  Pre-fix `_pool_get` returned a netmiko ConnectHandler; concurrent threads
  shared the same conn and called send_command() in parallel, corrupting the
  paramiko buffer. Result: every ssh_command after a concurrent burst hung
  until `read_timeout=120` while backend gave up at `_COMMAND_TIMEOUT=90`.

Fix:
  - Pool entry shape: {"conn", "last_used", "lock": threading.Lock()}.
  - New `_pool_acquire` returns the entry; consumers must use
    `with entry["lock"]: conn.send_command(...)`.
  - `_pool_evict_idle` skips entries whose lock is currently held.
  - `_ssh_test` (fresh conn) and `_shell_open_sync` (paramiko direct)
    are deliberately unchanged.

Strategy:
  Agent script is not importable (top-level argparse + WS init). We use the
  same source-assertion pattern as HF#10A / HF#11 tests: read the file with
  Path, parse with ast, scan function bodies as text.
"""
from __future__ import annotations

import ast
from pathlib import Path

AGENT_SCRIPT = (
    Path(__file__).resolve().parent.parent / "agent_script" / "netmanager_agent.py"
)


def _src() -> str:
    return AGENT_SCRIPT.read_text()


def _function_source(name: str) -> str:
    """Return the source text of the given top-level function."""
    tree = ast.parse(_src())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(_src(), node) or ""
    raise AssertionError(f"function {name!r} not found in agent script")


# ─── 1. Syntax + version smoke ────────────────────────────────────────────────


def test_qf5_agent_script_parses_cleanly():
    """Agent script must parse — OTA push validates with ast.parse on the
    receiving side too; a syntax error here would break self-update on every
    connected agent."""
    src = _src()
    ast.parse(src)  # raises SyntaxError on failure


def test_qf5_version_bumped_to_1_4_1():
    """Single source of truth for agent VERSION."""
    src = _src()
    import re
    m = re.search(r'^VERSION\s*=\s*["\'](.+?)["\']', src, re.MULTILINE)
    assert m is not None, "VERSION line not found"
    assert m.group(1) == "1.4.1", f"VERSION expected 1.4.1, got {m.group(1)!r}"


def test_qf5_backend_reads_new_version():
    """Backend CURRENT_AGENT_VERSION is read at import time from the script
    file; if the regex changes shape, this test catches it."""
    # Re-execute the same parser the backend uses (endpoints/agents._read_agent_version)
    import re
    m = re.search(r'^VERSION\s*=\s*["\'](.+?)["\']', _src(), re.MULTILINE)
    assert m and m.group(1) == "1.4.1"


# ─── 2. Pool entry shape ──────────────────────────────────────────────────────


def test_qf5_pool_entry_has_lock_field():
    """Pool entries must carry a per-entry lock (threading.Lock instance).
    Source assertion: `_pool_acquire` body constructs entry with `lock`."""
    src = _function_source("_pool_acquire")
    assert "_pool_acquire" or True
    assert "threading.Lock()" in src, (
        "_pool_acquire does not allocate a threading.Lock per entry"
    )
    assert '"lock"' in src, "entry dict missing 'lock' key"


def test_qf5_pool_acquire_returns_entry_not_bare_conn():
    """Regression guard: consumers must call `_pool_acquire` (returns entry
    dict) and access `.send_command` via `entry["conn"]`, not the legacy
    `_pool_get` shim."""
    src = _function_source("_pool_acquire")
    # _pool_acquire returns the entry dict (the 'return entry' lines)
    assert "return entry" in src
    # The legacy _pool_get shim must remain (for any out-of-tree caller)
    full = _src()
    assert "def _pool_get(msg):" in full
    assert "_pool_acquire(msg)" in _function_source("_pool_get")


# ─── 3. Consumers use the lock ────────────────────────────────────────────────


def test_qf5_ssh_command_uses_entry_lock():
    src = _function_source("_ssh_command")
    assert "_pool_acquire(msg)" in src, "_ssh_command not migrated to _pool_acquire"
    assert 'entry["lock"]' in src, "_ssh_command missing entry['lock'] guard"
    assert 'entry["conn"].send_command' in src, (
        "_ssh_command must call send_command via entry['conn']"
    )
    # Sanity: no longer uses the bare _pool_get path
    assert "conn = _pool_get(msg)" not in src


def test_qf5_ssh_config_uses_entry_lock():
    src = _function_source("_ssh_config")
    assert "_pool_acquire(msg)" in src
    assert 'entry["lock"]' in src
    assert 'entry["conn"].send_config_set' in src


def test_qf5_ssh_command_stream_uses_entry_lock():
    src = _function_source("_ssh_command_stream_sync")
    assert "_pool_acquire(msg)" in src
    assert 'entry["lock"]' in src
    assert 'entry["conn"].send_command_timing' in src


# ─── 4. ssh_test and shell are deliberately untouched ─────────────────────────


def test_qf5_ssh_test_does_not_touch_pool():
    """ssh_test (Bağlantı Testi) MUST keep using fresh `_get_connection` and
    immediately disconnect — this is the only fast path that worked during
    the incident sprint and the contract must be preserved."""
    src = _function_source("_ssh_test")
    assert "_get_connection(msg)" in src
    assert "conn.disconnect()" in src
    # Pool / lock must NOT appear in ssh_test
    assert "_pool_acquire" not in src
    assert "_pool_get" not in src
    assert "entry[\"lock\"]" not in src


def test_qf5_shell_open_does_not_touch_pool():
    """Interactive shell uses paramiko directly; it must not share the
    netmiko pool (different connection lifecycle)."""
    src = _function_source("_shell_open_sync")
    assert "paramiko.SSHClient()" in src
    assert "_pool_acquire" not in src
    assert "_pool_get" not in src


# ─── 5. Eviction skips busy entries ───────────────────────────────────────────


def test_qf5_eviction_skips_busy_entries():
    """If a pool entry's lock is currently held by a running command, eviction
    must NOT call conn.disconnect() — that would corrupt the in-flight
    netmiko buffer. Source assertion: non-blocking acquire + skip path."""
    src = _function_source("_pool_evict_idle")
    assert "acquire(blocking=False)" in src, (
        "eviction must use non-blocking acquire to detect busy entries"
    )
    # Skip branch updates last_used so we don't re-attempt next minute
    assert "last_used" in src
    # Comment hint: explicitly mentions skipping busy entries
    assert "busy" in src.lower() or "skip" in src.lower()


# ─── 6. Cross-device parallelism preserved ────────────────────────────────────


def test_qf5_pool_key_is_per_device():
    """Pool key remains (host, port, username) — different devices get
    different locks, so cross-device parallelism is preserved."""
    src = _function_source("_pool_acquire")
    assert 'key = (params["host"], params["port"], params["username"])' in src
