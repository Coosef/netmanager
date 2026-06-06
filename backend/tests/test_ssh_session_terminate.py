"""SSH Session Termination — backend test suite.

Kapsam:
  · RBAC verb (terminal_sessions:terminate) SYSTEM_ROLE_PERMISSIONS
    map'inin doğru rollere grant ettiğini doğrula
  · audit_service.log_action organization_id_override default davranışı
    bozmadığını + override verildiğinde session'ın org'una stamp ettiğini
    doğrula
  · POST /terminal-sessions/{id}/terminate endpoint'i (happy path,
    410 idempotent, 404 not found, race, exit_reason='force_closed',
    audit details snapshot)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

from app.core.database import Base
import app.models  # noqa: F401 — model registry + scoping hook
from app.core.org_context import clear_org_context
from app.models.user import SYSTEM_ROLE_PERMISSIONS, SystemRole, User


# SQLite test harness — JSONB sütunlarını JSON olarak render et (PostgreSQL
# JSONB tipi SQLite'da derleyemez; mevcut test paterni Faz 8 testlerinde
# JSONB içeren tabloları kullanmıyor, biz TerminalSessionLog için ekledik).
from sqlalchemy.dialects.postgresql import JSONB as _JSONB
from sqlalchemy.ext.compiler import compiles as _compiles


@_compiles(_JSONB, "sqlite")
def _compile_jsonb_as_json_for_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


# ── 1. RBAC verb map ────────────────────────────────────────────────────────


def test_rbac_super_admin_has_wildcard_terminal_sessions_terminate():
    """super_admin '*' wildcard → her verb 'terminal_sessions:terminate' dahil."""
    u = SimpleNamespace(system_role=SystemRole.SUPER_ADMIN)
    assert User.has_permission(u, "terminal_sessions:terminate") is True


def test_rbac_org_admin_can_terminate():
    """ORG_ADMIN listesinde 'terminal_sessions:terminate' grant edildi."""
    u = SimpleNamespace(system_role=SystemRole.ORG_ADMIN)
    assert User.has_permission(u, "terminal_sessions:terminate") is True


def test_rbac_location_admin_can_terminate():
    """LOCATION_ADMIN listesinde 'terminal_sessions:terminate' grant edildi."""
    u = SimpleNamespace(system_role=SystemRole.LOCATION_ADMIN)
    assert User.has_permission(u, "terminal_sessions:terminate") is True


def test_rbac_viewer_cannot_terminate():
    """VIEWER deny-by-default (minimal grant set)."""
    u = SimpleNamespace(system_role=SystemRole.VIEWER)
    assert User.has_permission(u, "terminal_sessions:terminate") is False


def test_rbac_member_cannot_terminate():
    """MEMBER deny-by-default."""
    u = SimpleNamespace(system_role=SystemRole.MEMBER)
    assert User.has_permission(u, "terminal_sessions:terminate") is False


def test_rbac_verb_registered_in_org_admin_and_location_admin():
    """Direkt SYSTEM_ROLE_PERMISSIONS map kontrolü — diğer testleri
    spec drift'e karşı backstop'lar."""
    assert "terminal_sessions:terminate" in SYSTEM_ROLE_PERMISSIONS[SystemRole.ORG_ADMIN]
    assert "terminal_sessions:terminate" in SYSTEM_ROLE_PERMISSIONS[SystemRole.LOCATION_ADMIN]
    assert "terminal_sessions:terminate" not in SYSTEM_ROLE_PERMISSIONS[SystemRole.VIEWER]
    assert "terminal_sessions:terminate" not in SYSTEM_ROLE_PERMISSIONS[SystemRole.MEMBER]


# ── 2. audit_service.organization_id_override ───────────────────────────────


def _create_audit_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.user import User as _U
    from app.models.audit_log import AuditLog
    Base.metadata.create_all(sync_conn, tables=[
        Organization.__table__, _U.__table__, AuditLog.__table__,
    ])


class _adb:
    """Async in-memory SQLite session helper (mevcut test paterni)."""

    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_audit_tables)
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


async def _seed_org(db, oid: int, slug: str):
    from app.models.shared.organization import Organization
    o = Organization(id=oid, name=slug.title(), slug=slug)
    db.add(o)
    await db.flush()
    return o


async def _seed_user(db, uid: int, org_id: int, role=SystemRole.ORG_ADMIN):
    u = User(
        id=uid, username=f"u{uid}", email=f"u{uid}@x.io",
        hashed_password="h", organization_id=org_id, system_role=role,
    )
    db.add(u)
    await db.flush()
    return u


@pytest.mark.asyncio
async def test_audit_log_action_default_uses_user_organization_id():
    """Backward-compat: organization_id_override verilmezse
    user.organization_id'ye stamp eder (eski semantik korunur)."""
    from app.services import audit_service
    from app.models.audit_log import AuditLog

    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        u = await _seed_user(db, 10, 1)
        await db.commit()
        await audit_service.log_action(
            db, user=u, action="test.legacy_default",
        )
        row = (await db.execute(
            select(AuditLog).where(AuditLog.action == "test.legacy_default")
        )).scalar_one()
        assert row.organization_id == 1


