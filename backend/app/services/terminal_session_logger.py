"""TerminalSessionLogger — interaktif SSH session audit (T9 Tur 3A).

WS handler tarafından kullanılır. Lifecycle:

    logger = await TerminalSessionLogger.create(db_session_factory, ...)
    # WS açık olduğu sürece:
    logger.log_input(b"show vlan brief\\n")    # senkron buffer, hızlı
    logger.log_output(b"...vlan output...")     # senkron buffer
    # Session bitince:
    await logger.close(exit_reason="user_closed")

Tasarım notları:
  - **Sync log API**: WS task'ı bloklamamak için DB write yapmayız;
    in-memory buffer'a yazarız.
  - **Komut çıkarma heuristic**: input buffer'da newline gördükçe komut
    olarak çıkar (`\\r`, `\\n`, `\\r\\n`). Detaylı prompt parsing yok
    (vendor-specific çok zor); yine de büyük çoğunluğu yakalar.
  - **Output excerpt**: son ~10KB tutulur (deque-style). 10K aşılırsa
    eski bytes drop edilir → memory bounded.
  - **Komut limiti**: 5000 komut sonrası overflow flag — DB row şişmesin.
  - **Bytes counts**: cumulative — close anında DB'ye yazılır.
  - **AI summary**: ai_summary_status='pending' ile insert; Tur 3B
    Celery task'ı bunu polling/queue ile yakalar (sonraki increment).
  - **DB factory**: close() yeni AsyncSessionLocal açar (WS request session
    çoktan kapanmış olabilir).
"""
from __future__ import annotations

import logging
import re
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update as _sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.terminal_session_log import TerminalSessionLog

log = logging.getLogger(__name__)

# ── Limits — memory bounds ─────────────────────────────────────────────────
MAX_OUTPUT_EXCERPT_BYTES = 10 * 1024     # 10 KB
MAX_COMMANDS_PER_SESSION = 5000          # daha sonra cap — log büyümesin
MAX_COMMAND_LEN = 512                    # tek komut max uzunluk

# Komut sınırlayıcı: CR / LF / CRLF. Boş satırları atlamayalım — kullanıcı
# sadece Enter'a basmış olabilir (ama loga koyma).
_LINE_BREAK_RE = re.compile(rb"[\r\n]+")

