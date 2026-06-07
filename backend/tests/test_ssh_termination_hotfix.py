"""SSH Session Termination HOTFIX (2026-06-07) — backend test suite.

Hotfix kapsamı (docs/SSH_TERMINATION_RCA_2026-06-07.md):
  · HF#1: TerminalSessionLogger.close() race guard (ended_at IS NULL)
          + 'skipped because already ended' INFO log
  · HF#2: Endpoint direkt agent_manager.close_shell_session() çağrısı
  · HF#3: WS handler DB-poll fallback task (3sn interval)
  · HF#4: Structured logging (publisher + listener + poll task)

Mevcut 27 testten ayrı; pre-existing test'ler korunmaya devam eder.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.dialects.postgresql import JSONB as _JSONB
from sqlalchemy.ext.compiler import compiles as _compiles
from starlette.requests import Request

from app.core.database import Base
import app.models  # noqa: F401
from app.core.org_context import clear_org_context
from app.models.user import SystemRole, User


# SQLite test harness — JSONB sütunlarını JSON olarak render et.
@_compiles(_JSONB, "sqlite")
def _compile_jsonb_as_json_for_sqlite(element, compiler, **kw):  # pragma: no cover
    return "JSON"


def _create_tables(sync_conn):
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


class _db:
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
        "type": "http", "method": "POST",
        "path": "/terminal-sessions/x/terminate",
        "headers": [], "query_string": b"",
        "client": ("10.0.0.99", 5555),
    })


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


async def _seed_device(db, dev_id: int, org_id: int, loc_id: int, agent_id: str | None = None):
    from app.models.device import Device
    d = Device(
        id=dev_id, hostname=f"sw-{dev_id}", ip_address=f"10.10.0.{dev_id}",
        ssh_username="admin", ssh_password_enc="enc",
        organization_id=org_id, location_id=loc_id, agent_id=agent_id,
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


async def _seed_active_session(db, session_id: str, *, org_id=1, loc_id=1,
                               user_id=10, device_id=20, agent_id=None,
                               started_offset_s=600):
    from app.models.terminal_session_log import TerminalSessionLog
    started = datetime.now(timezone.utc) - timedelta(seconds=started_offset_s)
    row = TerminalSessionLog(
        session_id=session_id, user_id=user_id, device_id=device_id,
        agent_id=agent_id, organization_id=org_id, location_id=loc_id,
        client_ip="10.0.0.5", user_agent="pytest", connection_path="agent_relay",
        started_at=started, ended_at=None,
        input_bytes=0, output_bytes=0, commands_count=0, commands_extracted=[],
    )
    db.add(row)
    await db.flush()
    return row


# ═══════════════════════════════════════════════════════════════════════════
# HF#1 — TerminalSessionLogger.close() race guard
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_hf1_logger_close_no_op_when_ended_at_already_set(caplog):
    """RCA Bug #1 düzeltmesi — endpoint force_closed yazdıktan sonra
    user terminal'i kapatınca _term_logger.close() çağrısı no-op olmalı
    (force_closed üzerine user_closed YAZMAMALI)."""
    from app.services.terminal_session_logger import TerminalSessionLogger
    from app.models.terminal_session_log import TerminalSessionLog
    from sqlalchemy import update as _upd

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        row = await _seed_active_session(db, "sid-hf1", agent_id="agent-X")
        await db.commit()

        # Admin terminate önce çalışmış varsay: force_closed yazılı
        await db.execute(
            _upd(TerminalSessionLog).where(
                TerminalSessionLog.session_id == "sid-hf1",
            ).values(
                ended_at=datetime.now(timezone.utc),
                exit_reason="force_closed",
                duration_ms=58_000,
            )
        )
        await db.commit()

        # Şimdi WS finally çalışıyor → logger.close(user_closed) çağrısı
        logger_inst = TerminalSessionLogger(
            session_id="sid-hf1",
            user_id=10, device_id=20, agent_id="agent-X",
            organization_id=1, location_id=1,
            client_ip="10.0.0.5", user_agent="pytest",
            connection_path="agent_relay",
        )

        # Mevcut session_factory'yi mock'la (test SQLite engine)
        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)

        caplog.set_level(logging.INFO)
        await logger_inst.close(session_factory, exit_reason="user_closed")

        # DB satırı UNCHANGED olmalı — force_closed kalmalı.
        # NOT: session_factory ayrı session açar; orijinal db cache'i expire.
        db.expire_all()
        final = (await db.execute(
            select(TerminalSessionLog).where(TerminalSessionLog.session_id == "sid-hf1")
        )).scalar_one()
        assert final.exit_reason == "force_closed"  # KRİTİK — user_closed'a dönmedi

        # INFO log "skipped because already ended" yazıldı mı?
        skipped_logs = [
            r for r in caplog.records
            if "skipped because already ended" in r.message
        ]
        assert len(skipped_logs) == 1, (
            f"Expected 1 skipped log, got {len(skipped_logs)}. "
            f"All records: {[(r.name, r.levelname, r.message) for r in caplog.records]}"
        )
        assert getattr(skipped_logs[0], "session_id", None) == "sid-hf1"
        assert getattr(skipped_logs[0], "requested_exit_reason", None) == "user_closed"


@pytest.mark.asyncio
async def test_hf1_logger_close_writes_normally_when_ended_at_null():
    """Normal kullanım: terminate edilmediyse logger.close() satırı yazar
    (race guard normal akışı bozmaz)."""
    from app.services.terminal_session_logger import TerminalSessionLogger
    from app.models.terminal_session_log import TerminalSessionLog

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        row = await _seed_active_session(db, "sid-hf1b")
        await db.commit()

        logger_inst = TerminalSessionLogger(
            session_id="sid-hf1b",
            user_id=10, device_id=20, agent_id=None,
            organization_id=1, location_id=1,
            client_ip="10.0.0.5", user_agent="pytest",
            connection_path="direct_paramiko",
        )
        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)

        await logger_inst.close(session_factory, exit_reason="user_closed")

        db.expire_all()
        final = (await db.execute(
            select(TerminalSessionLog).where(TerminalSessionLog.session_id == "sid-hf1b")
        )).scalar_one()
        assert final.exit_reason == "user_closed"
        assert final.ended_at is not None


# ═══════════════════════════════════════════════════════════════════════════
# HF#2 — Endpoint direct agent_manager.close_shell_session()
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_hf2_endpoint_calls_agent_close_when_agent_id_present(caplog):
    """Agent path session'ları için endpoint pub/sub bağımsız direkt
    agent_manager.close_shell_session() çağırmalı. Pub/sub mesajı
    listener'a ulaşmasa bile agent shell kapanır."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1, agent_id="agent-X")
        await _seed_active_session(db, "sid-hf2", agent_id="agent-X")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        agent_close_mock = AsyncMock(return_value=None)
        with patch("app.core.redis_client.publish", new=AsyncMock()), \
             patch("app.services.agent_manager.agent_manager.close_shell_session",
                   new=agent_close_mock), \
             caplog.at_level(logging.INFO, logger="netmanager.terminal"):
            await terminate_session(
                "sid-hf2", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )

        agent_close_mock.assert_awaited_once_with("sid-hf2")

        # INFO log "direct agent close attempted"
        direct_logs = [
            r for r in caplog.records
            if "direct agent close" in r.message.lower()
        ]
        assert len(direct_logs) >= 1


