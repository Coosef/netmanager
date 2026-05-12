"""
Agent offline event queue — SQLite WAL-backed.

Monitoring events (device_status_report, syslog_event, snmp_trap, local_anomaly)
are buffered here when the WebSocket connection is down. On reconnect they are
flushed to the server so no data is lost.

Design:
- WAL journal mode: safe against process crashes mid-write
- Thread-safe: collector threads write, asyncio forwarder reads
- Capacity: 500_000 unsent events (PRTG probe reference benchmark)
- Overflow: oldest unsent event is dropped to make room for newest
- TTL-based pruning: sent events older than 7 days are removed
"""

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

MAX_UNSENT = 500_000
PRUNE_AFTER_DAYS = 7
BATCH_SIZE = 200


class AgentEventQueue:
    def __init__(self, path: str = "/tmp/netmanager_events.db"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._path = path
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS q (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL    NOT NULL,
                payload TEXT    NOT NULL,
                sent    INTEGER NOT NULL DEFAULT 0,
                sent_at REAL
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_unsent ON q(sent, ts)"
        )
        self._conn.commit()

    def push(self, payload: dict) -> None:
        """Add one event to the queue. Drops oldest unsent event if at capacity."""
        with self._lock:
            unsent = self._conn.execute(
                "SELECT COUNT(*) FROM q WHERE sent=0"
            ).fetchone()[0]
            if unsent >= MAX_UNSENT:
                self._conn.execute(
                    "DELETE FROM q WHERE sent=0 AND id=("
                    "  SELECT MIN(id) FROM q WHERE sent=0"
                    ")"
                )
            self._conn.execute(
                "INSERT INTO q(ts, payload) VALUES(?, ?)",
                (time.time(), json.dumps(payload)),
            )
            self._conn.commit()

    def pop_batch(self) -> list[tuple[int, dict]]:
        """Return up to BATCH_SIZE unsent events. Does NOT mark them sent yet."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, payload FROM q WHERE sent=0 ORDER BY ts LIMIT ?",
                (BATCH_SIZE,),
            ).fetchall()
        return [(r[0], json.loads(r[1])) for r in rows]

    def ack(self, ids: list[int]) -> None:
        """Mark events as successfully delivered to the server."""
        if not ids:
            return
        with self._lock:
            self._conn.executemany(
                "UPDATE q SET sent=1, sent_at=? WHERE id=?",
                [(time.time(), i) for i in ids],
            )
            self._conn.commit()

    def pending_count(self) -> int:
        """Number of events not yet delivered."""
        with self._lock:
            return self._conn.execute(
                "SELECT COUNT(*) FROM q WHERE sent=0"
            ).fetchone()[0]

    def prune(self) -> int:
        """Delete sent events older than PRUNE_AFTER_DAYS. Returns deleted count."""
        cutoff = time.time() - (PRUNE_AFTER_DAYS * 86400)
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM q WHERE sent=1 AND sent_at < ?", (cutoff,)
            )
            self._conn.commit()
            return cur.rowcount
