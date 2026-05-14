"""
Structured logging configuration (structlog + stdlib bridge).
Call configure_logging() once at process startup:
  - FastAPI: before lifespan in main.py
  - Celery: via @worker_process_init.connect in workers/signals.py

All existing logging.getLogger() callers automatically get structlog formatting
via the ProcessorFormatter bridge — no per-module changes needed.
"""
import logging
import sys

import structlog

from app.core.config import settings

# Fields whose values are replaced with [REDACTED] in every log record.
_SENSITIVE_KEYS = frozenset({
    "password", "ssh_password", "enable_secret", "snmp_community",
    "snmp_v3_auth_passphrase", "snmp_v3_priv_passphrase",
    "token", "access_token", "refresh_token",
    "secret", "secret_key", "api_key",
    "credential", "passphrase", "private_key", "webhook_headers",
    "credential_encryption_key",
})


def _drop_sensitive(_logger, _method, event_dict: dict) -> dict:
    """Structlog processor: redact sensitive fields before any renderer sees them."""
    for key in list(event_dict.keys()):
        if any(s in key.lower() for s in _SENSITIVE_KEYS):
            event_dict[key] = "[REDACTED]"
    return event_dict


def configure_logging() -> None:
    """Configure structlog + stdlib root logger. Idempotent (safe to call twice)."""
    level_name = settings.LOG_LEVEL.upper()
    level = getattr(logging, level_name, logging.INFO)
    use_json = settings.LOG_FORMAT == "json"

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _drop_sensitive,
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