@pytest.mark.asyncio
async def test_hf2_endpoint_skips_agent_close_when_agent_id_none():
    """Direct paramiko session'lar için agent_id=None, close_shell_session
    çağırılmamalı (agent registry'de zaten yok)."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1, agent_id=None)
        await _seed_active_session(db, "sid-hf2b", agent_id=None)
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        agent_close_mock = AsyncMock(return_value=None)
        with patch("app.core.redis_client.publish", new=AsyncMock()), \
             patch("app.services.agent_manager.agent_manager.close_shell_session",
                   new=agent_close_mock):
            await terminate_session(
                "sid-hf2b", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )

        agent_close_mock.assert_not_called()


@pytest.mark.asyncio
async def test_hf2_endpoint_continues_when_agent_close_raises(caplog):
    """Agent close başarısız olursa WARNING log + endpoint başarıyla tamamlanır
    (pub/sub veya DB-poll fallback kapatacak)."""
    from app.api.v1.endpoints.terminal_sessions import terminate_session
    from app.models.terminal_session_log import TerminalSessionLog

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_user(db, 10, 1)
        await _seed_device(db, 20, 1, 1, agent_id="agent-X")
        await _seed_active_session(db, "sid-hf2c", agent_id="agent-X")
        admin = await _seed_user(db, 99, 1, role=SystemRole.ORG_ADMIN)
        await db.commit()

        async def _boom(*a, **k):
            raise RuntimeError("agent disconnected")

        with patch("app.core.redis_client.publish", new=AsyncMock()), \
             patch("app.services.agent_manager.agent_manager.close_shell_session",
                   new=_boom), \
             caplog.at_level(logging.WARNING, logger="netmanager.terminal"):
            resp = await terminate_session(
                "sid-hf2c", request=_fake_request(),
                body=None, db=db, current_user=admin,
            )

        assert resp.status == "terminated"
        row = (await db.execute(
            select(TerminalSessionLog).where(TerminalSessionLog.session_id == "sid-hf2c")
        )).scalar_one()
        assert row.exit_reason == "force_closed"

        # WARNING log "agent close failed"
        warn_logs = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "agent close" in r.message.lower()
        ]
        assert len(warn_logs) >= 1


# ═══════════════════════════════════════════════════════════════════════════
# HF#3 — WS handler DB-poll fallback task
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_hf3_db_poll_detects_force_closed_and_closes_ws(caplog):
    """DB-poll task: session'ın ended_at NOT NULL + force_closed olduğu
    anda WS'i kapatır + evt.set + banner + close(4000)."""
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll
    from app.models.terminal_session_log import TerminalSessionLog
    from sqlalchemy import update as _upd

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_active_session(db, "sid-hf3", agent_id="agent-X")
        await db.commit()

        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)
        ws = MagicMock()
        ws.send_text = AsyncMock(return_value=None)
        ws.close = AsyncMock(return_value=None)
        evt = asyncio.Event()

        # Task başlat → polling
        task = asyncio.create_task(
            _ssh_termination_db_poll("sid-hf3", ws, evt,
                                     session_factory=session_factory,
                                     interval=0.1)
        )
        await asyncio.sleep(0.3)
        assert not evt.is_set()
        ws.close.assert_not_called()

        # Şimdi force_closed yaz
        await db.execute(
            _upd(TerminalSessionLog).where(
                TerminalSessionLog.session_id == "sid-hf3",
            ).values(
                ended_at=datetime.now(timezone.utc),
                exit_reason="force_closed",
            )
        )
        await db.commit()

        # Bir sonraki poll tick'te yakalansın
        with caplog.at_level(logging.INFO, logger="netmanager.terminal"):
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except asyncio.TimeoutError:
                task.cancel()
                pytest.fail("DB-poll task force_closed'u yakalamadı")

        assert evt.is_set()
        ws.send_text.assert_awaited()
        ws.close.assert_awaited_once_with(code=4000)


