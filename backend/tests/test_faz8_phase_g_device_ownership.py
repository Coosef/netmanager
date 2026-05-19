"""
Faz 8 Phase G — device location ownership hardening.

A device belongs to exactly one organization + one location. That
ownership is IMMUTABLE through the generic update path; it changes only
through the audited move endpoint (POST /devices/{id}/move-location),
which requires the device:move capability and access to BOTH the source
and the target location.

These tests pin:
  * forbidden_ownership_fields — a generic update may not carry
    location_id / organization_id
  * relocate_device_data — a device's child rows follow it on a move
  * the move endpoint — authorized move, same-location no-op, missing
    capability, unauthorized source / target, cross-org, deleted target,
    no-location user, and the audit trail
  * device IP uniqueness — scoped to (org, location): overlapping
    private IPs across locations coexist; a duplicate within one
    location is rejected; IP+location matching keeps them distinct
"""
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.core.database import Base
import app.models  # noqa: F401 — registers every model + the scoping hook
from app.core.org_context import clear_org_context
from app.core.request_context import LocationContext
from app.models.user import SystemRole, UserRole
from app.schemas.device import DeviceMoveRequest
from app.services.device_ownership import (
    OWNERSHIP_FIELDS, forbidden_ownership_fields, relocate_device_data,
)


# ── async SQLite harness ─────────────────────────────────────────────────────

def _create_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User
    from app.models.user_location import UserLocation
    from app.models.device import Device
    from app.models.config_backup import ConfigBackup
    from app.models.audit_log import AuditLog
    Base.metadata.create_all(sync_conn, tables=[
        Organization.__table__, Location.__table__, User.__table__,
        UserLocation.__table__, Device.__table__, ConfigBackup.__table__,
        AuditLog.__table__,
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
        "type": "http", "method": "POST", "path": "/devices/move",
        "headers": [], "query_string": b"", "client": ("10.0.0.9", 5555),
    })


async def _org(db, oid, slug):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug)
    db.add(o)
    await db.flush()
    return o


