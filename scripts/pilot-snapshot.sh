#!/usr/bin/env bash
# Pilot metric snapshot
#
# Usage:
#   ./scripts/pilot-snapshot.sh           # label = "auto"
#   ./scripts/pilot-snapshot.sh pre-test  # custom label
#
# Output: /tmp/pilot-snapshots/<timestamp>_<label>/
# Planlanmış kullanım: her 6 saatte bir cron veya manuel

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
LABEL="${1:-auto}"
TS=$(date +%Y%m%d_%H%M%S)
OUT="/tmp/pilot-snapshots/${TS}_${LABEL}"
mkdir -p "$OUT"

_info() { echo "  [INFO] $*"; }
_ok()   { echo "  [OK]   $*"; }
_warn() { echo "  [WARN] $*" >&2; }

echo ""
echo "═══════════════════════════════════════════════════"
echo "  NetManager Pilot Snapshot — $TS [$LABEL]"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. Health ────────────────────────────────────────────────────────────────
_info "Health check..."
if curl -sf --max-time 10 "${BACKEND_URL}/health/ready" > "$OUT/health.json" 2>/dev/null; then
  STATUS=$(python3 -c "import sys,json; print(json.load(open('$OUT/health.json')).get('status','?'))" 2>/dev/null || echo "parse_error")
  _ok "health/ready → $STATUS"
else
  echo '{"status":"unreachable"}' > "$OUT/health.json"
  _warn "health/ready unreachable"
fi

# ── 2. Queue depth ───────────────────────────────────────────────────────────
_info "Celery queue depth..."
{
  echo "celery: $(docker compose exec -T redis redis-cli LLEN celery 2>/dev/null | tr -d '[:space:]')"
  echo "bulk:   $(docker compose exec -T redis redis-cli LLEN bulk   2>/dev/null | tr -d '[:space:]')"
  echo "monitor:$(docker compose exec -T redis redis-cli LLEN monitor 2>/dev/null | tr -d '[:space:]')"
} > "$OUT/queue_depth.txt" 2>/dev/null || _warn "queue depth unavailable"
_ok "queue depth → $(cat "$OUT/queue_depth.txt" | tr '\n' '  ')"

# ── 3. Redis memory + keyspace ───────────────────────────────────────────────
_info "Redis memory..."
{
  docker compose exec -T redis redis-cli INFO memory 2>/dev/null | grep -E "used_memory_human|used_memory_peak_human|maxmemory_human"
  echo "dbsize: $(docker compose exec -T redis redis-cli DBSIZE 2>/dev/null | tr -d '[:space:]')"
  echo "event_keys: $(docker compose exec -T redis redis-cli KEYS 'event:*' 2>/dev/null | wc -l | tr -d '[:space:]')"
} > "$OUT/redis_memory.txt" 2>/dev/null || _warn "redis memory unavailable"
_ok "redis → $(grep used_memory_human "$OUT/redis_memory.txt" 2>/dev/null | head -1)"

# ── 4. Container memory snapshot ─────────────────────────────────────────────
_info "Container memory..."
{
  echo "NAME                MEM_USAGE           MEM_PERC   CPU_PERC"
  docker stats --no-stream --format "{{.Name}}  {{.MemUsage}}  {{.MemPerc}}  {{.CPUPerc}}" \
    $(docker compose ps -q backend celery_worker postgres 2>/dev/null | tr '\n' ' ') 2>/dev/null
} > "$OUT/container_memory.txt" 2>/dev/null || _warn "container stats unavailable"
_ok "container memory snapshot saved"

# ── 5. Incident summary ──────────────────────────────────────────────────────
_info "Incident summary..."
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-netmgr}" \
  -d "${POSTGRES_DB:-network_manager}" \
  -tAc "SELECT state, count(*) FROM incidents GROUP BY state ORDER BY state;" \
  > "$OUT/incidents.txt" 2>/dev/null || echo "unavailable" > "$OUT/incidents.txt"
_ok "incidents → $(cat "$OUT/incidents.txt" | tr '\n' '  ')"

# ── 6. Synthetic probe pass rate (last 1h) ────────────────────────────────────
_info "Synthetic probe pass rate (last 1h)..."
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-netmgr}" \
  -d "${POSTGRES_DB:-network_manager}" \
  -tAc "SELECT coalesce(round(100.0*sum(CASE WHEN success THEN 1 ELSE 0 END)/nullif(count(*),0),1)::text,'N/A') pct
        FROM synthetic_probe_results WHERE measured_at > NOW()-INTERVAL '1 hour';" \
  > "$OUT/probe_passrate.txt" 2>/dev/null || echo "unavailable" > "$OUT/probe_passrate.txt"
_ok "probe pass rate → $(cat "$OUT/probe_passrate.txt" | tr -d '[:space:]')%"

# ── 7. Escalation log (last 24h) ─────────────────────────────────────────────
_info "Escalation notifications (last 24h)..."
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-netmgr}" \
  -d "${POSTGRES_DB:-network_manager}" \
  -tAc "SELECT status, count(*) FROM escalation_notification_logs
        WHERE sent_at > NOW()-INTERVAL '24 hours' GROUP BY status;" \
  > "$OUT/escalation_log.txt" 2>/dev/null || echo "unavailable" > "$OUT/escalation_log.txt"
_ok "escalation → $(cat "$OUT/escalation_log.txt" | tr '\n' '  ')"

# ── 8. TimescaleDB retention / compression job status ────────────────────────
_info "TimescaleDB job status..."
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-netmgr}" \
  -d "${POSTGRES_DB:-network_manager}" \
  -tAc "SELECT j.hypertable_name,
               js.last_run_status,
               to_char(js.last_run_duration,'MI:SS') dur
        FROM timescaledb_information.job_stats js
        JOIN timescaledb_information.jobs j USING (job_id)
        WHERE j.proc_name IN ('policy_retention','policy_compression')
        ORDER BY j.hypertable_name, j.proc_name;" \
  > "$OUT/timescaledb_jobs.txt" 2>/dev/null || echo "unavailable" > "$OUT/timescaledb_jobs.txt"
_ok "timescaledb jobs saved"

# ── 9. Celery workers (Flower API) ───────────────────────────────────────────
_info "Celery workers (Flower)..."
if curl -sf --max-time 5 \
    -u "${FLOWER_USER:-admin}:${FLOWER_PASSWORD:-admin123}" \
    http://localhost:5555/api/workers \
    2>/dev/null | python3 -m json.tool > "$OUT/celery_workers.json" 2>/dev/null; then
  _ok "celery workers saved"
else
  echo '{}' > "$OUT/celery_workers.json"
  _warn "flower unavailable (skipped)"
fi

# ── 10. Alembic head check ────────────────────────────────────────────────────
_info "Alembic revision..."
if docker compose exec -T backend alembic current 2>/dev/null | grep -q "(head)"; then
  echo "head" > "$OUT/alembic.txt"
  _ok "alembic at head"
else
  docker compose exec -T backend alembic current 2>/dev/null > "$OUT/alembic.txt" || echo "unavailable" > "$OUT/alembic.txt"
  _warn "alembic NOT at head: $(cat "$OUT/alembic.txt")"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Snapshot: $OUT"
echo "  Files:    $(ls "$OUT" | wc -l | tr -d '[:space:]')"
echo "═══════════════════════════════════════════════════"
echo ""
ls "$OUT"
