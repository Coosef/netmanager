"""SSH Session Termination — WS pub/sub listener integration test.

Karar #5 (2026-06-06): manuel browser smoke yeterli değil; en azından
'terminate publish → WS close' akışını doğrulayan otomatik test olmalı.

Bu test ``_ssh_terminate_listener`` helper'ını izole şekilde çalıştırır
ve sözleşmeyi doğrular:

  1. Eşleşen session_id mesajı yakaladığında:
     · ``evt`` set edilir
     · WebSocket'a ANSI kırmızı banner yazılır (admin uyarısı)
     · websocket.close(code=4000) çağrılır (browser xterm reconnect
       uyumlu özel kapanış kodu)
  2. Eşleşmeyen session_id mesajını yoksayar (multi-worker broadcast +
     filter pattern doğrulaması)
  3. Subscribe/unsubscribe lifecycle doğru (leak yok)

Redis 'live' bağlanmaz — sahte ``pubsub()`` async iterator + fake
WebSocket mock kullanılır. Pub/sub kanal kontratı kod seviyesinde
sabitlenir.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Fake Redis pubsub harness ──────────────────────────────────────────────


class _FakePubSub:
    """Test-controlled pub/sub yapısı. ``feed(message)`` çağrıları
    ``listen()`` iterator'ından sırayla yayılır."""

    def __init__(self):
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.subscribed: list[str] = []
        self.unsubscribed: list[str] = []
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def unsubscribe(self, channel: str) -> None:
        self.unsubscribed.append(channel)

    async def aclose(self) -> None:
        self.closed = True

    async def feed(self, payload: dict[str, Any]) -> None:
        """Test API: bir 'terminal:terminate' mesajı yayınla.
        payload['session_id'] dolu ise gerçek payload; aksi takdirde
        type=subscribe gibi handshake mesajı simüle eder."""
        if "session_id" in payload:
            await self._queue.put({
                "type": "message",
                "channel": "terminal:terminate",
                "data": json.dumps(payload),
            })
        else:
            await self._queue.put({"type": "subscribe", **payload})

    async def listen(self):
        while True:
            msg = await self._queue.get()
            yield msg


def _patch_redis_with_fake_pubsub(fake_pubsub: _FakePubSub):
    """``get_redis().pubsub()`` çağrısını ``fake_pubsub`` döndürecek
    şekilde yamalar."""
    fake_redis = MagicMock()
    fake_redis.pubsub = MagicMock(return_value=fake_pubsub)
    return patch("app.core.redis_client.get_redis", return_value=fake_redis)


def _fake_websocket() -> MagicMock:
    """Send_text + close çağrılarını kaydeden mock WebSocket."""
    ws = MagicMock()
    ws.send_text = AsyncMock(return_value=None)
    ws.close = AsyncMock(return_value=None)
    return ws


# ── 1. happy path: match → banner + close(4000) + evt set ──────────────────


@pytest.mark.asyncio
async def test_listener_matches_session_id_closes_ws_and_sets_evt():
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    pubsub = _FakePubSub()
    ws = _fake_websocket()
    evt = asyncio.Event()
    my_sid = "sid-mine"

    with _patch_redis_with_fake_pubsub(pubsub):
        task = asyncio.create_task(_ssh_terminate_listener(my_sid, ws, evt))
        # Subscribe ilk run'da gerçekleşir
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert pubsub.subscribed == ["terminal:terminate"]

        # Eşleşen mesajı yayınla
        await pubsub.feed({
            "session_id": my_sid,
            "reason": "admin force close",
            "terminated_by_user_id": 99,
            "terminated_by_username": "admin",
            "at": "2026-06-07T00:00:00Z",
        })

        # Listener mesajı işleyip bitir
        await asyncio.wait_for(task, timeout=2.0)

    assert evt.is_set(), "match → evt set olmalı"
    ws.send_text.assert_awaited_once()
    sent_text = ws.send_text.call_args[0][0]
    assert "terminated by" in sent_text
    assert "administrator" in sent_text
    ws.close.assert_awaited_once_with(code=4000)
    # Cleanup
    assert pubsub.unsubscribed == ["terminal:terminate"]
    assert pubsub.closed is True


# ── 2. non-matching session_id ignored (multi-worker broadcast filter) ─────


@pytest.mark.asyncio
async def test_listener_ignores_messages_for_other_sessions():
    """Multi-worker pub/sub: tüm worker'lar mesajı alır, sadece kendi
    session_id'sine eşleşeni işler."""
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    pubsub = _FakePubSub()
    ws = _fake_websocket()
    evt = asyncio.Event()
    my_sid = "sid-mine"

    with _patch_redis_with_fake_pubsub(pubsub):
        task = asyncio.create_task(_ssh_terminate_listener(my_sid, ws, evt))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        # Başkasının session_id'si
        await pubsub.feed({"session_id": "sid-someone-else"})
        await asyncio.sleep(0.05)

        assert not evt.is_set(), "Başkasının mesajı evt'yi set etmemeli"
        ws.send_text.assert_not_awaited()
        ws.close.assert_not_awaited()

        # Şimdi gerçekten kendi mesajı gelsin → match etmeli
        await pubsub.feed({"session_id": my_sid})
        await asyncio.wait_for(task, timeout=2.0)

    assert evt.is_set()
    ws.send_text.assert_awaited_once()
    ws.close.assert_awaited_once_with(code=4000)


