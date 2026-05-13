#!/usr/bin/env bash
# NetManager — PostgreSQL restore script (TimescaleDB-compatible, pg16)
#
# Usage:
#   ./netmanager-restore.sh [OPTIONS] <backup-dir>
#
# Arguments:
#   backup-dir   path to a backup created by netmanager-backup.sh
#                (the directory containing db.dump + manifest.json)
#
# Options (env or flag):
#   TARGET_DB    database name to restore into    (default: network_manager_restore)
#   CONTAINER    postgres container name           (default: switch-postgres-1)
#   POSTGRES_USER / POSTGRES_PASSWORD             — match .env defaults
#   DROP_FIRST   set to "yes" to DROP TARGET_DB before restore (default: no)
#   SKIP_CONFIRM set to "yes" to skip interactive confirmation   (default: no)
#
# TimescaleDB note:
#   Restore wraps pg_restore with timescaledb_pre_restore() / timescaledb_post_restore()
#   as required by the official TimescaleDB migration guide.

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
CONTAINER="${CONTAINER:-switch-postgres-1}"
PG_USER="${POSTGRES_USER:-netmgr}"
TARGET_DB="${TARGET_DB:-network_manager_restore}"
DROP_FIRST="${DROP_FIRST:-no}"
SKIP_CONFIRM="${SKIP_CONFIRM:-no}"
CONTAINER_TMP="/tmp/netmanager_restore_$$"

LOG_PREFIX="[$(date +%H:%M:%S)]"

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo "${LOG_PREFIX} $*"; }
fail() { echo "[ERROR] $*" >&2; exit 1; }

require_container() {
    docker inspect "${1}" > /dev/null 2>&1 || fail "Container '${1}' not running."
}

# ── Args ─────────────────────────────────────────────────────────────────────
BACKUP_DIR="${1:-}"
[ -z "${BACKUP_DIR}" ] && fail "Usage: $0 <backup-dir>  (e.g. ./backups/20260513_160000)"
[ -d "${BACKUP_DIR}" ] || fail "Backup directory not found: ${BACKUP_DIR}"
[ -f "${BACKUP_DIR}/db.dump" ] || fail "db.dump not found in: ${BACKUP_DIR}"
[ -f "${BACKUP_DIR}/manifest.json" ] || fail "manifest.json not found in: ${BACKUP_DIR}"

# ── Pre-flight ───────────────────────────────────────────────────────────────
require_container "${CONTAINER}"

MANIFEST_TS=$(grep '"timestamp"' "${BACKUP_DIR}/manifest.json" | grep -oE '[0-9]{8}_[0-9]{6}' || echo "unknown")
MANIFEST_TABLES=$(grep '"table_count"' "${BACKUP_DIR}/manifest.json" | grep -oE '[0-9]+' || echo "?")
MANIFEST_ALEMBIC=$(grep '"alembic_revision"' "${BACKUP_DIR}/manifest.json" | cut -d'"' -f4 || echo "unknown")
MANIFEST_DBSIZE=$(grep '"db_size_bytes"' "${BACKUP_DIR}/manifest.json" | grep -oE '[0-9]+' || echo "0")
MANIFEST_DBSIZE_MB=$(( MANIFEST_DBSIZE / 1048576 ))

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  NetManager Restore"
echo "║  Backup   : ${BACKUP_DIR}"
echo "║  Timestamp: ${MANIFEST_TS}"
echo "║  Tables   : ${MANIFEST_TABLES}"
echo "║  Alembic  : ${MANIFEST_ALEMBIC}"
echo "║  DB size  : ~${MANIFEST_DBSIZE_MB} MB"
echo "║  Target DB: ${TARGET_DB} (on ${CONTAINER})"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Confirmation ─────────────────────────────────────────────────────────────
if [ "${SKIP_CONFIRM}" != "yes" ]; then
    if [ "${TARGET_DB}" = "network_manager" ]; then
        echo "  ⚠️  WARNING: target is the PRODUCTION database (network_manager)."
        echo "  Ensure all application services are stopped before proceeding."
    fi
    echo -n "  Proceed with restore? [yes/N] "
    read -r ANSWER
    [ "${ANSWER}" = "yes" ] || { echo "Restore cancelled."; exit 0; }
fi

# ── 1. Prepare target database ───────────────────────────────────────────────
DB_EXISTS=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${TARGET_DB}'" 2>/dev/null | tr -d ' \n' || echo "")