@pytest.mark.asyncio
async def test_hf3_db_poll_ignores_user_closed_exit_reason():
    """DB-poll sadece exit_reason='force_closed' için tetiklenir.
    user_closed/agent_disconnected gibi normal kapanışlar için
    WS'i kapatmaz (zaten user kendi kapatmış)."""
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll
    from app.models.terminal_session_log import TerminalSessionLog
    from sqlalchemy import update as _upd

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_active_session(db, "sid-hf3b")
        await db.commit()

        # user_closed yaz (admin terminate değil)
        await db.execute(
            _upd(TerminalSessionLog).where(
                TerminalSessionLog.session_id == "sid-hf3b",
            ).values(
                ended_at=datetime.now(timezone.utc),
                exit_reason="user_closed",
            )
        )
        await db.commit()

        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)
        ws = MagicMock()
        ws.send_text = AsyncMock(return_value=None)
        ws.close = AsyncMock(return_value=None)
        evt = asyncio.Event()

        # Task başlat ve birkaç poll tick bekle
        task = asyncio.create_task(
            _ssh_termination_db_poll("sid-hf3b", ws, evt,
                                     session_factory=session_factory,
                                     interval=0.1)
        )
        await asyncio.sleep(0.4)

        assert not evt.is_set()
        ws.close.assert_not_called()

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_hf3_db_poll_cancellation_cleanup():
    """Task cancel edilince gracefully çıkar (CancelledError raise eder)."""
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_active_session(db, "sid-hf3c")
        await db.commit()

        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)
        ws = MagicMock()
        ws.send_text = AsyncMock(return_value=None)
        ws.close = AsyncMock(return_value=None)
        evt = asyncio.Event()

        task = asyncio.create_task(
            _ssh_termination_db_poll("sid-hf3c", ws, evt,
                                     session_factory=session_factory,
                                     interval=0.1)
        )
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert not evt.is_set()
        ws.close.assert_not_called()


@pytest.mark.asyncio
async def test_hf3_db_poll_session_not_found_continues_polling():
    """Session DB'de yok ise (henüz INSERT tamamlanmamış olabilir),
    poll silently devam etsin, exception ile crash etmesin."""
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await db.commit()

        session_factory = async_sessionmaker(db.bind, expire_on_commit=False)
        ws = MagicMock()
        ws.send_text = AsyncMock(return_value=None)
        ws.close = AsyncMock(return_value=None)
        evt = asyncio.Event()

        task = asyncio.create_task(
            _ssh_termination_db_poll("sid-not-exist", ws, evt,
                                     session_factory=session_factory,
                                     interval=0.1)
        )
        await asyncio.sleep(0.4)
        assert not task.done() or task.exception() is None
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass


@pytest.mark.asyncio
async def test_hf3_db_poll_swallows_db_exceptions_warning_logged(caplog):
    """DB query exception fırlatırsa, WARNING log + poll devam et
    (sessizce çık değil, ama crash da değil)."""
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll

    async with _db() as db:
        await _seed_org(db, 1, "alpha")
        await _seed_location(db, 1, 1, "HQ")
        await _seed_active_session(db, "sid-hf3e")
        await db.commit()

        # SQLAlchemy bind close → her query exception fırlatacak
        session_factory_orig = async_sessionmaker(db.bind, expire_on_commit=False)

        # Custom factory: yarıya kadar normal, sonra exception
        call_count = {"n": 0}

        class _BrokenFactory:
            def __call__(self):
                call_count["n"] += 1
                if call_count["n"] >= 2:
                    raise RuntimeError("DB unavailable")
                return session_factory_orig()

        ws = MagicMock()
        ws.send_text = AsyncMock(return_value=None)
        ws.close = AsyncMock(return_value=None)
        evt = asyncio.Event()

        with caplog.at_level(logging.WARNING, logger="netmanager.terminal"):
            task = asyncio.create_task(
                _ssh_termination_db_poll("sid-hf3e", ws, evt,
                                         session_factory=_BrokenFactory(),
                                         interval=0.05)
            )
            await asyncio.sleep(0.3)

            # Task hâlâ çalışıyor (crash etmemiş)
            assert not task.done()
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass

        # En az 1 WARNING log
        warn_logs = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "ssh-term" in r.message.lower()
        ]
        assert len(warn_logs) >= 1


# ═══════════════════════════════════════════════════════════════════════════
# HF#4 — Structured logging (assertion sources)
# ═══════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_hf4_publish_logs_info_on_success(caplog):
    """publish() helper başarılı olduğunda INFO log ile subscriber sayısı
    yazılmalı (debug için)."""
    from app.core.redis_client import publish

    # Mock Redis client
    fake_redis = MagicMock()
    fake_redis.publish = AsyncMock(return_value=2)  # 2 subscriber

    with patch("app.core.redis_client.get_redis", return_value=fake_redis), \
         caplog.at_level(logging.INFO, logger="netmanager.redis"):
        await publish("terminal:terminate", {"session_id": "X"})

    # INFO log emitted
    info_logs = [
        r for r in caplog.records
        if r.levelno == logging.INFO and "publish" in r.message.lower()
    ]
    assert len(info_logs) >= 1


@pytest.mark.asyncio
async def test_hf4_publish_logs_warning_on_failure(caplog):
    """publish() helper Redis exception → WARNING log fırlatıp re-raise."""
    from app.core.redis_client import publish

    fake_redis = MagicMock()

    async def _boom(*a, **k):
        raise ConnectionError("redis down")
    fake_redis.publish = _boom

    with patch("app.core.redis_client.get_redis", return_value=fake_redis), \
         caplog.at_level(logging.WARNING, logger="netmanager.redis"):
        with pytest.raises(ConnectionError):
            await publish("terminal:terminate", {"session_id": "X"})

    warn_logs = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "publish" in r.message.lower()
    ]
    assert len(warn_logs) >= 1


def test_hf4_ssh_terminate_listener_source_has_structured_logs():
    """Source-level assertion: _ssh_terminate_listener fonksiyonu
    DEBUG (subscribe started, session_id mismatch) ve INFO (match,
    close requested) logları içermeli."""
    import inspect
    from app.api.v1.endpoints.ws import _ssh_terminate_listener
    src = inspect.getsource(_ssh_terminate_listener)

    # En az bir DEBUG / INFO çağrısı içermeli
    assert "log.debug" in src or "log.info" in src, \
        "Listener'da structured log eksik (HF#4)"
    # Subscribe started log
    assert "subscribe" in src.lower(), "subscribe lifecycle log eksik"
    # Match log
    assert "match" in src.lower() or "matched" in src.lower(), \
        "session_id match log eksik"


def test_hf4_ssh_termination_db_poll_source_has_structured_logs():
    """Source-level assertion: _ssh_termination_db_poll DEBUG (poll tick)
    + INFO (force_closed detected) içermeli."""
    import inspect
    from app.api.v1.endpoints.ws import _ssh_termination_db_poll
    src = inspect.getsource(_ssh_termination_db_poll)

    assert "log.debug" in src or "log.info" in src, \
        "DB-poll task'ta structured log eksik (HF#4)"
    assert "force_closed" in src, "force_closed detection log eksik"
