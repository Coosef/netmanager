"""
Faz 8 Phase H — organization management: status, licence, quota, usage.

The organization is the hidden tenant boundary. Phase H finalises it with
a lifecycle (active / suspended / archived), per-organization quota, and
super-admin-only management.

These tests pin:
  * org_status_block — suspended is read-only, archived is fully closed
  * get_org_usage — usage is org-scoped and never leaks another tenant
  * enforce_org_can_create — quota / status refuses new resources;
    a platform super-admin override is allowed and structured-logged
  * the super-admin update_org endpoint — status/quota change + audit
  * require_system_role — a normal user cannot reach super-admin APIs
"""
import logging

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.core.database import Base, SharedBase
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import clear_org_context
from app.models.shared.organization import OrgStatus
from app.models.user import SystemRole
from app.services.org_management import (
    enforce_org_can_create, get_org_usage, org_status_block,
)


# ── async SQLite harness ─────────────────────────────────────────────────────

def _create_tables(sync_conn):
    # network_events is intentionally NOT created: it carries a
    # Postgres-only JSONB column that SQLite cannot render. get_org_usage's
    # events_24h query is defensive (returns 0 when the table is absent),
    # so the usage tests run fine without it.
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.device import Device
    from app.models.agent import Agent
    from app.models.user import User
    from app.models.audit_log import AuditLog
    SharedBase.metadata.create_all(sync_conn, tables=[Organization.__table__])
    Base.metadata.create_all(sync_conn, tables=[
        Location.__table__, Device.__table__, Agent.__table__,
        User.__table__, AuditLog.__table__,
    ])


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


@pytest.fixture(autouse=True)
def _clean_ctx():
    clear_org_context()
    yield
    clear_org_context()


def _fake_request() -> Request:
    return Request({
        "type": "http", "method": "PATCH", "path": "/super-admin/orgs",
        "headers": [], "query_string": b"", "client": ("10.0.0.9", 5555),
    })


async def _org(db, oid, slug, *, status="active", max_devices=200,
               max_locations=5, max_agents=10, max_users=20):
    from app.models.shared.organization import Organization
    o = Organization(
        id=oid, name=slug.title(), slug=slug, status=status,
        max_devices=max_devices, max_locations=max_locations,
        max_agents=max_agents, max_users=max_users, max_retention_days=90,
    )
    db.add(o)
    await db.flush()
    return o


async def _location(db, lid, org_id, name=None):
    from app.models.location import Location
    loc = Location(id=lid, name=name or f"loc-{lid}", organization_id=org_id)
    db.add(loc)
    await db.flush()
    return loc


async def _device(db, dev_id, org_id, loc_id, ip):
    # M6 final drop — legacy `tenant_id` column gone.
    from app.models.device import Device
    d = Device(
        id=dev_id, hostname=f"sw-{dev_id}", ip_address=ip,
        ssh_username="a", ssh_password_enc="e",
        organization_id=org_id, location_id=loc_id,
    )
    db.add(d)
    await db.flush()
    return d


async def _user(db, uid, org_id, system_role=SystemRole.VIEWER):
    # M6 final drop — legacy `role` / `tenant_id` columns gone.
    from app.models.user import User
    u = User(
        id=uid, username=f"u{uid}", email=f"u{uid}@x.io", hashed_password="h",
        organization_id=org_id, system_role=system_role,
    )
    db.add(u)
    await db.flush()
    return u


# ── org_status_block — lifecycle gate ────────────────────────────────────────

def _fakeorg(status):
    return type("O", (), {"status": status, "id": 1})()


def test_active_org_allows_everything():
    org = _fakeorg("active")
    for m in ("GET", "POST", "PATCH", "DELETE"):
        assert org_status_block(org, m) is None


def test_suspended_org_is_read_only():
    org = _fakeorg("suspended")
    assert org_status_block(org, "GET") is None        # reads pass
    assert org_status_block(org, "HEAD") is None
    for m in ("POST", "PATCH", "PUT", "DELETE"):
        assert org_status_block(org, m) is not None     # writes blocked