@pytest.mark.asyncio
async def test_audit_log_action_organization_id_override_stamps_explicit_value():
    """SSH Termination scenario: super_admin başka org'daki session'ı
    sonlandırırsa, organization_id_override=row.organization_id ile
    audit row session'ın org'una yazılır."""
    from app.services import audit_service
    from app.models.audit_log import AuditLog

    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_org(db, 2, "beta")
        super_user = await _seed_user(db, 99, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()
        # super_admin org=1'de, target session org=2'de
        await audit_service.log_action(
            db, user=super_user, action="terminal_sessions.terminate",
            organization_id_override=2,
        )
        row = (await db.execute(
            select(AuditLog).where(AuditLog.action == "terminal_sessions.terminate")
        )).scalar_one()
        # Override session'ın org'una stamp
        assert row.organization_id == 2


@pytest.mark.asyncio
async def test_audit_log_action_override_none_falls_back_to_user_org():
    """organization_id_override=None default davranıştan ayrılmaz."""
    from app.services import audit_service
    from app.models.audit_log import AuditLog

    async with _adb() as db:
        await _seed_org(db, 1, "alpha")
        u = await _seed_user(db, 10, 1)
        await db.commit()
        await audit_service.log_action(
            db, user=u, action="test.none_override",
            organization_id_override=None,
        )
        row = (await db.execute(
            select(AuditLog).where(AuditLog.action == "test.none_override")
        )).scalar_one()
        assert row.organization_id == 1


@pytest.mark.asyncio
async def test_audit_log_action_override_zero_is_respected_not_falsy():
    """organization_id_override=0 falsy değil — bilinçli verildi sayılır.
    (Pratikte 0 org_id yok ama parametre semantiği için kritik:
    None vs not-None ayrımı 'falsy' kontrolüyle yapılmamalı.)"""
    from app.services import audit_service
    from app.models.audit_log import AuditLog

    async with _adb() as db:
        await _seed_org(db, 0, "zero")
        await _seed_org(db, 1, "alpha")
        u = await _seed_user(db, 10, 1)
        await db.commit()
        await audit_service.log_action(
            db, user=u, action="test.zero_override",
            organization_id_override=0,
        )
        row = (await db.execute(
            select(AuditLog).where(AuditLog.action == "test.zero_override")
        )).scalar_one()
        # 'is not None' kontrolü → 0 explicit kabul edilir
        assert row.organization_id == 0


# ── 3. terminate endpoint ───────────────────────────────────────────────────


def _create_endpoint_tables(sync_conn):
    from app.models.shared.organization import Organization
    from app.models.location import Location
    from app.models.user import User as _U
    from app.models.device import Device
    from app.models.audit_log import AuditLog
    from app.models.terminal_session_log import TerminalSessionLog
    Base.metadata.create_all(sync_conn, tables=[
        Organization.__table__, Location.__table__, _U.__table__,
        Device.__table__, AuditLog.__table__, TerminalSessionLog.__table__,
    ])


class _edb:
    async def __aenter__(self):
        self._engine = create_async_engine("sqlite+aiosqlite://")
        async with self._engine.begin() as conn:
            await conn.run_sync(_create_endpoint_tables)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)()
        return self._session

    async def __aexit__(self, *exc):
        await self._session.close()
        await self._engine.dispose()


def _fake_request() -> Request:
    return Request({
        "type": "http", "method": "POST",
        "path": "/terminal-sessions/x/terminate",
        "headers": [], "query_string": b"",
        "client": ("10.0.0.99", 5555),
    })


async def _seed_active_session(db, session_id: str, *, org_id=1, loc_id=1,
                               user_id=10, device_id=20, started_offset_s=600):
    from app.models.terminal_session_log import TerminalSessionLog
    started = datetime.now(timezone.utc) - timedelta(seconds=started_offset_s)
    row = TerminalSessionLog(
        session_id=session_id,
        user_id=user_id,
        device_id=device_id,
        agent_id=None,
        organization_id=org_id,
        location_id=loc_id,
        client_ip="10.0.0.5",
        user_agent="pytest-ua",
        connection_path="direct_paramiko",
        started_at=started,
        ended_at=None,
        input_bytes=0,
        output_bytes=0,
        commands_count=0,
        commands_extracted=[],
    )
    db.add(row)
    await db.flush()
    return row


