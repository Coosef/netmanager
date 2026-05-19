"""
Faz 8 Phase D — agent operational sandboxing.

An agent is bound to exactly one (organization_id, location_id). Every
agent operation — ingest, discovery, SNMP, command execution — must
target a device in the agent's own org AND location; a cross-location
operation is rejected and logged, with no fallback.

These tests pin the enforcement module (app.services.agent_scope) and
the two enforcement surfaces that consume it:
  * agent_manager._enforce_device_scope — the command-dispatch layer
  * agents._assert_agent_device_scope   — the API layer

The enforcement is pure Python (independent of PostgreSQL RLS, by
design) so SQLite is sufficient.
"""
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import clear_org_context
from app.services.agent_scope import (
    AgentScope,
    AgentScopeError,
    assert_device_in_scope,
    device_in_scope,
    filter_device_ids_in_scope,
    resolve_agent_scope,
)


# ── async SQLite harness ─────────────────────────────────────────────────────

def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.agent import Agent
    from app.models.device import Device
    from app.models.audit_log import AuditLog  # agent reassignment is audited
    Base.metadata.create_all(sync_conn, tables=[
        Organization.__table__, Location.__table__,
        Agent.__table__, Device.__table__, AuditLog.__table__,
    ])


class _adb:
    """A fresh async in-memory SQLite session per test."""

    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_tables)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


async def _org(db, oid, slug):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug)
    db.add(o)
    await db.flush()
    return o


async def _location(db, lid, org_id, name):
    from app.models.location import Location
    loc = Location(id=lid, name=name, organization_id=org_id)
    db.add(loc)
    await db.flush()
    return loc


async def _agent(db, agent_id, org_id, loc_id, *, is_active=True):
    from app.models.agent import Agent
    a = Agent(
        id=agent_id, name=f"agent-{agent_id}", agent_key_hash="h",
        organization_id=org_id, location_id=loc_id, is_active=is_active,
    )
    db.add(a)
    await db.flush()
    return a


async def _device(db, dev_id, org_id, loc_id, ip):
    from app.models.device import Device
    d = Device(
        id=dev_id, hostname=f"sw-{dev_id}", ip_address=ip,
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org_id, location_id=loc_id,
    )
    db.add(d)
    await db.flush()
    return d


@pytest.fixture(autouse=True)
def _no_ctx():
    """Phase D enforcement must not depend on request context."""
    clear_org_context()
    yield
    clear_org_context()


# ── resolve_agent_scope — fail-closed agent identity ─────────────────────────

@pytest.mark.asyncio
async def test_resolve_agent_scope_returns_org_and_location():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "HQ")
        await _agent(db, "ag1", 1, 1)
        scope = await resolve_agent_scope(db, "ag1")
    assert scope == AgentScope("ag1", 1, 1)


@pytest.mark.asyncio
async def test_resolve_agent_scope_unknown_agent_fails_closed():
    async with _adb() as db:
        with pytest.raises(AgentScopeError):
            await resolve_agent_scope(db, "ghost")


@pytest.mark.asyncio
async def test_resolve_agent_scope_inactive_agent_fails_closed():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "HQ")
        await _agent(db, "ag1", 1, 1, is_active=False)
        with pytest.raises(AgentScopeError):
            await resolve_agent_scope(db, "ag1")


@pytest.mark.asyncio
async def test_resolve_agent_scope_follows_reassignment():
    """An agent moved to another location resolves to the new scope —
    the scope is read fresh, never cached."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "HQ")
        await _location(db, 2, 1, "Branch")
        agent = await _agent(db, "ag1", 1, 1)
        assert (await resolve_agent_scope(db, "ag1")).location_id == 1
        agent.location_id = 2
        await db.flush()
        assert (await resolve_agent_scope(db, "ag1")).location_id == 2


# ── filter_device_ids_in_scope — cross-location ingest reject ────────────────

@pytest.mark.asyncio
async def test_filter_device_ids_keeps_only_same_scope():
    """An ingest batch keeps the agent's own devices and drops every
    cross-location / cross-org device — the syslog/trap/status path."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 1, 1, "HQ")
        await _location(db, 2, 1, "Branch")
        await _location(db, 3, 2, "BravoHQ")
        await _agent(db, "ag1", 1, 1)
        await _device(db, 10, 1, 1, "10.0.0.10")   # in scope
        await _device(db, 11, 1, 2, "10.0.0.11")   # same org, other location
        await _device(db, 12, 2, 3, "10.0.0.12")   # other org
        scope = await resolve_agent_scope(db, "ag1")
        allowed = await filter_device_ids_in_scope(
            db, scope, [10, 11, 12], "syslog"
        )
    assert allowed == {10}


