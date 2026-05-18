"""
Faz 6C G3 + 6C.1 — event_consumer tests (multi-stream).

Coverage:
  * process_batch: empty no-op; syslog success persists+acks; SNMP success
    persists+acks; fresh failure leaves entries pending (no dead-letter);
    retry failure → dead-letter + ack.
  * Bounded persistence — process_batch opens exactly ONE worker session
    per batch regardless of batch size (KI-4 guard).
  * consume_cycle drains BOTH ingest streams; claim_due → claimed entries
    reprocessed as a retry batch; per-stream isolation.
"""
from unittest.mock import MagicMock

import pytest

from app.services.event_bus import STREAM_SNMP, STREAM_SYSLOG, StreamEntry


# ── Fake EventBus (stream-aware) ──────────────────────────────────────────────

class FakeBus:
    def __init__(self):
        self.acked: list[tuple[str, list[str]]] = []
        self.dead_lettered: list[tuple[str, list[StreamEntry]]] = []
        # per-stream canned results
        self.claim_result: dict[str, list[StreamEntry]] = {}
        self.consume_result: dict[str, list[StreamEntry]] = {}

    async def ack(self, stream, group, ids):
        self.acked.append((stream, list(ids)))
        return len(ids)

    async def to_dead_letter(self, stream, entries):
        self.dead_lettered.append((stream, list(entries)))

    async def claim_stale(self, stream, group, consumer, min_idle_ms, count):
        return self.claim_result.get(stream, [])

    async def consume_batch(self, stream, group, consumer, count, block_ms):
        return self.consume_result.get(stream, [])


def _entries(n, base="1"):
    return [StreamEntry(id=f"{base}-{i}", data={"message": f"m{i}"}) for i in range(n)]


def _patch_session(monkeypatch, *, fail=False, capture=None):
    """Patch make_worker_session + both stream persist handlers."""
    sessions_opened = []

    class _Ctx:
        async def __aenter__(self):
            sessions_opened.append(1)
            return MagicMock()
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(
        "app.core.database.make_worker_session", lambda: (lambda: _Ctx()),
    )

    async def stub_syslog(db, payloads, sync_redis):
        if fail:
            raise RuntimeError("DB write failed")
        if capture is not None:
            capture.extend(payloads)
        return len(payloads)

    async def stub_snmp(db, payloads):
        if fail:
            raise RuntimeError("DB write failed")
        if capture is not None:
            capture.extend(payloads)
        return len(payloads)

    monkeypatch.setattr(
        "app.services.syslog_ingest.persist_and_correlate", stub_syslog,
    )
    monkeypatch.setattr(
        "app.services.snmp_ingest.persist_snmp_batch", stub_snmp,
    )
    return sessions_opened


# ══════════════════════════════════════════════════════════════════════════════
# 1. process_batch
# ══════════════════════════════════════════════════════════════════════════════