async def _location(db, lid, org_id, name, deleted=False):
    from datetime import datetime, timezone
    from app.models.location import Location
    loc = Location(
        id=lid, name=name, organization_id=org_id,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(loc)
    await db.flush()
    return loc


async def _user(db, uid, org_id, role=UserRole.ADMIN):
    from app.models.user import User
    u = User(
        id=uid, username=f"u{uid}", email=f"u{uid}@x.io", hashed_password="h",
        organization_id=org_id, role=role, system_role=SystemRole.ORG_ADMIN,
        tenant_id=None,
    )
    db.add(u)
    await db.flush()
    return u


async def _device(db, dev_id, org_id, loc_id, ip="10.0.0.1"):
    from app.models.device import Device
    d = Device(
        id=dev_id, hostname=f"sw-{dev_id}", ip_address=ip,
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org_id, location_id=loc_id, tenant_id=None,
    )
    db.add(d)
    await db.flush()
    return d


async def _backup(db, device_id, org_id, loc_id):
    from app.models.config_backup import ConfigBackup
    b = ConfigBackup(
        device_id=device_id, config_text="!", config_hash="h",
        organization_id=org_id, location_id=loc_id,
    )
    db.add(b)
    await db.flush()
    return b


def _ctx(**kw) -> LocationContext:
    base = dict(
        user_id=1, organization_id=1, system_role="org_admin",
        is_super_admin=False, is_org_wide=True,
        allowed_location_ids=(1, 2), active_location_id=1,
        requested_location_id=None, requested_location_rejected=False,
    )
    base.update(kw)
    return LocationContext(**base)


# ── ownership immutability — generic update may not carry location ───────────

def test_forbidden_ownership_fields_flags_location_id():
    assert forbidden_ownership_fields({"location_id": 5, "hostname": "x"}) == ["location_id"]


def test_forbidden_ownership_fields_flags_organization_id():
    assert "organization_id" in forbidden_ownership_fields({"organization_id": 2})


def test_forbidden_ownership_fields_flags_both():
    got = forbidden_ownership_fields({"location_id": 1, "organization_id": 2})
    assert set(got) == set(OWNERSHIP_FIELDS)


def test_forbidden_ownership_fields_clean_payload_is_empty():
    assert forbidden_ownership_fields({"hostname": "x", "site": "HQ"}) == []
    assert forbidden_ownership_fields(None) == []


# ── relocate_device_data — child rows follow the device ──────────────────────

@pytest.mark.asyncio
async def test_relocate_moves_child_rows_to_new_location():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        await _device(db, 10, 1, 1)
        await _backup(db, 10, 1, 1)
        await _backup(db, 10, 1, 1)
        await db.commit()

        moved = await relocate_device_data(db, 10, 2)
        await db.commit()

        from app.models.config_backup import ConfigBackup
        locs = (await db.execute(
            select(ConfigBackup.location_id).where(ConfigBackup.device_id == 10)
        )).scalars().all()
    assert moved.get("config_backups") == 2
    assert set(locs) == {2}          # both backups followed the device


@pytest.mark.asyncio
async def test_relocate_only_touches_the_moved_device():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        await _device(db, 10, 1, 1, ip="10.0.0.10")
        await _device(db, 11, 1, 1, ip="10.0.0.11")
        await _backup(db, 10, 1, 1)
        await _backup(db, 11, 1, 1)
        await db.commit()

        await relocate_device_data(db, 10, 2)
        await db.commit()

        from app.models.config_backup import ConfigBackup
        other = (await db.execute(
            select(ConfigBackup.location_id).where(ConfigBackup.device_id == 11)
        )).scalar_one()
    assert other == 1                # device 11's backup stayed put


# ── the audited move endpoint ────────────────────────────────────────────────

async def _move(db, device_id, target, user, ctx, reason="planned"):
    from app.api.v1.endpoints.devices import move_device_location
    return await move_device_location(
        device_id, DeviceMoveRequest(target_location_id=target, reason=reason),
        _fake_request(), db=db, current_user=user, ctx=ctx,
    )


@pytest.mark.asyncio
async def test_authorized_move_succeeds_and_relocates_data():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await _backup(db, 10, 1, 1)
        await db.commit()

        result = await _move(db, 10, 2, user, _ctx(allowed_location_ids=(1, 2)))
        assert result.location_id == 2

        from app.models.config_backup import ConfigBackup
        backup_loc = (await db.execute(
            select(ConfigBackup.location_id).where(ConfigBackup.device_id == 10)
        )).scalar_one()
    assert backup_loc == 2           # child data moved with the device


@pytest.mark.asyncio
async def test_successful_move_writes_audit_log():
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()

        await _move(db, 10, 2, user, _ctx(allowed_location_ids=(1, 2)), reason="reorg")

        from app.models.audit_log import AuditLog
        rows = (await db.execute(
            select(AuditLog).where(AuditLog.action == "device_moved")
        )).scalars().all()
    # The explicit Phase G move-endpoint audit row carries the reason and
    # the relocated-rows detail (the tenant-audit before_flush hook also
    # logs device_moved automatically — both are acceptable).
    explicit = [r for r in rows if (r.details or {}).get("reason") == "reorg"]
    assert explicit, "explicit device_moved audit row missing"
    row = explicit[0]
    assert row.before_state == {"location_id": 1}
    assert row.after_state == {"location_id": 2}
    assert row.details["previous_location_id"] == 1
    assert row.details["new_location_id"] == 2
    assert row.details["actor_user_id"] == 1


@pytest.mark.asyncio
async def test_move_to_same_location_rejected():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 1, user, _ctx(allowed_location_ids=(1,)))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_move_without_capability_rejected():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1, role=UserRole.VIEWER)  # no device:move
        await _device(db, 10, 1, 1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 2, user, _ctx(allowed_location_ids=(1, 2)))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_unauthorized_source_location_move_rejected():
    """The caller does not hold the device's current location."""
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)             # device in location 1
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 2, user, _ctx(allowed_location_ids=(2,)))  # no 1
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_unauthorized_target_location_move_rejected():
    """The caller does not hold the target location."""
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 2, user, _ctx(allowed_location_ids=(1,)))  # no 2
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_cross_org_move_rejected():
    """The target location belongs to another organization."""
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _org(db, 2, "bravo")
        await _location(db, 1, 1, "alpha-A")
        await _location(db, 9, 2, "bravo-X")    # other org
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        # caller's ctx even (wrongly) lists loc 9 as allowed — the
        # explicit cross-org check still refuses the move.
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 9, user, _ctx(allowed_location_ids=(1, 9)))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_move_to_deleted_location_rejected():
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B-archived", deleted=True)
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 2, user, _ctx(allowed_location_ids=(1, 2)))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_no_location_user_cannot_move_device():
    """A user with no accessible locations cannot move a device."""
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        with pytest.raises(HTTPException) as exc:
            await _move(db, 10, 2, user, _ctx(allowed_location_ids=()))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_rejected_move_is_logged(caplog):
    import logging
    from fastapi import HTTPException
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1)
        await _device(db, 10, 1, 1)
        await db.commit()
        with caplog.at_level(logging.WARNING, logger="netmanager.devices"):
            with pytest.raises(HTTPException):
                await _move(db, 10, 2, user, _ctx(allowed_location_ids=(2,)))
    assert any("device move rejected" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_super_admin_move_is_unconstrained():
    """A super-admin moves a device without being constrained by
    user_locations — explicit, and still audited."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        user = await _user(db, 1, 1, role=UserRole.SUPER_ADMIN)
        await _device(db, 10, 1, 1)
        await db.commit()
        result = await _move(
            db, 10, 2, user,
            _ctx(is_super_admin=True, allowed_location_ids=()),
        )
    assert result.location_id == 2


# ── device IP uniqueness — scoped to (organization, location) ────────────────

@pytest.mark.asyncio
async def test_overlapping_ip_across_locations_coexist():
    """Two locations may each have a device on the same private IP —
    overlapping ranges are legitimate (Phase G composite unique)."""
    from app.models.device import Device
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        await _device(db, 10, 1, 1, ip="192.168.1.1")
        await _device(db, 11, 1, 2, ip="192.168.1.1")   # same IP, location B
        await db.commit()
        rows = (await db.execute(select(Device.id))).scalars().all()
    assert set(rows) == {10, 11}     # both coexist — no global IP collision


@pytest.mark.asyncio
async def test_duplicate_ip_within_one_location_rejected():
    """An IP is still unique WITHIN a location."""
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _device(db, 10, 1, 1, ip="192.168.1.1")
        with pytest.raises(IntegrityError):
            await _device(db, 11, 1, 1, ip="192.168.1.1")  # same IP + location


@pytest.mark.asyncio
async def test_ip_location_match_keeps_devices_distinct():
    """Discovery matches by IP AND location — a same-IP device in another
    location is never matched (and so never reassigned)."""
    from app.models.device import Device
    async with _adb() as db:
        await _org(db, 1, "alpha")
        await _location(db, 1, 1, "A")
        await _location(db, 2, 1, "B")
        await _device(db, 10, 1, 1, ip="192.168.1.1")
        await _device(db, 11, 1, 2, ip="192.168.1.1")
        await db.commit()
        # an IP-only match is ambiguous across locations …
        ip_only = (await db.execute(
            select(Device.id).where(Device.ip_address == "192.168.1.1")
        )).scalars().all()
        # … the location-scoped match (what discovery uses) is exact.
        scoped = (await db.execute(
            select(Device.id).where(
                Device.ip_address == "192.168.1.1", Device.location_id == 2)
        )).scalars().all()
    assert set(ip_only) == {10, 11}
    assert scoped == [11]
