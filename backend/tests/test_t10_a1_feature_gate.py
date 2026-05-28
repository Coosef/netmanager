"""
T10 Faz A1 — Feature Registry + Enforcement.

Pins the licence/feature gate that is *independent* of RBAC:

  * RBAC (`require_permission`)  → "can this user do this verb?"
  * Feature (`require_feature`)  → "does this org's plan include the module?"

Semantics are opt-out (transition-safe): a plan with no `features`, a
missing key, or an explicit `true` all PASS; only an explicit `false`
closes the module. A platform super-admin bypasses the gate entirely.

These tests cover the pure registry helpers, the `org_feature_states`
resolver and the `require_feature` dependency (open → user returned,
closed → HTTP 403, super-admin → bypass).
"""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.database import SharedBase
import app.models  # noqa: F401 — registers every model
from app.core.features import FEATURES, all_feature_states, feature_enabled
from app.models.user import SystemRole


# ── pure registry helpers — opt-out semantics ────────────────────────────────

def test_feature_enabled_open_by_default():
    # No plan / empty plan → everything open (existing orgs never break).
    assert feature_enabled(None, "topology") is True
    assert feature_enabled({}, "topology") is True
    # A key absent from a non-empty plan → still open (new features default on).
    assert feature_enabled({"ipam": False}, "topology") is True


def test_feature_enabled_only_explicit_false_closes():
    assert feature_enabled({"topology": False}, "topology") is False
    assert feature_enabled({"topology": True}, "topology") is True
    # Truthy-but-not-True values are treated as enabled (only `is False` closes).
    assert feature_enabled({"topology": 1}, "topology") is True


def test_all_feature_states_covers_registry():
    states = all_feature_states({"topology": False})
    assert set(states) == set(FEATURES)
    assert states["topology"] is False
    assert states["ipam"] is True            # not mentioned → open


# ── async SQLite harness (Organization + Plan are SharedBase) ────────────────

def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.shared.plan import Plan
    SharedBase.metadata.create_all(
        sync_conn, tables=[Organization.__table__, Plan.__table__]
    )


class _adb:
    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_tables)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


async def _plan(db, pid, features):
    from app.models.shared.plan import Plan
    p = Plan(id=pid, name=f"plan-{pid}", slug=f"plan-{pid}", features=features)
    db.add(p)
    await db.flush()
    return p


async def _org(db, oid, slug, plan_id=None):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug, plan_id=plan_id)
    db.add(o)
    await db.flush()
    return o


class _Ctx:
    """Minimal stand-in for the resolved request LocationContext —
    require_feature only reads `organization_id`."""
    def __init__(self, organization_id):
        self.organization_id = organization_id


def _user(system_role=SystemRole.ORG_ADMIN, uid=1):
    return type("U", (), {"system_role": system_role, "id": uid})()


# ── org_feature_states resolver ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_org_feature_states_no_org_is_open():
    from app.core.deps import org_feature_states
    async with _adb() as db:
        states = await org_feature_states(db, None)
    assert all(states.values())                      # no org → all open
    assert set(states) == set(FEATURES)


@pytest.mark.asyncio
async def test_org_feature_states_no_plan_is_open():
    from app.core.deps import org_feature_states
    async with _adb() as db:
        await _org(db, 1, "alpha")                   # plan_id = None
        await db.commit()
        states = await org_feature_states(db, 1)
    assert all(states.values())


@pytest.mark.asyncio
async def test_org_feature_states_reflects_plan():
    from app.core.deps import org_feature_states
    async with _adb() as db:
        await _plan(db, 1, {"topology": False, "ipam": True})
        await _org(db, 1, "alpha", plan_id=1)
        await db.commit()
        states = await org_feature_states(db, 1)
    assert states["topology"] is False
    assert states["ipam"] is True
    assert states["poe"] is True                     # unmentioned → open


# ── require_feature dependency — the enforcement point ───────────────────────

@pytest.mark.asyncio
async def test_require_feature_open_returns_user():
    from app.core.deps import require_feature
    checker = require_feature("topology")
    async with _adb() as db:
        await _plan(db, 1, {"topology": True})
        await _org(db, 1, "alpha", plan_id=1)
        await db.commit()
        user = _user()
        result = await checker(_Ctx(1), user, db)
    assert result is user


@pytest.mark.asyncio
async def test_require_feature_no_plan_returns_user():
    from app.core.deps import require_feature
    checker = require_feature("topology")
    async with _adb() as db:
        await _org(db, 1, "alpha")                   # no plan → opt-out open
        await db.commit()
        user = _user()
        assert await checker(_Ctx(1), user, db) is user


@pytest.mark.asyncio
async def test_require_feature_closed_raises_403():
    from fastapi import HTTPException
    from app.core.deps import require_feature
    checker = require_feature("topology")
    async with _adb() as db:
        await _plan(db, 1, {"topology": False})
        await _org(db, 1, "alpha", plan_id=1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await checker(_Ctx(1), _user(), db)
    assert exc.value.status_code == 403
    # Human-readable label from the registry is surfaced to the client.
    assert FEATURES["topology"] in exc.value.detail


@pytest.mark.asyncio
async def test_require_feature_super_admin_bypasses_closed():
    """A platform super-admin sees every module — the plan is not consulted."""
    from app.core.deps import require_feature
    checker = require_feature("topology")
    async with _adb() as db:
        await _plan(db, 1, {"topology": False})
        await _org(db, 1, "alpha", plan_id=1)
        await db.commit()
        sa = _user(system_role=SystemRole.SUPER_ADMIN)
        assert await checker(_Ctx(1), sa, db) is sa
