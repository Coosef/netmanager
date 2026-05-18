"""
Faz 6C G1 — EventBus (Redis Streams abstraction) tests.

Coverage:
  * publish: XADD round-trip, datetime payloads, Redis-down → None,
    non-serializable payload → None (never raises)
  * ensure_group: creates group+stream; BUSYGROUP is idempotent
  * consume_batch: publish→consume round-trip, only new entries, empty on
    no data, unparseable `data` field skipped
  * ack: removes entries from the group's pending set
  * claim_stale: XAUTOCLAIM returns still-pending (crashed-consumer) entries
  * to_dead_letter: failed entries re-published to <stream>:dead
  * depth / group_lag observability
  * helpers _parse_pairs / _parse_xreadgroup

A FakeStreamRedis simulates the subset of Redis Streams the EventBus uses.
"""
import json
from datetime import datetime, timezone

import pytest
from redis.exceptions import RedisError, ResponseError

from app.services.event_bus import (
    EventBus,
    StreamEntry,
    _parse_pairs,
    _parse_xreadgroup,
    STREAM_SYSLOG,
    GROUP_PERSIST,
)


# ── Fake Redis Streams ────────────────────────────────────────────────────────

class FakeStreamRedis:
    def __init__(self):
        self.streams: dict[str, list] = {}            # stream -> [(id, {data}), ...]
        self.groups: dict[tuple, dict] = {}           # (stream,group) -> {delivered, pending}
        self._seq = 0
        self.down = False

    def _next_id(self) -> str:
        self._seq += 1
        return f"1-{self._seq}"

    async def xadd(self, stream, fields, maxlen=None, approximate=True):
        if self.down:
            raise RedisError("simulated down")
        eid = self._next_id()
        self.streams.setdefault(stream, []).append((eid, dict(fields)))
        if maxlen and len(self.streams[stream]) > maxlen:
            self.streams[stream] = self.streams[stream][-maxlen:]
        return eid

    async def xgroup_create(self, stream, group, id="0", mkstream=False):
        if self.down:
            raise RedisError("simulated down")
        key = (stream, group)
        if key in self.groups:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        if mkstream:
            self.streams.setdefault(stream, [])
        self.groups[key] = {"delivered": 0, "pending": {}}

    async def xreadgroup(self, group, consumer, streams, count=None, block=None):
        if self.down:
            raise RedisError("simulated down")
        out = []
        for stream in streams:
            g = self.groups.get((stream, group))
            if g is None:
                continue
            entries = self.streams.get(stream, [])
            start = g["delivered"]
            new = entries[start:start + (count or len(entries))]
            if new:
                g["delivered"] = start + len(new)
                for eid, fields in new:
                    g["pending"][eid] = (consumer, fields)
                out.append([stream, new])
        return out

    async def xack(self, stream, group, *ids):
        if self.down:
            raise RedisError("simulated down")
        g = self.groups.get((stream, group))
        if not g:
            return 0
        n = 0
        for i in ids:
            if i in g["pending"]:
                del g["pending"][i]
                n += 1
        return n

    async def xautoclaim(self, stream, group, consumer, min_idle, start_id="0-0", count=None):
        if self.down:
            raise RedisError("simulated down")
        g = self.groups.get((stream, group))
        if not g:
            return ("0-0", [], [])
        pend = [(eid, fields) for eid, (_c, fields) in g["pending"].items()]
        return ("0-0", pend[:count] if count else pend, [])

    async def xlen(self, stream):
        if self.down:
            raise RedisError("simulated down")
        return len(self.streams.get(stream, []))

    async def xinfo_groups(self, stream):
        if self.down:
            raise RedisError("simulated down")
        out = []
        for (s, grp), g in self.groups.items():
            if s == stream:
                total = len(self.streams.get(s, []))
                out.append({
                    "name": grp,
                    "pending": len(g["pending"]),
                    "lag": total - g["delivered"],
                })
        return out