def test_archived_org_blocks_everything():
    org = _fakeorg("archived")
    for m in ("GET", "POST", "PATCH", "DELETE"):
        assert org_status_block(org, m) is not None


def test_no_org_does_not_block():
    assert org_status_block(None, "POST") is None


# ── get_org_usage — org-scoped, no cross-org leakage ─────────────────────────

@pytest.mark.asyncio
async def test_usage_is_org_scoped():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 1, 1)
        await _location(db, 2, 2)
        await _device(db, 10, 1, 1, "10.0.0.1")
        await _device(db, 11, 1, 1, "10.0.0.2")
        await _device(db, 20, 2, 2, "10.0.0.1")          # org 2 — same IP ok
        await db.commit()

        from app.models.shared.organization import Organization
        org1 = await db.get(Organization, 1)
        org2 = await db.get(Organization, 2)
        u1 = await get_org_usage(db, org1)
        u2 = await get_org_usage(db, org2)
    assert u1["resources"]["devices"]["used"] == 2       # only org 1's
    assert u2["resources"]["devices"]["used"] == 1       # only org 2's
    assert u1["organization_id"] == 1
    assert u1["resources"]["locations"]["used"] == 1


@pytest.mark.asyncio
async def test_usage_reports_over_quota():
    async with _adb() as db:
        await _org(db, 1, "alpha", max_devices=2)
        await _location(db, 1, 1)
        await _device(db, 10, 1, 1, "10.0.0.1")
        await _device(db, 11, 1, 1, "10.0.0.2")
        await db.commit()
        from app.models.shared.organization import Organization
        usage = await get_org_usage(db, await db.get(Organization, 1))
    assert usage["resources"]["devices"]["used"] == 2
    assert usage["resources"]["devices"]["limit"] == 2
    assert usage["resources"]["devices"]["over_limit"] is True
    assert usage["over_quota"] is True


# ── enforce_org_can_create — quota + status enforcement ──────────────────────

@pytest.mark.asyncio
async def test_create_allowed_under_quota():
    async with _adb() as db:
        await _org(db, 1, "alpha", max_devices=5)
        await _location(db, 1, 1)
        await _device(db, 10, 1, 1, "10.0.0.1")
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        # 1 device, limit 5 — fine, no raise
        await enforce_org_can_create(db, org, "devices", actor_user_id=1)


@pytest.mark.asyncio
async def test_quota_exceeded_blocks_creation():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha", max_devices=2)
        await _location(db, 1, 1)
        await _device(db, 10, 1, 1, "10.0.0.1")
        await _device(db, 11, 1, 1, "10.0.0.2")          # at the limit
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        with pytest.raises(HTTPException) as exc:
            await enforce_org_can_create(db, org, "devices", actor_user_id=1)
    assert exc.value.status_code == 403
    assert "quota" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_quota_blocks_locations_agents_users():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha", max_locations=1, max_agents=0, max_users=1)
        await _location(db, 1, 1)
        await _user(db, 1, 1)
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        for resource in ("locations", "agents", "users"):
            with pytest.raises(HTTPException) as exc:
                await enforce_org_can_create(db, org, resource, actor_user_id=1)
            assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_suspended_org_blocks_creation():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha", status="suspended")
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        with pytest.raises(HTTPException) as exc:
            await enforce_org_can_create(db, org, "devices", actor_user_id=1)
    assert exc.value.status_code == 403
    assert "suspended" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_archived_org_blocks_creation():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha", status="archived")
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        with pytest.raises(HTTPException):
            await enforce_org_can_create(db, org, "devices", actor_user_id=1)


@pytest.mark.asyncio
async def test_super_admin_override_is_allowed_and_logged(caplog):
    """A platform super-admin may create past the quota — the override
    is explicit and structured-logged, never silent."""
    async with _adb() as db:
        await _org(db, 1, "alpha", max_devices=1)
        await _location(db, 1, 1)
        await _device(db, 10, 1, 1, "10.0.0.1")          # at the limit
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        with caplog.at_level(logging.WARNING, logger="netmanager.org_management"):
            # super-admin override — no raise
            await enforce_org_can_create(
                db, org, "devices", actor_user_id=9, is_super_admin=True,
            )
    assert any(r.__dict__.get("event") == "org_quota_override" for r in caplog.records)