async def _seed_device(db, dev_id: int, org_id: int, loc_id: int):
    from app.models.device import Device
    d = Device(
        id=dev_id, hostname=f"sw-{dev_id}", ip_address=f"10.10.0.{dev_id}",
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org_id, location_id=loc_id,
    )
    db.add(d)
    await db.flush()
    return d


async def _seed_location(db, lid: int, org_id: int, name: str):
    from app.models.location import Location
    loc = Location(id=lid, name=name, organization_id=org_id)
    db.add(loc)
    await db.flush()
    return loc


@pytest.mark.asyncio
async def test_terminate_happy_path_sets_ended_at_and_force_closed():
    from app.api.v1.endpoints.terminal_sessions import (
        terminate_session, TerminateSessionRequest,
    )
    from app.models.terminal_session_log import TerminalSessionLog

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1)
        await _seed_active_session(db, "sid-happy")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        # Pub/sub publish'i mock'la (Redis test ortamında yok)
        with patch("app.core.redis_client.publish", new=AsyncMock()):
            resp = await terminate_session(
                "sid-happy",
                request=_fake_request(),
                body=TerminateSessionRequest(reason="Investigation"),
                db=db,
                current_user=admin,
            )

        assert resp.status == "terminated"
        assert resp.websocket_close_pending is True
        assert resp.audit_log_id is None
        assert resp.duration_seconds > 0

        # DB doğrulama
        row = (await db.execute(
            select(TerminalSessionLog).where(TerminalSessionLog.session_id == "sid-happy")
        )).scalar_one()
        assert row.ended_at is not None
        assert row.exit_reason == "force_closed"
        assert row.duration_ms is not None and row.duration_ms > 0


@pytest.mark.asyncio
async def test_terminate_returns_410_when_already_closed():
    from fastapi import HTTPException
    from app.api.v1.endpoints.terminal_sessions import terminate_session

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1)
        row = await _seed_active_session(db, "sid-closed")
        # Önce kapat
        row.ended_at = datetime.now(timezone.utc)
        row.exit_reason = "user_closed"
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        with pytest.raises(HTTPException) as exc:
            await terminate_session(
                "sid-closed", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )
        assert exc.value.status_code == 410
        assert exc.value.detail["code"] == "session_already_closed"


@pytest.mark.asyncio
async def test_terminate_returns_404_when_session_not_found():
    from fastapi import HTTPException
    from app.api.v1.endpoints.terminal_sessions import terminate_session

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        with pytest.raises(HTTPException) as exc:
            await terminate_session(
                "no-such-session", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )
        assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_terminate_default_reason_when_body_is_none():
    """Karar #1 — reason opsiyonel, default 'force_terminated_by_admin'.
    Audit details.termination_reason bu default'u içermeli."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session
    from app.models.audit_log import AuditLog

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1)
        await _seed_active_session(db, "sid-default-reason")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        with patch("app.core.redis_client.publish", new=AsyncMock()):
            await terminate_session(
                "sid-default-reason", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )

        audit = (await db.execute(
            select(AuditLog).where(AuditLog.action == "terminal_sessions.terminate")
        )).scalar_one()
        assert audit.details["termination_reason"] == "force_terminated_by_admin"


@pytest.mark.asyncio
async def test_terminate_audit_includes_session_snapshot_and_terminator():
    """Audit log details — tasarım §7.1 16 alanlı snapshot."""
    from app.api.v1.endpoints.terminal_sessions import (
        terminate_session, TerminateSessionRequest,
    )
    from app.models.audit_log import AuditLog

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)  # session user
        await _seed_device(db, 20, 1, 1)
        await _seed_active_session(db, "sid-audit")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        with patch("app.core.redis_client.publish", new=AsyncMock()):
            await terminate_session(
                "sid-audit", request=_fake_request(),
                body=TerminateSessionRequest(reason="Compliance audit"),
                db=db, current_user=admin,
            )

        audit = (await db.execute(
            select(AuditLog).where(AuditLog.action == "terminal_sessions.terminate")
        )).scalar_one()
        d = audit.details
        assert d["termination_reason"] == "Compliance audit"
        assert d["terminated_by_user_id"] == 99
        assert d["terminated_by_username"] == "u99"
        assert d["session_user_id"] == 10
        assert d["session_username"] == "u10"
        assert d["device_id"] == 20
        assert d["target_ip"] == "10.10.0.20"
        assert "started_at" in d and "terminated_at" in d
        assert d["duration_seconds"] >= 0
        # before/after state
        assert audit.before_state == {"ended_at": None, "exit_reason": None, "status": "active"}
        assert audit.after_state["exit_reason"] == "force_closed"
        assert audit.after_state["status"] == "closed"


@pytest.mark.asyncio
async def test_terminate_cross_org_stamps_audit_to_session_organization():
    """Karar #4 — super_admin başka org session'ını terminate ederse,
    audit organization_id session'ın org'unda yazılmalı."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session
    from app.models.audit_log import AuditLog

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")  # super_admin'in org'u
        await _seed_org(db, 2, "beta")   # target session'ın org'u
        await _seed_location(db, 2, 2, "Beta-HQ")
        await _seed_user(db, 10, 2)
        await _seed_device(db, 20, 2, 2)
        await _seed_active_session(
            db, "sid-cross-org", org_id=2, loc_id=2, user_id=10, device_id=20,
        )
        sa = await _seed_user(db, 99, 1, role=SystemRole.SUPER_ADMIN)
        await db.commit()

        with patch("app.core.redis_client.publish", new=AsyncMock()):
            await terminate_session(
                "sid-cross-org", request=_fake_request(),
                body=None, db=db, current_user=sa,
            )

        audit = (await db.execute(
            select(AuditLog).where(AuditLog.action == "terminal_sessions.terminate")
        )).scalar_one()
        # super_admin org=1 olsa da audit row session'ın org=2'sine yazılmalı
        assert audit.organization_id == 2
        assert audit.user_id == 99
        assert audit.username == "u99"