def _bus():
    r = FakeStreamRedis()
    return EventBus(r), r


# ══════════════════════════════════════════════════════════════════════════════
# 1. publish
# ══════════════════════════════════════════════════════════════════════════════

class TestPublish:

    @pytest.mark.asyncio
    async def test_publish_returns_entry_id(self):
        bus, r = _bus()
        eid = await bus.publish(STREAM_SYSLOG, {"message": "hello"})
        assert eid is not None
        assert len(r.streams[STREAM_SYSLOG]) == 1

    @pytest.mark.asyncio
    async def test_publish_datetime_payload(self):
        bus, r = _bus()
        ts = datetime(2026, 5, 18, 9, 0, 0, tzinfo=timezone.utc)
        await bus.publish(STREAM_SYSLOG, {"received_at": ts, "message": "m"})
        # Stored as JSON in the single `data` field; datetime → isoformat
        _eid, fields = r.streams[STREAM_SYSLOG][0]
        decoded = json.loads(fields["data"])
        assert decoded["received_at"] == ts.isoformat()

    @pytest.mark.asyncio
    async def test_publish_redis_down_returns_none(self):
        bus, r = _bus()
        r.down = True
        eid = await bus.publish(STREAM_SYSLOG, {"message": "x"})
        assert eid is None   # caller falls back, no exception

    @pytest.mark.asyncio
    async def test_publish_non_serializable_returns_none(self):
        bus, _r = _bus()
        eid = await bus.publish(STREAM_SYSLOG, {"bad": object()})
        assert eid is None

    @pytest.mark.asyncio
    async def test_publish_respects_maxlen(self):
        bus, r = _bus()
        for i in range(10):
            await bus.publish(STREAM_SYSLOG, {"i": i}, maxlen=5)
        assert len(r.streams[STREAM_SYSLOG]) == 5


# ══════════════════════════════════════════════════════════════════════════════
# 2. ensure_group
# ══════════════════════════════════════════════════════════════════════════════

class TestEnsureGroup:

    @pytest.mark.asyncio
    async def test_creates_group_and_stream(self):
        bus, r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        assert (STREAM_SYSLOG, GROUP_PERSIST) in r.groups

    @pytest.mark.asyncio
    async def test_busygroup_is_idempotent(self):
        bus, _r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        # Second call must not raise (BUSYGROUP swallowed)
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)


# ══════════════════════════════════════════════════════════════════════════════
# 3. consume_batch
# ══════════════════════════════════════════════════════════════════════════════

class TestConsumeBatch:

    @pytest.mark.asyncio
    async def test_publish_then_consume_round_trip(self):
        bus, _r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        await bus.publish(STREAM_SYSLOG, {"message": "a"})
        await bus.publish(STREAM_SYSLOG, {"message": "b"})

        batch = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        assert len(batch) == 2
        assert all(isinstance(e, StreamEntry) for e in batch)
        assert {e.data["message"] for e in batch} == {"a", "b"}

    @pytest.mark.asyncio
    async def test_consume_returns_only_new_entries(self):
        bus, _r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        await bus.publish(STREAM_SYSLOG, {"message": "first"})
        first = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        assert len(first) == 1
        # Nothing new → empty
        again = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        assert again == []
        # New entry appears
        await bus.publish(STREAM_SYSLOG, {"message": "second"})
        third = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        assert len(third) == 1
        assert third[0].data["message"] == "second"

    @pytest.mark.asyncio
    async def test_consume_redis_down_returns_empty(self):
        bus, r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        r.down = True
        batch = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        assert batch == []

    @pytest.mark.asyncio
    async def test_unparseable_entry_skipped(self):
        bus, r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        await bus.publish(STREAM_SYSLOG, {"message": "good"})
        # Inject a corrupt entry directly
        r.streams[STREAM_SYSLOG].append(("9-9", {"data": "{not json"}))
        batch = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        # Corrupt one skipped, good one kept
        assert len(batch) == 1
        assert batch[0].data["message"] == "good"