@pytest.mark.asyncio
async def test_quota_rejection_is_logged(caplog):
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha", max_devices=0)
        await db.commit()
        from app.models.shared.organization import Organization
        org = await db.get(Organization, 1)
        with caplog.at_level(logging.WARNING, logger="netmanager.org_management"):
            with pytest.raises(HTTPException):
                await enforce_org_can_create(db, org, "devices", actor_user_id=1)
    assert any(r.__dict__.get("event") == "org_quota_rejected" for r in caplog.records)


# ── super-admin endpoints ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_super_admin_can_update_org_status_and_audit():
    from app.api.v1.endpoints.super_admin import update_org, OrgUpdate
    async with _adb() as db:
        await _org(db, 1, "alpha")
        actor = await _user(db, 1, None, system_role=SystemRole.SUPER_ADMIN)
        await db.commit()

        result = await update_org(
            1, OrgUpdate(status="suspended", max_devices=42),
            _fake_request(), current_user=actor, db=db,
        )
        assert result["status"] == "suspended"
        assert result["quota"]["max_devices"] == 42
        assert result["is_active"] is False             # legacy flag kept consistent

        from app.models.audit_log import AuditLog
        rows = (await db.execute(
            select(AuditLog).where(AuditLog.action == "organization_updated")
        )).scalars().all()
    assert rows, "organization_updated audit row missing"
    row = rows[0]
    assert row.after_state.get("status") == "suspended"
    assert row.before_state.get("status") == "active"
    assert row.details.get("organization_id") == 1


@pytest.mark.asyncio
async def test_super_admin_update_org_rejects_bad_status():
    from fastapi import HTTPException
    from app.api.v1.endpoints.super_admin import update_org, OrgUpdate
    async with _adb() as db:
        await _org(db, 1, "alpha")
        actor = await _user(db, 1, None, system_role=SystemRole.SUPER_ADMIN)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await update_org(1, OrgUpdate(status="bogus"), _fake_request(),
                             current_user=actor, db=db)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_org_usage_endpoint_is_org_scoped():
    from app.api.v1.endpoints.super_admin import get_org_usage_endpoint
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 1, 1)
        await _location(db, 2, 2)
        await _device(db, 10, 1, 1, "10.0.0.1")
        await _device(db, 20, 2, 2, "10.0.0.1")          # org 2 — must not count for org 1
        actor = await _user(db, 1, None, system_role=SystemRole.SUPER_ADMIN)
        await db.commit()
        usage = await get_org_usage_endpoint(1, actor, db=db)
    assert usage["organization_id"] == 1
    assert usage["resources"]["devices"]["used"] == 1   # only org 1's device


# ── normal user cannot reach super-admin APIs ────────────────────────────────

@pytest.mark.asyncio
async def test_normal_user_rejected_by_super_admin_guard():
    from fastapi import HTTPException
    from app.core.deps import require_system_role
    checker = require_system_role(SystemRole.SUPER_ADMIN)

    normal = type("U", (), {
        "system_role": SystemRole.VIEWER, "id": 5,
    })()
    with pytest.raises(HTTPException) as exc:
        await checker(normal)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_super_admin_passes_super_admin_guard():
    from app.core.deps import require_system_role
    checker = require_system_role(SystemRole.SUPER_ADMIN)
    sa = type("U", (), {
        "system_role": SystemRole.SUPER_ADMIN, "id": 1,
    })()
    assert await checker(sa) is sa


# ── no default-org fallback reintroduced ─────────────────────────────────────

@pytest.mark.asyncio
async def test_enforce_requires_a_real_org():
    """enforce_org_can_create on a None org fails closed — it never
    invents / falls back to a default organization."""
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        await enforce_org_can_create(None, None, "devices", actor_user_id=1)
    assert exc.value.status_code == 400
