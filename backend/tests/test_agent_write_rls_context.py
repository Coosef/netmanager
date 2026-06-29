"""Worker / agent-relay write RLS context — regression suite for the
``fix/agent-write-rls-context`` PR (TD-22 follow-up).

Operator-required scenarios:

    A. Agent result write path applies the correct org GUC before the
       INSERT runs.
    B. agent_command_logs insert commits inside the correct org scope
       (the GUCs pushed for the active transaction match the row's
       stamped org_id).
    C. agent_device_latencies insert commits inside the correct org
       scope.
    D. When the agent scope cannot be resolved (no row in _meta and
       super-admin lookup returns nothing), the write is silently
       dropped — never a silent cross-tenant write.
    E. No state leak between two agents in different orgs: the second
       write's GUCs reflect ITS agent's scope, not the previous one's.

These tests exercise the helper directly so they don't have to spin up
a Postgres engine; the RLS policy itself can only be exercised in
production, but the unit boundary that the helper is responsible for —
"emit a SELECT set_config(...) with the resolved org/loc" — is fully
covered here.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest


class _RecordingSession:
    """Minimal stub that captures every execute() call. Used in lieu
    of a real AsyncSession because the helper only needs three things:
    `get_bind().dialect.name`, `execute(stmt, params)` and the ability
    to await it."""

    def __init__(self, dialect_name: str = "postgresql"):
        self._dialect_name = dialect_name
        self.executed: list[tuple[Any, dict | None]] = []

    def get_bind(self):
        return SimpleNamespace(dialect=SimpleNamespace(name=self._dialect_name))

    async def execute(self, stmt, params=None):
        self.executed.append((stmt, params))


def _new_manager_with_meta(meta: dict | None = None):
    """Pull AgentManager out of the import graph without booting the
    whole app. The class lives in agent_manager but it imports
    settings/db modules at import time — those are already set up via
    conftest.py."""
    from app.services.agent_manager import AgentManager
    am = AgentManager()
    # _meta is a populated-on-WS-connect dict in production; we seed it
    # directly for the unit tests.
    am._meta = meta or {}
    return am


# ── A. helper emits SET LOCAL for both GUCs with the right values ─────────

@pytest.mark.asyncio
async def test_A_helper_pushes_org_and_location_gucs():
    am = _new_manager_with_meta()
    db = _RecordingSession()
    await am._apply_worker_rls_context(db, org_id=42, loc_id=7)

    assert len(db.executed) == 1, (
        f"expected exactly one statement, got {len(db.executed)}"
    )
    stmt, params = db.executed[0]
    rendered = str(stmt)
    assert "set_config" in rendered
    assert "app.current_org_id" in rendered
    assert "app.current_location_id" in rendered
    assert params == {"oid": "42", "lid": "7"}


# ── B. command-log path: GUCs go BEFORE the row is added ──────────────────

@pytest.mark.asyncio
async def test_B_command_log_pushes_context_before_insert(monkeypatch):
    """The fix's correctness hinges on ordering: GUC SET must precede
    INSERT, otherwise WITH CHECK still fires under empty GUCs. We
    instrument the AgentManager so we can observe the order."""
    am = _new_manager_with_meta()

    async def _fake_resolve(agent_id):
        # The trusted source — _meta / super-admin lookup. Returns the
        # right org/loc for "agent-A".
        return 7, 3

    order: list[str] = []

    async def _fake_apply(db, org_id, loc_id):
        order.append(f"apply_rls(org={org_id},loc={loc_id})")

    class _Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            pass
        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        def add(self, entry):
            order.append(
                f"add(table={entry.__tablename__},"
                f"org={getattr(entry, 'organization_id', None)})"
            )
        async def commit(self):
            order.append("commit")

    def _fake_session_factory():
        return _Session

    monkeypatch.setattr(am, "_resolve_agent_scope", _fake_resolve)
    monkeypatch.setattr(am, "_apply_worker_rls_context", _fake_apply)
    monkeypatch.setattr(
        "app.core.database.make_worker_session", _fake_session_factory,
    )

    await am._persist_command_log(
        agent_id="agent-A", device_id=10, device_ip="10.0.0.1",
        command_type="ssh_command", command="show version",
        success=True, duration_ms=50, blocked=False,
        block_reason=None, request_id="r1",
    )

    assert order[0] == "apply_rls(org=7,loc=3)", (
        f"GUC must be pushed first; observed order: {order}"
    )
    assert any(o.startswith("add(table=agent_command_logs") for o in order)
    assert any("org=7" in o for o in order if o.startswith("add("))
    assert order[-1] == "commit"


# ── C. latency path: GUCs go BEFORE the Core insert/UPSERT ────────────────

@pytest.mark.asyncio
async def test_C_latency_pushes_context_before_insert(monkeypatch):
    am = _new_manager_with_meta()

    async def _fake_resolve(agent_id):
        return 9, 4

    order: list[str] = []

    async def _fake_apply(db, org_id, loc_id):
        order.append(f"apply_rls(org={org_id},loc={loc_id})")

    class _Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            pass
        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        async def execute(self, stmt, params=None):
            order.append(f"execute(stmt={type(stmt).__name__})")
        async def commit(self):
            order.append("commit")

    def _fake_session_factory():
        return _Session

    monkeypatch.setattr(am, "_resolve_agent_scope", _fake_resolve)
    monkeypatch.setattr(am, "_apply_worker_rls_context", _fake_apply)
    monkeypatch.setattr(
        "app.core.database.make_worker_session", _fake_session_factory,
    )

    await am._persist_latency(
        agent_id="agent-A", device_id=10, latency_ms=12.5, success=True,
    )

    assert order, "no statements observed"
    assert order[0] == "apply_rls(org=9,loc=4)", (
        f"GUC must be pushed first; observed order: {order}"
    )
    # Then exactly one Core INSERT (the UPSERT), then commit.
    assert any(o.startswith("execute(stmt=") for o in order)
    assert order[-1] == "commit"


# ── D. unknown agent: write is silently dropped, NO INSERT attempted ──────

@pytest.mark.asyncio
async def test_D_unknown_agent_drops_write(monkeypatch):
    """Per the existing T8.4 contract: an agent with no resolvable
    org/loc has its write dropped. The new fix MUST NOT relax this —
    silently writing the row with NULL or guessed values would leak
    rows across tenants. We verify both helpers (command log + latency)
    in one shot."""
    am = _new_manager_with_meta()

    async def _fake_resolve_nothing(agent_id):
        return None, None

    apply_calls: list[Any] = []

    async def _fake_apply(db, org_id, loc_id):
        apply_calls.append((org_id, loc_id))

    session_calls: list[str] = []

    def _fake_session_factory():
        # If the production code reached this point, the bug is back —
        # raising loudly is the safest fail-mode.
        session_calls.append("opened-session-without-org")

        class _Sentinel:
            async def __aenter__(self):
                raise AssertionError(
                    "Worker session opened despite missing org scope. "
                    "The drop-on-unknown-agent contract is broken."
                )
            async def __aexit__(self, *exc):
                pass
        return _Sentinel

    monkeypatch.setattr(am, "_resolve_agent_scope", _fake_resolve_nothing)
    monkeypatch.setattr(am, "_apply_worker_rls_context", _fake_apply)
    monkeypatch.setattr(
        "app.core.database.make_worker_session", _fake_session_factory,
    )

    # Command log path.
    await am._persist_command_log(
        agent_id="ghost-agent", device_id=10, device_ip="10.0.0.1",
        command_type="ssh_command", command="show version",
        success=True, duration_ms=50, blocked=False,
        block_reason=None, request_id="r1",
    )
    # Latency path.
    await am._persist_latency(
        agent_id="ghost-agent", device_id=10, latency_ms=12.5, success=True,
    )

    assert apply_calls == [], (
        "RLS context was applied for an unknown agent — that means the "
        "code would have continued to the INSERT. This is exactly the "
        "silent cross-tenant write path the test is here to prevent."
    )
    assert session_calls == [], "session was opened for an unknown agent"


# ── E. two agents in different orgs: GUCs do NOT leak across writes ───────

@pytest.mark.asyncio
async def test_E_two_orgs_no_guc_leak_between_writes(monkeypatch):
    """A worker process services many agents over its lifetime. We
    must make sure that writing for agent-A (org=7) does NOT leave the
    transaction GUCs sitting at org=7 for the next write on agent-B
    (org=11). Each write opens its own short-lived session, so the
    helper must be invoked with the CURRENT write's org each time."""
    am = _new_manager_with_meta()

    async def _fake_resolve(agent_id):
        return {"agent-A": (7, 3), "agent-B": (11, 5)}[agent_id]

    apply_calls: list[tuple[int, int]] = []

    async def _fake_apply(db, org_id, loc_id):
        apply_calls.append((org_id, loc_id))

    class _Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *exc):
            pass
        def get_bind(self):
            return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        def add(self, entry):
            pass
        async def execute(self, stmt, params=None):
            pass
        async def commit(self):
            pass

    def _fake_session_factory():
        return _Session

    monkeypatch.setattr(am, "_resolve_agent_scope", _fake_resolve)
    monkeypatch.setattr(am, "_apply_worker_rls_context", _fake_apply)
    monkeypatch.setattr(
        "app.core.database.make_worker_session", _fake_session_factory,
    )

    await am._persist_command_log(
        agent_id="agent-A", device_id=10, device_ip="10.0.0.1",
        command_type="ssh_command", command="show version",
        success=True, duration_ms=50, blocked=False,
        block_reason=None, request_id="r1",
    )
    await am._persist_command_log(
        agent_id="agent-B", device_id=20, device_ip="10.0.0.2",
        command_type="ssh_command", command="show version",
        success=True, duration_ms=50, blocked=False,
        block_reason=None, request_id="r2",
    )
    await am._persist_latency(
        agent_id="agent-B", device_id=20, latency_ms=12.5, success=True,
    )

    assert apply_calls == [(7, 3), (11, 5), (11, 5)], (
        f"GUC propagation leaked across writes — sequence was {apply_calls}; "
        f"expected [(7, 3), (11, 5), (11, 5)]."
    )