# ══════════════════════════════════════════════════════════════════════════════
# 4. ack + claim_stale
# ══════════════════════════════════════════════════════════════════════════════

class TestAckAndClaim:

    @pytest.mark.asyncio
    async def test_ack_removes_from_pending(self):
        bus, r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        await bus.publish(STREAM_SYSLOG, {"message": "a"})
        batch = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", block_ms=0)
        g = r.groups[(STREAM_SYSLOG, GROUP_PERSIST)]
        assert len(g["pending"]) == 1

        acked = await bus.ack(STREAM_SYSLOG, GROUP_PERSIST, [e.id for e in batch])
        assert acked == 1
        assert len(g["pending"]) == 0

    @pytest.mark.asyncio
    async def test_ack_empty_ids_noop(self):
        bus, _r = _bus()
        assert await bus.ack(STREAM_SYSLOG, GROUP_PERSIST, []) == 0

    @pytest.mark.asyncio
    async def test_claim_stale_returns_pending(self):
        """A crashed consumer's un-acked entries are reclaimable."""
        bus, _r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        await bus.publish(STREAM_SYSLOG, {"message": "orphan"})
        # consumer "dead" reads but never acks
        await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "dead", block_ms=0)
        # consumer "fresh" reclaims
        claimed = await bus.claim_stale(STREAM_SYSLOG, GROUP_PERSIST, "fresh", min_idle_ms=0)
        assert len(claimed) == 1
        assert claimed[0].data["message"] == "orphan"


# ══════════════════════════════════════════════════════════════════════════════
# 5. dead-letter + observability
# ══════════════════════════════════════════════════════════════════════════════

class TestDeadLetterAndObservability:

    @pytest.mark.asyncio
    async def test_to_dead_letter_republishes(self):
        bus, r = _bus()
        entries = [StreamEntry(id="1-1", data={"message": "failed"})]
        await bus.to_dead_letter(STREAM_SYSLOG, entries)
        dead = f"{STREAM_SYSLOG}:dead"
        assert dead in r.streams
        assert len(r.streams[dead]) == 1

    @pytest.mark.asyncio
    async def test_depth(self):
        bus, _r = _bus()
        for _ in range(3):
            await bus.publish(STREAM_SYSLOG, {"m": "x"})
        assert await bus.depth(STREAM_SYSLOG) == 3

    @pytest.mark.asyncio
    async def test_group_lag(self):
        bus, _r = _bus()
        await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
        for _ in range(5):
            await bus.publish(STREAM_SYSLOG, {"m": "x"})
        # Nothing consumed yet → lag 5
        assert await bus.group_lag(STREAM_SYSLOG, GROUP_PERSIST) == 5
        await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1", count=2, block_ms=0)
        assert await bus.group_lag(STREAM_SYSLOG, GROUP_PERSIST) == 3


# ══════════════════════════════════════════════════════════════════════════════
# 6. parsing helpers
# ══════════════════════════════════════════════════════════════════════════════

class TestParsingHelpers:

    def test_parse_pairs_skips_missing_and_corrupt(self):
        pairs = [
            ("1-1", {"data": json.dumps({"ok": 1})}),
            ("1-2", {}),                       # no data field
            ("1-3", {"data": "{broken"}),      # corrupt JSON
            ("1-4", {"data": json.dumps({"ok": 2})}),
        ]
        out = _parse_pairs(pairs)
        assert len(out) == 2
        assert [e.data["ok"] for e in out] == [1, 2]

    def test_parse_xreadgroup_flattens_streams(self):
        resp = [
            ["ingest:syslog", [("1-1", {"data": json.dumps({"a": 1})})]],
        ]
        out = _parse_xreadgroup(resp)
        assert len(out) == 1
        assert out[0].data == {"a": 1}

    def test_parse_xreadgroup_empty(self):
        assert _parse_xreadgroup(None) == []
        assert _parse_xreadgroup([]) == []