if [ "${DB_EXISTS}" = "1" ]; then
    if [ "${DROP_FIRST}" = "yes" ]; then
        log "Dropping existing database '${TARGET_DB}' …"
        docker exec "${CONTAINER}" psql -U "${PG_USER}" -d postgres \
            -c "DROP DATABASE IF EXISTS ${TARGET_DB};" 2>/dev/null
        DB_EXISTS=""
    else
        log "Target database '${TARGET_DB}' already exists — will restore into it (objects may conflict)."
        log "Set DROP_FIRST=yes to drop and recreate."
    fi
fi

if [ "${DB_EXISTS}" != "1" ]; then
    log "Creating database '${TARGET_DB}' …"
    docker exec "${CONTAINER}" psql -U "${PG_USER}" -d postgres \
        -c "CREATE DATABASE ${TARGET_DB} OWNER ${PG_USER};"
    docker exec "${CONTAINER}" psql -U "${PG_USER}" -d "${TARGET_DB}" \
        -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
fi

# ── 2. Copy dump into container ──────────────────────────────────────────────
log "Copying dump into container …"
docker exec "${CONTAINER}" mkdir -p "${CONTAINER_TMP}"
docker cp "${BACKUP_DIR}/db.dump" "${CONTAINER}:${CONTAINER_TMP}/db.dump"
log "Copy complete ($(du -sh "${BACKUP_DIR}/db.dump" | cut -f1))"

# ── 3. TimescaleDB pre-restore ───────────────────────────────────────────────
log "Running timescaledb_pre_restore() …"
docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TARGET_DB}" \
    -c "SELECT timescaledb_pre_restore();" > /dev/null

# ── 4. pg_restore ────────────────────────────────────────────────────────────
log "Running pg_restore …"
docker exec "${CONTAINER}" \
    pg_restore \
        -U "${PG_USER}" \
        -d "${TARGET_DB}" \
        --no-owner \
        --no-privileges \
        --single-transaction \
        --disable-triggers \
        "${CONTAINER_TMP}/db.dump" 2>&1 | tee /tmp/netmanager_restore_log_$$.txt || {
    # pg_restore exits non-zero for warnings — only fail on real errors
    ERRORS=$(grep -cE "^pg_restore: error:" /tmp/netmanager_restore_log_$$.txt 2>/dev/null || echo "0")
    if [ "${ERRORS}" -gt 0 ]; then
        log "pg_restore reported ${ERRORS} error(s):"
        grep "^pg_restore: error:" /tmp/netmanager_restore_log_$$.txt
        fail "pg_restore failed — target DB may be in partial state."
    fi
    log "pg_restore completed with warnings (${ERRORS} hard errors — OK)"
}
rm -f /tmp/netmanager_restore_log_$$.txt

# ── 5. TimescaleDB post-restore ──────────────────────────────────────────────
log "Running timescaledb_post_restore() …"
docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TARGET_DB}" \
    -c "SELECT timescaledb_post_restore();" > /dev/null

# ── 6. Verification ──────────────────────────────────────────────────────────
log "Verifying restore …"

TABLE_COUNT=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" \
    2>/dev/null | tr -d ' \n')

HYPER_COUNT=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM timescaledb_information.hypertables;" \
    2>/dev/null | tr -d ' \n')

DEVICES_COUNT=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TARGET_DB}" -tAc \
    "SELECT COUNT(*) FROM devices;" 2>/dev/null | tr -d ' \n' || echo "err")

if [ "${TABLE_COUNT}" -lt 50 ]; then
    fail "Verification FAILED — only ${TABLE_COUNT} tables found (expected ≥50)."
fi

# ── 7. Cleanup container temp ────────────────────────────────────────────────
docker exec "${CONTAINER}" rm -rf "${CONTAINER_TMP}" 2>/dev/null || true

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Restore complete"
echo "║  Target DB : ${TARGET_DB}"
echo "║  Tables    : ${TABLE_COUNT}"
echo "║  Hypertables: ${HYPER_COUNT}"
echo "║  Devices   : ${DEVICES_COUNT}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Next steps:"
echo "  1. Verify application data:  docker exec ${CONTAINER} psql -U ${PG_USER} -d ${TARGET_DB} -c 'SELECT COUNT(*) FROM devices;'"
echo "  2. Alembic stamp (if switching to this DB): docker exec -w /app switch-backend-1 alembic stamp head"
echo "  3. If replacing production: update DB_URL in .env, then restart backend"
echo "  4. Cleanup when done:  docker exec ${CONTAINER} psql -U ${PG_USER} -c 'DROP DATABASE ${TARGET_DB};'"
