"""
Faz 6C G2 — syslog ingestion → event bus, with bounded fallback.

Coverage:
  * _handle_syslog_event publishes to the event bus; on publish success the
    fallback is NOT touched.
  * On publish failure (None) the bounded fallback_persist runs.
  * persist_and_correlate bulk-inserts in ONE commit and dispatches
    correlation only for availability-impacting events.
  * fallback_persist is bounded by the module semaphore.
  * _parse_dt accepts datetime / ISO string / None.
"""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


UTC = timezone.utc


# ══════════════════════════════════════════════════════════════════════════════
# 1. _parse_dt
# ══════════════════════════════════════════════════════════════════════════════

class TestParseDt:

    def test_datetime_passthrough(self):
        from app.services.syslog_ingest import _parse_dt
        dt = datetime(2026, 5, 18, 9, 0, tzinfo=UTC)
        assert _parse_dt(dt) is dt

    def test_iso_string_parsed(self):
        from app.services.syslog_ingest import _parse_dt
        dt = datetime(2026, 5, 18, 9, 0, tzinfo=UTC)
        assert _parse_dt(dt.isoformat()) == dt

    def test_garbage_falls_back_to_now(self):
        from app.services.syslog_ingest import _parse_dt
        out = _parse_dt("not-a-date")
        assert isinstance(out, datetime)

    def test_none_falls_back_to_now(self):
        from app.services.syslog_ingest import _parse_dt
        assert isinstance(_parse_dt(None), datetime)


# ══════════════════════════════════════════════════════════════════════════════
# 2. persist_and_correlate
# ══════════════════════════════════════════════════════════════════════════════

def _mock_db(device_id=None, agent_scope=(("a", 1, 7),)):
    """AsyncSession mock: add_all sync, commit async, execute → result.

    Faz 8 phase C — persist_and_correlate first resolves each agent to
    (organization_id, location_id) via a `.all()` query, then resolves the
    syslog source_ip to a device via `.scalar_one_or_none()`. The single
    result mock answers both: `.all()` yields the agent-scope rows
    (agent_id, org_id, loc_id), `.scalar_one_or_none()` yields the device.
    """
    db = MagicMock()
    db.add_all = MagicMock()
    db.commit = AsyncMock()
    result = MagicMock()
    result.all.return_value = list(agent_scope)
    result.scalar_one_or_none.return_value = device_id
    db.execute = AsyncMock(return_value=result)
    return db


class TestPersistAndCorrelate:

    @pytest.mark.asyncio
    async def test_empty_payloads_noop(self):
        from app.services.syslog_ingest import persist_and_correlate
        db = _mock_db()
        n = await persist_and_correlate(db, [], MagicMock())
        assert n == 0
        db.add_all.assert_not_called()

    @pytest.mark.asyncio
    async def test_bulk_insert_single_commit(self, monkeypatch):
        """N payloads → one add_all + one commit (not N commits)."""
        from app.services import syslog_ingest
        # No event is availability-impacting → no correlation branch
        monkeypatch.setattr(
            "app.services.syslog_normalizer.normalize", lambda f, s, m: None,
        )
        db = _mock_db()
        payloads = [
            {"agent_id": "a", "source_ip": "10.0.0.1", "facility": 1,
             "severity": 5, "message": f"msg{i}", "received_at": datetime.now(UTC)}
            for i in range(50)
        ]
        n = await syslog_ingest.persist_and_correlate(db, payloads, MagicMock())
        assert n == 50
        assert db.add_all.call_count == 1
        assert db.commit.await_count == 1            # ONE commit for 50 rows
        assert len(db.add_all.call_args[0][0]) == 50

    @pytest.mark.asyncio
    async def test_correlation_fires_for_availability_event(self, monkeypatch):
        from app.services import syslog_ingest

        # normalize → an availability-impacting event
        norm = SimpleNamespace(
            event_type="port_down", component="Gi0/1",
            is_problem=True, severity="critical",
        )
        monkeypatch.setattr(
            "app.services.syslog_normalizer.normalize", lambda f, s, m: norm,
        )
        monkeypatch.setattr(
            "app.services.syslog_normalizer.AVAILABILITY_EVENT_TYPES",
            frozenset({"port_down"}),
        )
        corr_calls = []

        async def stub_process_event(**kwargs):
            corr_calls.append(kwargs)
        monkeypatch.setattr(
            "app.services.correlation_engine.process_event", stub_process_event,
        )

        db = _mock_db(device_id=7)   # source_ip resolves to device 7
        payload = {"agent_id": "a", "source_ip": "10.0.0.1", "facility": 1,
                   "severity": 2, "message": "link down", "received_at": datetime.now(UTC)}
        await syslog_ingest.persist_and_correlate(db, [payload], MagicMock())

        assert len(corr_calls) == 1
        assert corr_calls[0]["device_id"] == 7
        assert corr_calls[0]["event_type"] == "port_down"
        assert corr_calls[0]["source"] == "syslog"

    @pytest.mark.asyncio
    async def test_no_correlation_for_unknown_device(self, monkeypatch):
        from app.services import syslog_ingest
        norm = SimpleNamespace(event_type="port_down", component="d",
                               is_problem=True, severity="critical")
        monkeypatch.setattr("app.services.syslog_normalizer.normalize",
                            lambda f, s, m: norm)
        monkeypatch.setattr("app.services.syslog_normalizer.AVAILABILITY_EVENT_TYPES",
                            frozenset({"port_down"}))
        corr_calls = []
        async def stub(**kw): corr_calls.append(kw)
        monkeypatch.setattr("app.services.correlation_engine.process_event", stub)

        db = _mock_db(device_id=None)   # source_ip does NOT resolve
        payload = {"agent_id": "a", "source_ip": "1.2.3.4", "facility": 1,
                   "severity": 2, "message": "x", "received_at": datetime.now(UTC)}
        await syslog_ingest.persist_and_correlate(db, [payload], MagicMock())
        assert corr_calls == []   # no device → no correlation


