"""
Prometheus metrics registry for NetManager.

All metric objects are module-level singletons.  Import what you need:
    from app.core.metrics import HTTP_REQUESTS_TOTAL, WS_CONNECTIONS_ACTIVE

The /metrics endpoint in main.py calls generate_latest() (single-process)
or MultiProcessCollector (when PROMETHEUS_MULTIPROC_DIR is set, used in
production where FastAPI + Celery workers share a tmpfs dir).

Naming convention: netmanager_<component>_<metric>_<unit>
Grafana-ready: all labels kept low-cardinality (path normalised to /{id}).
"""
from prometheus_client import Counter, Gauge, Histogram

# ── HTTP ─────────────────────────────────────────────────────────────────────
HTTP_REQUESTS_TOTAL = Counter(
    "netmanager_http_requests_total",
    "Total HTTP requests processed",
    ["method", "path", "status_code"],
)

HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "netmanager_http_request_duration_seconds",
    "HTTP request latency in seconds",
    ["method", "path"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

# ── WebSocket (agent connections) ─────────────────────────────────────────────
WS_CONNECTIONS_ACTIVE = Gauge(
    "netmanager_websocket_connections_active",
    "Number of currently connected WebSocket agents",
)

# ── Celery ────────────────────────────────────────────────────────────────────
CELERY_TASK_TOTAL = Counter(
    "netmanager_celery_task_total",
    "Total Celery task executions by outcome",
    ["task_name", "queue", "status"],   # status: success | failure
)

CELERY_TASK_DURATION_SECONDS = Histogram(
    "netmanager_celery_task_duration_seconds",
    "Celery task execution time in seconds",
    ["task_name", "queue"],
    buckets=[0.1, 0.5, 1.0, 5.0, 15.0, 30.0, 60.0, 120.0, 300.0],
)

# ── Redis queue depth ─────────────────────────────────────────────────────────
REDIS_QUEUE_DEPTH = Gauge(
    "netmanager_redis_queue_depth",
    "Number of pending tasks in each Celery Redis queue",
    ["queue"],
)

# ── SQLAlchemy connection pool ────────────────────────────────────────────────
DB_POOL_CHECKED_OUT = Gauge(
    "netmanager_db_pool_checked_out",
    "Connections currently checked out from the async DB pool",
)

DB_POOL_OVERFLOW = Gauge(
    "netmanager_db_pool_overflow",
    "Active overflow connections beyond pool_size in the async DB pool",
)

# ── TimescaleDB background jobs ───────────────────────────────────────────────
TIMESCALE_JOB_LAST_SUCCESS_TS = Gauge(
    "netmanager_timescaledb_job_last_success_timestamp_seconds",
    "Unix timestamp of the last successful TimescaleDB background job run",
    ["job_name"],
)

TIMESCALE_JOB_FAILURES_TOTAL = Gauge(
    "netmanager_timescaledb_job_failures_total",
    "Cumulative failed runs of a TimescaleDB background job (from job_stats)",
    ["job_name"],
)

# ── Health (alertable) ────────────────────────────────────────────────────────
HEALTH_COMPONENT_UP = Gauge(
    "netmanager_health_component_up",
    "Component health: 1 = reachable, 0 = unreachable",
    ["component"],   # db | redis | timescaledb
)

# ── Agent Command Bridge (Faz 6A) ─────────────────────────────────────────────
AGENT_BRIDGE_COMMAND_DURATION = Histogram(
    "netmanager_agent_bridge_command_duration_seconds",
    "Agent bridge round-trip duration from FastAPI dispatch to response publish",
    ["command_type"],
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)

AGENT_BRIDGE_TIMEOUT_TOTAL = Counter(
    "netmanager_agent_bridge_timeout_total",
    "Agent bridge commands that exceeded timeout",
    ["command_type"],
)

AGENT_BRIDGE_COMMAND_TOTAL = Counter(
    "netmanager_agent_bridge_command_total",
    "Agent bridge commands dispatched",
    ["command_type", "result"],   # result: success | agent_offline | timeout | error
)
