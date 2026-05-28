"""T10 B4.2 — security event log stream (`netmanager.security`).

Auth/güvenlik olaylarını gerçek-zamanlı bir structured log akışına yazar
(SIEM/Loki: brute-force, anomali, 403 tespiti). `netmanager.security` logger'ı
B4.1'de `log_category=security` etiketini alır; request_id middleware'in
contextvars binding'i sayesinde her satırda otomatik bulunur.

DB `audit_logs` (audit_service) DURUMUNU DEĞİŞTİRMEZ — o, kalıcı/uyumluluk
kayıt-of-truth olarak kalır. Bu akış ona PARALEL gerçek-zamanlı güvenlik görünümü.
Tasarım gereği bazı olaylar (örn. login_failed) hem audit hem security'de görünür.
"""
from __future__ import annotations

from typing import Optional

import structlog

_log = structlog.get_logger("netmanager.security")

# Başarısızlık/red → warning; başarı/bilgi → info.
_WARN_RESULTS = frozenset({"failure", "denied", "blocked", "error"})


def _client_ip(request) -> Optional[str]:
    if request is None:
        return None
    xff = request.headers.get("x-forwarded-for") if request.headers else None
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if getattr(request, "client", None) else None


def log_security_event(
    event: str,
    *,
    result: str,
    request=None,
    username: Optional[str] = None,
    user_id: Optional[int] = None,
    reason: Optional[str] = None,
    **extra,
) -> None:
    """Bir güvenlik olayını `netmanager.security`'ye yaz. result: success |
    failure | denied | blocked | error. IP istekten çıkarılır (maskelenmez —
    güvenlik analizi için). Token/cookie vb. logging redaction'ı (B4.1) yine uygulanır."""
    fields: dict = {"security_event": event, "result": result}
    if username is not None:
        fields["username"] = username
    if user_id is not None:
        fields["user_id"] = user_id
    ip = _client_ip(request)
    if ip:
        fields["client_ip"] = ip
    if reason:
        fields["reason"] = reason
    fields.update(extra)
    emit = _log.warning if result in _WARN_RESULTS else _log.info
    emit(event, **fields)
