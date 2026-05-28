"""
Structured logging configuration (structlog + stdlib bridge).
Call configure_logging() once at process startup:
  - FastAPI: before lifespan in main.py
  - Celery: via @worker_process_init.connect in workers/signals.py

All existing logging.getLogger() callers automatically get structlog formatting
via the ProcessorFormatter bridge — no per-module changes needed.
"""
import logging
import re
import sys

import structlog

from app.core.config import settings

# Fields whose values are replaced with [REDACTED] in every log record.
# T10 B4.1 — authorization/cookie/bearer eklendi (header sızıntısı). Substring
# match: "cookie" → set_cookie/set-cookie de yakalar; "authorization" → Authorization.
_SENSITIVE_KEYS = frozenset({
    "password", "ssh_password", "enable_secret", "snmp_community",
    "snmp_v3_auth_passphrase", "snmp_v3_priv_passphrase",
    "token", "access_token", "refresh_token",
    "secret", "secret_key", "api_key",
    "credential", "passphrase", "private_key", "webhook_headers",
    "credential_encryption_key",
    "authorization", "cookie", "bearer",
})

# T10 B4.1 — değer içinde token maskesi (key bazlı değil). Bearer <token> ve
# JWT (eyJ...) desenleri mesaj/değer string'lerinde maskelenir.
_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+")
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*")

# T10 B4.1 — log_category: downstream aggregator'ın (Loki/ELK) ayrıştırması için
# logger isminden türetilir. Kategoriler: access/audit/security/db/task/app/health/ws.
_CATEGORY_BY_LOGGER = {
    "netmanager.http": "access",
    "uvicorn.access": "access",
    "netmanager.health": "health",
    "netmanager.ws": "ws",
    "netmanager.security": "security",
    "netmanager.tenant_audit": "audit",
    "netmanager.audit": "audit",          # B4.3 audit dual-emit
    "netmanager.celery": "task",
    "netmanager.task_scope": "task",
}


def _log_category(logger_name: str) -> str:
    if not logger_name:
        return "app"
    if logger_name in _CATEGORY_BY_LOGGER:
        return _CATEGORY_BY_LOGGER[logger_name]
    if logger_name.startswith("sqlalchemy"):
        return "db"
    if logger_name.startswith(("celery", "amqp", "kombu")):
        return "task"
    return "app"


def _add_log_category(_logger, _method, event_dict: dict) -> dict:
    """Logger isminden log_category ekle (caller explicit verdiyse korunur)."""
    event_dict.setdefault("log_category", _log_category(event_dict.get("logger", "")))
    return event_dict


def _drop_sensitive(_logger, _method, event_dict: dict) -> dict:
    """Structlog processor: redact sensitive fields before any renderer sees them."""
    for key in list(event_dict.keys()):
        if any(s in key.lower() for s in _SENSITIVE_KEYS):
            event_dict[key] = "[REDACTED]"
    return event_dict


def _mask_token_values(_logger, _method, event_dict: dict) -> dict:
    """Değer string'lerinde Bearer/JWT token desenlerini maskele (key redaction'a ek).
    Ucuz ön-kontrol: yalnız 'bearer'/'eyj' içeren string'lerde regex çalışır."""
    for key, val in list(event_dict.items()):
        if isinstance(val, str) and len(val) >= 12:
            low = val.lower()
            if "bearer" in low or "eyj" in low:
                val = _BEARER_RE.sub(r"\1[REDACTED]", val)
                val = _JWT_RE.sub("[REDACTED_JWT]", val)
                event_dict[key] = val
    return event_dict


def configure_logging() -> None:
    """Configure structlog + stdlib root logger. Idempotent (safe to call twice)."""
    level_name = settings.LOG_LEVEL.upper()
    level = getattr(logging, level_name, logging.INFO)
    use_json = settings.LOG_FORMAT == "json"

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        _add_log_category,                 # logger → log_category (add_logger_name'den sonra)
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _drop_sensitive,                   # key bazlı redaction
        _mask_token_values,                # değer içi Bearer/JWT maskesi
    ]

    structlog.configure(
        processors=shared_processors + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    renderer = (
        structlog.processors.JSONRenderer()
        if use_json
        else structlog.dev.ConsoleRenderer(colors=False)
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processor=renderer,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Suppress noisy third-party loggers in production
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(level)
    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.DEBUG if settings.DEBUG else logging.WARNING
    )
    logging.getLogger("celery").setLevel(level)
    logging.getLogger("amqp").setLevel(logging.WARNING)