# Görünmez kontrol karakterlerini temizle (ANSI escape vb. komutun kendisi
# değildir; sadece okunabilir kalsın diye stripping yapıyoruz).
_ANSI_CTRL_RE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]")


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class TerminalSessionLogger:
    """Per-WS session audit logger. Thread-unsafe (tek WS task'ında çalışır)."""

    def __init__(
        self,
        *,
        session_id: str,
        user_id: Optional[int],
        device_id: Optional[int],
        agent_id: Optional[str],
        organization_id: int,
        location_id: Optional[int],
        client_ip: Optional[str],
        user_agent: Optional[str],
        connection_path: str,  # 'agent_relay' | 'direct_paramiko'
    ):
        self.session_id = session_id
        self.user_id = user_id
        self.device_id = device_id
        self.agent_id = agent_id
        self.organization_id = organization_id
        self.location_id = location_id
        self.client_ip = client_ip
        self.user_agent = user_agent
        self.connection_path = connection_path

        self._started_at = datetime.now(timezone.utc)
        self._started_at_ms = int(self._started_at.timestamp() * 1000)
        self._input_bytes = 0
        self._output_bytes = 0
        self._commands: list[dict] = []
        self._cmd_overflow = False
        # Output excerpt — son ~10KB
        self._output_buf: deque[bytes] = deque()
        self._output_buf_size = 0
        # Komut çıkarma için biriktirme buffer
        self._input_buf = b""
        self._closed = False

    @classmethod
    async def create(
        cls,
        db: AsyncSession,
        *,
        session_id: Optional[str] = None,
        user_id: Optional[int],
        device_id: Optional[int],
        agent_id: Optional[str],
        organization_id: int,
        location_id: Optional[int],
        client_ip: Optional[str],
        user_agent: Optional[str],
        connection_path: str,
    ) -> "TerminalSessionLogger":
        """Insert kayıt + logger instance döner."""
        sid = session_id or uuid.uuid4().hex
        logger = cls(
            session_id=sid,
            user_id=user_id, device_id=device_id, agent_id=agent_id,
            organization_id=organization_id, location_id=location_id,
            client_ip=client_ip, user_agent=user_agent,
            connection_path=connection_path,
        )
        try:
            row = TerminalSessionLog(
                session_id=sid,
                user_id=user_id, device_id=device_id, agent_id=agent_id,
                organization_id=organization_id, location_id=location_id,
                client_ip=client_ip, user_agent=user_agent,
                connection_path=connection_path,
                started_at=logger._started_at,
                commands_extracted=[],
                commands_count=0,
                ai_summary_status="pending",
            )
            db.add(row)
            await db.commit()
        except Exception as exc:
            log.warning("TerminalSessionLogger.create insert hata: %r", exc)
            try:
                await db.rollback()
            except Exception:
                pass
        return logger

    def log_input(self, data: bytes) -> None:
        """Browser → device input. Sync; sadece in-memory buffer.

        T9 Tur 3A fix: byte-byte tarama. Önceki versiyon raw byte'ı buffer'a
        append edip CR/LF'te split ediyordu; ama interactive shell'de
        backspace (0x08/0x7f), Ctrl-C (0x03), ok tuşları ve ESC sequence'leri
        buffer'da birikip 'lls --llaann' gibi tekrarlanmış komutlar üretiyordu.
        Şimdi:
          - printable ASCII (0x20-0x7e) buffer'a eklenir
          - backspace/DEL son karakteri kaldırır (gerçek shell davranışı)
          - Ctrl-C / Ctrl-U buffer'ı sıfırlar
          - ESC sequence'leri (ok tuşları vs.) tamamen yok sayılır
          - CR/LF komut commit'i tetikler
        """
        if self._closed or not data:
            return
        self._input_bytes += len(data)

        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            # ESC dizisi atla — '\x1b[<...>' tipinde 2-3 byte tipik
            if ch == 0x1b:
                i += 1
                # CSI parametre + final
                if i < n and data[i] == 0x5b:  # '['
                    i += 1
                    while i < n and not (0x40 <= data[i] <= 0x7e):
                        i += 1
                i += 1
                continue
            if ch in (0x0a, 0x0d):  # \n, \r — commit
                if self._input_buf:
                    cmd = self._clean_command(self._input_buf)
                    if cmd:
                        self._append_command(cmd)
                    self._input_buf = b""
                i += 1
                continue
            if ch in (0x08, 0x7f):  # backspace, DEL
                if self._input_buf:
                    self._input_buf = self._input_buf[:-1]
                i += 1
                continue
            if ch in (0x03, 0x15):  # Ctrl-C, Ctrl-U — clear line
                self._input_buf = b""
                i += 1
                continue
            if 0x20 <= ch <= 0x7e:  # printable ASCII
                self._input_buf += bytes([ch])
                i += 1
                continue
            # UTF-8 high bytes (Türkçe karakter vs.) — keep
            if ch >= 0x80:
                self._input_buf += bytes([ch])
                i += 1
                continue
            # Diğer kontrol karakterleri (TAB vb.) yoksay
            i += 1

        # Komut buffer'ı çok uzarsa truncate (vim, less, ssh-into-ssh
        # senaryolarında newline gelmeyebilir)
        if len(self._input_buf) > 4096:
            self._input_buf = self._input_buf[-2048:]

    def log_output(self, data: bytes) -> None:
        """Device → browser output. Sync; deque'a koy + truncate."""
        if self._closed or not data:
            return
        self._output_bytes += len(data)
        self._output_buf.append(data)
        self._output_buf_size += len(data)
        # 10KB'lik pencereyi kaydırırken eski bytes'ı düş
        while self._output_buf_size > MAX_OUTPUT_EXCERPT_BYTES and self._output_buf:
            old = self._output_buf.popleft()
            self._output_buf_size -= len(old)

    async def close(
        self,
        session_factory,
        exit_reason: str = "user_closed",
    ) -> None:
        """Final flush — DB row update. session_factory = AsyncSessionLocal.
        Yeni session açıp UPDATE atar (WS request session'u çoktan kapalı)."""
        if self._closed:
            return
        self._closed = True

        ended_at = datetime.now(timezone.utc)
        duration_ms = int((ended_at - self._started_at).total_seconds() * 1000)

        # Kalan input buffer'da komut varsa son komut olarak çıkar
        if self._input_buf:
            cmd = self._clean_command(self._input_buf)
            if cmd:
                self._append_command(cmd)
            self._input_buf = b""

        # Output excerpt — bytes → str (UTF-8, kontrol karakterlerini strip)
        try:
            raw_excerpt = b"".join(self._output_buf)
            stripped = _ANSI_CTRL_RE.sub(b"", raw_excerpt)
            excerpt = stripped.decode("utf-8", errors="replace")
            if len(excerpt) > MAX_OUTPUT_EXCERPT_BYTES:
                excerpt = excerpt[-MAX_OUTPUT_EXCERPT_BYTES:]
        except Exception:
            excerpt = None

        try:
            async with session_factory() as db2:
                # RLS GUC — agent_offline pattern (commit sonrası geri set)
                from sqlalchemy import text as _sql_text
                await db2.execute(_sql_text(
                    "SELECT set_config('app.is_super_admin','off',true),"
                    "       set_config('app.current_org_id', :o, true)"
                ), {"o": str(self.organization_id)})
                await db2.execute(
                    _sa_update(TerminalSessionLog).where(
                        TerminalSessionLog.session_id == self.session_id,
                    ).values(
                        ended_at=ended_at,
                        duration_ms=duration_ms,
                        exit_reason=exit_reason,
                        input_bytes=self._input_bytes,
                        output_bytes=self._output_bytes,
                        commands_extracted=self._commands,
                        commands_count=len(self._commands),
                        output_excerpt=excerpt,
                    )
                )
                await db2.commit()
        except Exception as exc:
            log.warning("TerminalSessionLogger.close UPDATE hata: %r", exc)

    # ── Internal ──────────────────────────────────────────────────────────
    def _clean_command(self, raw: bytes) -> str:
        """Kontrol karakterlerini at, decode et, trim et. Boş ise '' döner."""
        try:
            cleaned = _ANSI_CTRL_RE.sub(b"", raw)
            s = cleaned.decode("utf-8", errors="replace").strip()
            return s[:MAX_COMMAND_LEN]
        except Exception:
            return ""

    def _append_command(self, cmd: str) -> None:
        if self._cmd_overflow or not cmd:
            return
        if len(self._commands) >= MAX_COMMANDS_PER_SESSION:
            self._cmd_overflow = True
            self._commands.append({"t": _now_ms() - self._started_at_ms,
                                   "cmd": "[truncated: more commands than limit]"})
            return
        self._commands.append({
            "t": _now_ms() - self._started_at_ms,  # session başlangıcına göre offset
            "cmd": cmd,
        })