@pytest.mark.asyncio
async def test_filter_device_ids_empty_batch():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "HQ")
        await _agent(db, "ag1", 1, 1)
        scope = await resolve_agent_scope(db, "ag1")
        assert await filter_device_ids_in_scope(db, scope, [], "syslog") == set()


# ── assert_device_in_scope — cross-location command reject ───────────────────

def _dev(dev_id, org_id, loc_id):
    return SimpleNamespace(id=dev_id, organization_id=org_id, location_id=loc_id)


def test_assert_device_in_scope_same_scope_ok():
    scope = AgentScope("ag1", 1, 1)
    assert_device_in_scope(scope, _dev(10, 1, 1), "snmp_get")  # no raise
    assert device_in_scope(scope, _dev(10, 1, 1)) is True


def test_assert_device_in_scope_cross_location_rejected():
    """Same organization, different location — the tunnelled-command
    attack — is rejected."""
    scope = AgentScope("ag1", 1, 1)
    with pytest.raises(AgentScopeError) as exc:
        assert_device_in_scope(scope, _dev(11, 1, 2), "snmp_get")
    assert "Cross-location" in str(exc.value)


def test_assert_device_in_scope_cross_org_rejected():
    scope = AgentScope("ag1", 1, 1)
    with pytest.raises(AgentScopeError):
        assert_device_in_scope(scope, _dev(12, 2, 3), "stream_command")
    assert device_in_scope(scope, _dev(12, 2, 3)) is False


# ── agent_manager._enforce_device_scope — command-dispatch layer ─────────────

def test_enforce_device_scope_cross_location_rejected():
    """The command-dispatch layer rejects a device outside the agent's
    WS-session sandbox even if the API layer were bypassed."""
    from app.services.agent_manager import agent_manager
    agent_manager._meta["ag1"] = {"organization_id": 1, "location_id": 1}
    try:
        with pytest.raises(AgentScopeError):
            agent_manager._enforce_device_scope("ag1", _dev(11, 1, 2), "snmp_get")
        # same-scope device passes
        agent_manager._enforce_device_scope("ag1", _dev(10, 1, 1), "snmp_get")
    finally:
        agent_manager._meta.pop("ag1", None)


def test_enforce_device_scope_no_session_scope_defers_to_api_layer():
    """A pre-Phase-D session (no org/location in meta) or a scopeless
    device proxy cannot be cross-checked here — dispatch defers to the
    authoritative API layer rather than failing a legitimate command."""
    from app.services.agent_manager import agent_manager
    # no _meta entry at all
    agent_manager._enforce_device_scope("ghost", _dev(11, 1, 2), "ssh_command")
    # session known, but device is a scopeless proxy (internal relay)
    agent_manager._meta["ag1"] = {"organization_id": 1, "location_id": 1}
    try:
        proxy = SimpleNamespace(id=5, ip_address="10.0.0.5")  # no org/location
        agent_manager._enforce_device_scope("ag1", proxy, "ssh_command")
    finally:
        agent_manager._meta.pop("ag1", None)


# ── API layer — agents._assert_agent_device_scope ────────────────────────────

def test_api_helper_rejects_cross_location_with_403():
    """The endpoint helper translates a cross-location operation into an
    HTTP 403 — a multi-location user cannot tunnel a command through
    another location's agent."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.agents import _assert_agent_device_scope

    agent = SimpleNamespace(id="ag1", organization_id=1, location_id=1)
    with pytest.raises(HTTPException) as exc:
        _assert_agent_device_scope(agent, _dev(11, 1, 2), "snmp_get")
    assert exc.value.status_code == 403


def test_api_helper_allows_same_location():
    from app.api.v1.endpoints.agents import _assert_agent_device_scope
    agent = SimpleNamespace(id="ag1", organization_id=1, location_id=1)
    _assert_agent_device_scope(agent, _dev(10, 1, 1), "snmp_get")  # no raise