@pytest.mark.asyncio
async def test_terminate_redis_publish_failure_does_not_block_db_update():
    """Tasarım §10.7 — pub/sub publish hatası gracefully handle edilir,
    DB UPDATE devam eder (WS 30sn revalidate ile kapanır)."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session
    from app.models.terminal_session_log import TerminalSessionLog

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1)
        await _seed_active_session(db, "sid-redis-down")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        async def _boom(*a, **k):
            raise ConnectionError("redis down")

        with patch("app.core.redis_client.publish", new=_boom):
            resp = await terminate_session(
                "sid-redis-down", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )

        assert resp.status == "terminated"
        row = (await db.execute(
            select(TerminalSessionLog).where(TerminalSessionLog.session_id == "sid-redis-down")
        )).scalar_one()
        assert row.exit_reason == "force_closed"


@pytest.mark.asyncio
async def test_terminate_race_guard_returns_410_when_update_rowcount_zero():
    """Tasarım §10.6 — concurrent terminate veya stale_cleanup beat ile
    aynı anda. İlk UPDATE ended_at = X, ikincisi WHERE ended_at IS NULL
    şartını sağlayamaz, rowcount=0 → 410."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.terminal_sessions import terminate_session
    from app.models.terminal_session_log import TerminalSessionLog
    from sqlalchemy import update

    async with _edb() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1)
        await _seed_active_session(db, "sid-race")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        # Endpoint içinde publish sonrası, UPDATE öncesi başka bir process
        # (örn. stale_cleanup) önce kapatmış. Bunu simüle etmek için
        # publish hook'una ended_at yaz.
        async def _race_publish(channel, message):
            stmt = update(TerminalSessionLog).where(
                TerminalSessionLog.session_id == "sid-race",
            ).values(
                ended_at=datetime.now(timezone.utc),
                exit_reason="stale_cleanup",
            )
            await db.execute(stmt)
            await db.commit()

        with patch("app.core.redis_client.publish", new=_race_publish):
            with pytest.raises(HTTPException) as exc:
                await terminate_session(
                    "sid-race", request=_fake_request(),
                    body=None, db=db, current_user=admin,
                )
        assert exc.value.status_code == 410


# ── 4. Pydantic schema validation ───────────────────────────────────────────


def test_terminate_request_accepts_short_reason():
    from app.api.v1.endpoints.terminal_sessions import TerminateSessionRequest
    r = TerminateSessionRequest(reason="OK")
    assert r.reason == "OK"


def test_terminate_request_rejects_reason_over_256_chars():
    """Pydantic max_length=256 enforce."""
    from app.api.v1.endpoints.terminal_sessions import TerminateSessionRequest
    with pytest.raises(Exception):  # pydantic ValidationError
        TerminateSessionRequest(reason="x" * 257)


def test_terminate_request_allows_none_reason():
    from app.api.v1.endpoints.terminal_sessions import TerminateSessionRequest
    r = TerminateSessionRequest(reason=None)
    assert r.reason is None
    r2 = TerminateSessionRequest()
    assert r2.reason is None