class TestProcessBatch:

    @pytest.mark.asyncio
    async def test_empty_batch_noop(self):
        from app.services.event_consumer import process_batch
        bus = FakeBus()
        n = await process_batch(bus, STREAM_SYSLOG, [], MagicMock(), is_retry=False)
        assert n == 0
        assert bus.acked == []

    @pytest.mark.asyncio
    async def test_syslog_success_persists_and_acks(self, monkeypatch):
        from app.services.event_consumer import process_batch
        captured = []
        opened = _patch_session(monkeypatch, capture=captured)
        bus = FakeBus()
        entries = _entries(50)

        n = await process_batch(bus, STREAM_SYSLOG, entries, MagicMock(), is_retry=False)
        assert n == 50
        assert len(captured) == 50
        assert len(opened) == 1   # exactly ONE session for the batch (KI-4 guard)
        assert bus.acked == [(STREAM_SYSLOG, [e.id for e in entries])]
        assert bus.dead_lettered == []

    @pytest.mark.asyncio
    async def test_snmp_success_persists_and_acks(self, monkeypatch):
        from app.services.event_consumer import process_batch
        captured = []
        opened = _patch_session(monkeypatch, capture=captured)
        bus = FakeBus()
        entries = _entries(30, base="snmp")

        n = await process_batch(bus, STREAM_SNMP, entries, MagicMock(), is_retry=False)
        assert n == 30
        assert len(captured) == 30
        assert len(opened) == 1
        assert bus.acked == [(STREAM_SNMP, [e.id for e in entries])]

    @pytest.mark.asyncio
    async def test_fresh_failure_leaves_pending(self, monkeypatch):
        from app.services.event_consumer import process_batch
        _patch_session(monkeypatch, fail=True)
        bus = FakeBus()
        n = await process_batch(bus, STREAM_SYSLOG, _entries(10), MagicMock(), is_retry=False)
        assert n == 0
        assert bus.acked == []          # NOT acked → stays pending
        assert bus.dead_lettered == []  # NOT dead-lettered yet

    @pytest.mark.asyncio
    async def test_retry_failure_dead_letters_and_acks(self, monkeypatch):
        from app.services.event_consumer import process_batch
        _patch_session(monkeypatch, fail=True)
        bus = FakeBus()
        entries = _entries(10)
        n = await process_batch(bus, STREAM_SYSLOG, entries, MagicMock(), is_retry=True)
        assert n == 0
        assert len(bus.dead_lettered) == 1
        assert bus.dead_lettered[0][0] == STREAM_SYSLOG
        assert len(bus.dead_lettered[0][1]) == 10
        assert bus.acked == [(STREAM_SYSLOG, [e.id for e in entries])]


# ══════════════════════════════════════════════════════════════════════════════
# 2. consume_cycle — multi-stream
# ══════════════════════════════════════════════════════════════════════════════

class TestConsumeCycle:

    @pytest.mark.asyncio
    async def test_syslog_only_batch(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.consume_result[STREAM_SYSLOG] = _entries(20)

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 20
        # Only the syslog stream acked
        assert [s for s, _ in bus.acked] == [STREAM_SYSLOG]

    @pytest.mark.asyncio
    async def test_snmp_only_batch(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.consume_result[STREAM_SNMP] = _entries(15, base="snmp")

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 15
        assert [s for s, _ in bus.acked] == [STREAM_SNMP]

    @pytest.mark.asyncio
    async def test_both_streams_drained_one_cycle(self, monkeypatch):
        """A single cycle drains syslog AND snmp."""
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.consume_result[STREAM_SYSLOG] = _entries(12, base="sys")
        bus.consume_result[STREAM_SNMP] = _entries(8, base="snmp")

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 20   # 12 + 8
        acked_streams = sorted(s for s, _ in bus.acked)
        assert acked_streams == sorted([STREAM_SYSLOG, STREAM_SNMP])

    @pytest.mark.asyncio
    async def test_claim_due_reprocesses_stale_as_retry(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.claim_result[STREAM_SYSLOG] = _entries(5, base="stale")
        bus.consume_result[STREAM_SYSLOG] = _entries(8, base="fresh")

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=True)
        assert n == 13   # 5 reclaimed + 8 fresh
        # Two acks on the syslog stream — claimed batch + fresh batch
        syslog_acks = [a for a in bus.acked if a[0] == STREAM_SYSLOG]
        assert len(syslog_acks) == 2

    @pytest.mark.asyncio
    async def test_claim_skipped_when_not_due(self, monkeypatch):
        from app.services.event_consumer import consume_cycle
        _patch_session(monkeypatch)
        bus = FakeBus()
        bus.claim_result[STREAM_SYSLOG] = _entries(99, base="stale")
        bus.consume_result[STREAM_SYSLOG] = _entries(3)

        n = await consume_cycle(bus, MagicMock(), "c1", claim_due=False)
        assert n == 3   # only the fresh batch — claim_stale results ignored
