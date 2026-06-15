from pydantic_settings import BaseSettings
from typing import List, Optional


class Settings(BaseSettings):
    # App
    APP_NAME: str = "NetManager"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str
    SYNC_DATABASE_URL: str

    # Redis / Celery
    REDIS_URL: str = "redis://redis:6379/0"

    # Security
    SECRET_KEY: str
    CREDENTIAL_ENCRYPTION_KEY: str
    CREDENTIAL_ENCRYPTION_KEY_OLD: str = ""  # Set during key rotation; clear after rotate_credentials.py
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480
    ALGORITHM: str = "HS256"

    # CORS
    ALLOWED_ORIGINS: str = "http://localhost:3000"

    # SSH
    SSH_MAX_CONCURRENT: int = 50
    SSH_CONNECT_TIMEOUT: int = 30
    SSH_COMMAND_TIMEOUT: int = 60

    # AI / LLM
    ANTHROPIC_API_KEY: str = ""

    # Agent WebSocket URL override — set this to the direct (non-Cloudflare) URL
    # so installer scripts embed the correct WebSocket endpoint.
    # Example: https://ws.systrack.app
    AGENT_WS_URL: str = ""

    # Logging
    LOG_LEVEL: str = "INFO"    # DEBUG | INFO | WARNING | ERROR
    LOG_FORMAT: str = "json"   # "json" (prod) | "console" (dev)

    # Aggregation cache (Faz 6B)
    AGG_CACHE_ENABLED: bool = True
    AGG_CACHE_FRESH_SECS: int = 60        # served without revalidation
    AGG_CACHE_STALE_SECS: int = 240       # SWR window — total Redis TTL = fresh + stale
    AGG_CACHE_SLOW_COMPUTE_WARN_SECS: float = 5.0

    # DB connection pool (Faz 6B G7 — right-sized for max_connections=200)
    # Each process holds up to (DB_POOL_SIZE + DB_MAX_OVERFLOW) per engine,
    # and there are 2 engines (async + sync). With 6 processes that is
    # 6 × 2 × (5 + 10) = 180 worst-case — comfortably under Postgres' 200.
    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 10

    # Faz 6B G7: coalesce fleet-cache version bumps. Without debounce every
    # device event INCRs the version, killing the fleet cache on each event
    # → near-zero hit ratio under load. With debounce the version bumps at
    # most once per window; max added staleness ≈ this window.
    AGG_CACHE_INVALIDATION_DEBOUNCE_SECS: int = 30

    # Faz 6C: syslog ingestion goes through the Redis Streams event bus.
    # Caps concurrent inserts on the FALLBACK path (event bus unavailable)
    # so a burst cannot open one DB connection per event (the KI-4 mode).
    SYSLOG_FALLBACK_CONCURRENCY: int = 8

    # Faz 6C: event_consumer service — drains ingest streams in bounded batches.
    EVENT_CONSUMER_BATCH_COUNT: int = 200          # entries per XREADGROUP
    EVENT_CONSUMER_BLOCK_MS: int = 2000            # XREADGROUP block timeout
    EVENT_CONSUMER_CLAIM_INTERVAL_SECS: int = 30   # how often to run claim_stale
    EVENT_CONSUMER_CLAIM_MIN_IDLE_SECS: int = 60   # pending age before reclaim

    # Wave 3 W3.3 — PoE Restart akışı (disable → wait → enable) default bekleme
    POE_RESTART_WAIT_SEC: int = 10

    # WIN-INTEGRATE — Windows Agent v2 (Go service host) gate.
    # Default explicitly false. When false:
    #   - /api/v1/agents/{id}/download/host/windows-amd64 returns 404
    #   - /api/v1/agents/{id}/download/windows returns 503 (the old
    #     broken sc.exe-based PowerShell installer is intentionally
    #     NOT served — a broken installer is worse than a clear
    #     "feature off" error).
    #   - Linux endpoints, /ws/agent, heartbeat behaviour unchanged.
    # Flip to true only after the manual TR Windows VM end-to-end
    # test has passed and production deploy has been authorised.
    WINDOWS_AGENT_V2_ENABLED: bool = False

    # WIN-INTEGRATE — installer rendering external base URL override.
    #
    # Run T1.02 BLOCKED-WITH-LEAK postmortem: in a Mac docker-compose
    # staging stack the backend's self-derived base URL collapses to
    # "http://localhost", so the rendered installer's $BackendUrl
    # literal points at the backend container's own loopback, which
    # is unreachable from the external Windows test machine. The same
    # collapse can happen on any deploy where the reverse proxy does
    # not set X-Forwarded-Host.
    #
    # When this setting is non-empty AND the requested platform is
    # Windows, the installer download endpoint overrides the request-
    # derived base URL with this value. The setting MUST be the
    # backend's EXTERNALLY reachable origin (scheme + host + optional
    # port + optional path prefix). Trailing slashes are normalized
    # away inside the endpoint.
    #
    # Defaults to None — when None, the existing per-request base URL
    # derivation (server_url query / AGENT_WS_URL / X-Forwarded-Host /
    # request.base_url) runs unchanged. Linux installer rendering is
    # NOT affected by this setting under any value.
    WINDOWS_AGENT_V2_EXTERNAL_BASE_URL: Optional[str] = None

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