# ══════════════════════════════════════════════════════════════════════════════
# 3. fallback_persist
# ══════════════════════════════════════════════════════════════════════════════

class TestFallbackPersist:

    @pytest.mark.asyncio
    async def test_fallback_persist_success(self, monkeypatch):
        from app.services import syslog_ingest

        captured = []

        async def stub_pac(db, payloads, sync_redis):
            captured.extend(payloads)
            return len(payloads)
        monkeypatch.setattr(syslog_ingest, "persist_and_correlate", stub_pac)

        # make_worker_session()() must be an async context manager
        class _FakeSessionCtx:
            async def __aenter__(self): return MagicMock()
            async def __aexit__(self, *a): return False
        monkeypatch.setattr(
            "app.core.database.make_worker_session", lambda: (lambda: _FakeSessionCtx()),
        )

        payload = {"agent_id": "a", "message": "m"}
        ok = await syslog_ingest.fallback_persist(payload, MagicMock())
        assert ok is True
        assert captured == [payload]

    @pytest.mark.asyncio
    async def test_fallback_persist_swallows_errors(self, monkeypatch):
        from app.services import syslog_ingest

        def boom():
            raise RuntimeError("DB unreachable")
        monkeypatch.setattr("app.core.database.make_worker_session", boom)

        ok = await syslog_ingest.fallback_persist({"message": "m"}, MagicMock())
        assert ok is False   # never raises

    def test_fallback_semaphore_is_bounded(self):
        """The fallback semaphore must cap concurrency (KI-4 guard)."""
        from app.services import syslog_ingest
        from app.core.config import settings
        # Semaphore initial value == configured concurrency
        assert syslog_ingest._fallback_sem._value == settings.SYSLOG_FALLBACK_CONCURRENCY


# ══════════════════════════════════════════════════════════════════════════════
# 4. _handle_syslog_event — publish vs fallback
# ══════════════════════════════════════════════════════════════════════════════

class TestHandleSyslogEvent:

    @pytest.mark.asyncio
    async def test_publish_success_skips_fallback(self, monkeypatch):
        from app.services.agent_manager import AgentManager
        from app.services import event_bus, syslog_ingest

        # event bus publish succeeds
        fake_bus = MagicMock()
        fake_bus.publish = AsyncMock(return_value="1-1")
        monkeypatch.setattr(event_bus, "get_event_bus", lambda: fake_bus)

        fallback_called = []
        async def stub_fallback(payload, redis):
            fallback_called.append(payload)
            return True
        monkeypatch.setattr(syslog_ingest, "fallback_persist", stub_fallback)

        mgr = AgentManager()
        await mgr._handle_syslog_event("agent_a", {
            "source_ip": "10.0.0.1", "facility": 1, "severity": 5, "message": "m",
        })
        fake_bus.publish.assert_awaited_once()
        assert fallback_called == []   # publish worked → no fallback

    @pytest.mark.asyncio
    async def test_publish_failure_triggers_fallback(self, monkeypatch):
        from app.services.agent_manager import AgentManager
        from app.services import event_bus, syslog_ingest

        # event bus publish fails (returns None)
        fake_bus = MagicMock()
        fake_bus.publish = AsyncMock(return_value=None)
        monkeypatch.setattr(event_bus, "get_event_bus", lambda: fake_bus)

        fallback_called = []
        async def stub_fallback(payload, redis):
            fallback_called.append(payload)
            return True
        monkeypatch.setattr(syslog_ingest, "fallback_persist", stub_fallback)

        mgr = AgentManager()
        await mgr._handle_syslog_event("agent_b", {
            "source_ip": "10.0.0.2", "facility": 1, "severity": 5, "message": "down",
        })
        assert len(fallback_called) == 1
        assert fallback_called[0]["agent_id"] == "agent_b"
        assert fallback_called[0]["message"] == "down"
