#!/usr/bin/env bash
# NetManager — PostgreSQL backup script (TimescaleDB-compatible, pg16)
#
# Usage:
#   ./netmanager-backup.sh [OPTIONS]
#
# Options (env or flag):
#   BACKUP_DIR   path to write backups          (default: ./backups)
#   KEEP_DAYS    days of daily backups to keep  (default: 7)
#   CONTAINER    postgres container name         (default: switch-postgres-1)
#   POSTGRES_USER / POSTGRES_DB / POSTGRES_PASSWORD — match .env defaults
#
# Output per run:
#   $BACKUP_DIR/YYYYMMDD_HHMMSS/
#     db.dump              — pg custom-format (compressed, selective restore)
#     schema.sql           — schema-only for quick inspection
#     alembic_revision.txt — Alembic head at backup time
#     manifest.json        — metadata (timestamp, size, revision, table count)
#     restore_catalog.txt  — pg_restore --list output (integrity evidence)

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
CONTAINER="${CONTAINER:-switch-postgres-1}"
PG_USER="${POSTGRES_USER:-netmgr}"
PG_DB="${POSTGRES_DB:-network_manager}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-switch-backend-1}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"
CONTAINER_TMP="/tmp/netmanager_backup_${TIMESTAMP}"
LOG_PREFIX="[$(date +%H:%M:%S)]"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo "${LOG_PREFIX} $*"; }
fail() { echo "[ERROR] $*" >&2; exit 1; }

require_container() {
    docker inspect "${1}" > /dev/null 2>&1 || fail "Container '${1}' not running."
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
require_container "${CONTAINER}"
mkdir -p "${BACKUP_PATH}"
log "Backup → ${BACKUP_PATH}"

# ── 1. TimescaleDB retention conflict check ──────────────────────────────────
# Warn if last backup is older than shortest retention window (30 days).
LAST_BACKUP=$(ls -1d "${BACKUP_DIR}"/[0-9]* 2>/dev/null | sort | tail -2 | head -1 || true)
if [ -n "${LAST_BACKUP}" ]; then
    LAST_TS=$(basename "${LAST_BACKUP}" | cut -c1-8)
    LAST_EPOCH=$(date -d "${LAST_TS}" +%s 2>/dev/null || date -j -f "%Y%m%d" "${LAST_TS}" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    GAP_DAYS=$(( (NOW_EPOCH - LAST_EPOCH) / 86400 ))
    if [ "${GAP_DAYS}" -gt 30 ]; then
        log "WARNING: last backup was ${GAP_DAYS} days ago — TimescaleDB retention (30d) may have"
        log "         deleted data not captured in any backup. Consider decreasing backup interval."
    fi
fi

# ── 2. pg_dump (custom format) inside container ──────────────────────────────
log "Running pg_dump (custom format, compress=6) …"
docker exec "${CONTAINER}" mkdir -p "${CONTAINER_TMP}"
docker exec "${CONTAINER}" \
    pg_dump \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        --format=custom \
        --compress=6 \
        --no-tablespaces \
        --no-privileges \
        -f "${CONTAINER_TMP}/db.dump"

docker cp "${CONTAINER}:${CONTAINER_TMP}/db.dump" "${BACKUP_PATH}/db.dump"
log "pg_dump OK ($(du -sh "${BACKUP_PATH}/db.dump" | cut -f1))"

# ── 3. Schema-only dump (plain SQL, for human inspection) ────────────────────
docker exec "${CONTAINER}" \
    pg_dump \
        -U "${PG_USER}" \
        -d "${PG_DB}" \
        --schema-only \
        --no-tablespaces \
        -f "${CONTAINER_TMP}/schema.sql"

docker cp "${CONTAINER}:${CONTAINER_TMP}/schema.sql" "${BACKUP_PATH}/schema.sql"
log "Schema dump OK ($(wc -l < "${BACKUP_PATH}/schema.sql") lines)"

# ── 4. Alembic revision snapshot ─────────────────────────────────────────────
ALEMBIC_REV="unknown"
if docker inspect "${BACKEND_CONTAINER}" > /dev/null 2>&1; then
    ALEMBIC_REV=$(docker exec -w /app "${BACKEND_CONTAINER}" \
        alembic current 2>/dev/null | tail -1 || echo "unknown")
fi
echo "${ALEMBIC_REV}" > "${BACKUP_PATH}/alembic_revision.txt"
log "Alembic revision: ${ALEMBIC_REV}"

# ── 5. Integrity check ───────────────────────────────────────────────────────
log "Running integrity check (pg_restore --list) …"
pg_restore --list "${BACKUP_PATH}/db.dump" > "${BACKUP_PATH}/restore_catalog.txt" 2>&1 || \
    docker exec "${CONTAINER}" pg_restore --list "${CONTAINER_TMP}/db.dump" \
        > "${BACKUP_PATH}/restore_catalog.txt" 2>&1

TABLE_COUNT=$(grep -c "TABLE DATA public" "${BACKUP_PATH}/restore_catalog.txt" || echo "0")
log "Catalog: ${TABLE_COUNT} table data entries"

if [ "${TABLE_COUNT}" -lt 50 ]; then
    fail "Backup integrity FAILED — only ${TABLE_COUNT} tables in catalog (expected ≥50). Aborting."
fi

# ── 6. Manifest ──────────────────────────────────────────────────────────────
DB_SIZE=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -t \
    -c "SELECT pg_database_size('${PG_DB}');" 2>/dev/null | tr -d ' \n' || echo "0")

DUMP_SIZE=$(wc -c < "${BACKUP_PATH}/db.dump")

cat > "${BACKUP_PATH}/manifest.json" <<MANIFEST
{
  "timestamp":        "${TIMESTAMP}",
  "db_name":          "${PG_DB}",
  "alembic_revision": "${ALEMBIC_REV}",
  "db_size_bytes":    ${DB_SIZE},
  "dump_size_bytes":  ${DUMP_SIZE},
  "table_count":      ${TABLE_COUNT},
  "pg_version":       "$(docker exec ${CONTAINER} pg_dump --version | head -1 | tr -d '\n')"
}
MANIFEST
log "Manifest written"

# ── 7. Cleanup container temp ────────────────────────────────────────────────
docker exec "${CONTAINER}" rm -rf "${CONTAINER_TMP}" 2>/dev/null || true

# ── 8. Retention — remove backups beyond KEEP_DAYS ──────────────────────────
REMOVED=0
while IFS= read -r old_dir; do
    [ -d "${old_dir}" ] && rm -rf "${old_dir}" && REMOVED=$((REMOVED + 1))
done < <(find "${BACKUP_DIR}" -maxdepth 1 -type d -name "[0-9]*" \
    -mtime "+${KEEP_DAYS}" 2>/dev/null || true)
[ "${REMOVED}" -gt 0 ] && log "Retention: removed ${REMOVED} backup(s) older than ${KEEP_DAYS} days"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Backup complete"
echo "║  Path    : ${BACKUP_PATH}"
echo "║  dump    : $(du -sh "${BACKUP_PATH}/db.dump" | cut -f1)"
echo "║  Tables  : ${TABLE_COUNT}"
echo "║  Alembic : ${ALEMBIC_REV}"
echo "╚══════════════════════════════════════════════════════╝"