# ── 3. malformed JSON ignored (resilience) ─────────────────────────────────


@pytest.mark.asyncio
async def test_listener_ignores_malformed_json_payload():
    """Bozuk payload kaynaklı bir spam mesajı (örn. başka servisin yanlış
    kanal kullanması) listener'ı çökertmemeli."""
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    pubsub = _FakePubSub()
    ws = _fake_websocket()
    evt = asyncio.Event()
    my_sid = "sid-mine"

    with _patch_redis_with_fake_pubsub(pubsub):
        task = asyncio.create_task(_ssh_terminate_listener(my_sid, ws, evt))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        # Bozuk JSON — manuel queue push
        await pubsub._queue.put({
            "type": "message", "channel": "terminal:terminate",
            "data": "not valid json {{{",
        })
        await asyncio.sleep(0.05)

        assert not evt.is_set()
        ws.send_text.assert_not_awaited()

        # Sonraki sağlam mesaj normal işlenmeli
        await pubsub.feed({"session_id": my_sid})
        await asyncio.wait_for(task, timeout=2.0)

    assert evt.is_set()
    ws.close.assert_awaited_once_with(code=4000)


# ── 4. cancellation cleanup ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_listener_cancellation_unsubscribes_and_closes_pubsub():
    """WS tarafı kapanırken finally bloğu ``_terminate_task.cancel()`` çağırır.
    Listener gracefully exit etmeli (unsubscribe + aclose)."""
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    pubsub = _FakePubSub()
    ws = _fake_websocket()
    evt = asyncio.Event()

    with _patch_redis_with_fake_pubsub(pubsub):
        task = asyncio.create_task(_ssh_terminate_listener("sid-mine", ws, evt))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert pubsub.subscribed == ["terminal:terminate"]

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert pubsub.unsubscribed == ["terminal:terminate"]
    assert pubsub.closed is True
    # Mesaj gelmediği için WS dokunulmadı
    ws.send_text.assert_not_awaited()
    ws.close.assert_not_awaited()
    assert not evt.is_set()


# ── 5. redis down (subscribe fail) — silently exit ─────────────────────────


@pytest.mark.asyncio
async def test_listener_silent_exit_when_redis_subscribe_fails():
    """Tasarım §10.7 — Redis kullanılamıyorsa listener sessizce çıkar;
    WS hattı kalır (revalidator + kullanıcı kapama akışı zaten var)."""
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    # subscribe() exception → pubsub.subscribe içinde patla
    failing_pubsub = MagicMock()
    failing_pubsub.subscribe = AsyncMock(
        side_effect=ConnectionError("redis subscribe down")
    )
    failing_pubsub.unsubscribe = AsyncMock(return_value=None)
    failing_pubsub.aclose = AsyncMock(return_value=None)

    fake_redis = MagicMock()
    fake_redis.pubsub = MagicMock(return_value=failing_pubsub)
    ws = _fake_websocket()
    evt = asyncio.Event()

    with patch("app.core.redis_client.get_redis", return_value=fake_redis):
        # Listener herhangi bir exception fırlatmadan dönmeli
        await _ssh_terminate_listener("sid-mine", ws, evt)

    assert not evt.is_set()
    ws.send_text.assert_not_awaited()
    ws.close.assert_not_awaited()


# ── 6. subscribe handshake (non-message types) skipped ──────────────────────


@pytest.mark.asyncio
async def test_listener_skips_non_message_types_like_subscribe_ack():
    """Redis subscribe handshake bir 'subscribe' type mesajı yollar
    (channel kabulü). Bu listener'ın gerçek 'message' mesajını
    yanlışlıkla ack ile karıştırmadığını doğrular."""
    from app.api.v1.endpoints.ws import _ssh_terminate_listener

    pubsub = _FakePubSub()
    ws = _fake_websocket()
    evt = asyncio.Event()

    with _patch_redis_with_fake_pubsub(pubsub):
        task = asyncio.create_task(_ssh_terminate_listener("sid-mine", ws, evt))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        # 'subscribe' type handshake mesajı
        await pubsub._queue.put({
            "type": "subscribe", "channel": "terminal:terminate", "data": 1,
        })
        await asyncio.sleep(0.05)

        assert not evt.is_set()
        ws.send_text.assert_not_awaited()

        # Gerçek match mesajı
        await pubsub.feed({"session_id": "sid-mine"})
        await asyncio.wait_for(task, timeout=2.0)

    assert evt.is_set()
    ws.close.assert_awaited_once_with(code=4000)
