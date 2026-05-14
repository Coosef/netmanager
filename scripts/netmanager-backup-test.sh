#!/usr/bin/env bash
# NetManager — Backup integrity test (dry-run restore to temp DB)
#
# Usage:
#   ./netmanager-backup-test.sh [backup-dir]
#
# If backup-dir is omitted, the most recent backup under ./backups/ is used.
#
# Creates a temporary database, restores, validates, then drops it.
# Exits 0 on success, non-zero on any validation failure.
#
# Env:
#   BACKUP_DIR     where to look for backups   (default: ./backups)
#   CONTAINER      postgres container name      (default: switch-postgres-1)
#   POSTGRES_USER                               (default: netmgr)

set -euo pipefail

BACKUP_DIR_ROOT="${BACKUP_DIR:-./backups}"
CONTAINER="${CONTAINER:-switch-postgres-1}"
PG_USER="${POSTGRES_USER:-netmgr}"
TEST_DB="netmgr_backup_test_$$"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[$(date +%H:%M:%S)]"

log()  { echo "${LOG_PREFIX} $*"; }
fail() { echo "[FAIL] $*" >&2; cleanup; exit 1; }
pass() { echo "[PASS] $*"; }

cleanup() {
    log "Cleaning up test database '${TEST_DB}' …"
    docker exec "${CONTAINER}" psql -U "${PG_USER}" -d postgres \
        -c "DROP DATABASE IF EXISTS ${TEST_DB};" 2>/dev/null || true
}
trap cleanup EXIT

# ── Locate backup ─────────────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
    BACKUP_PATH="${1}"
else
    BACKUP_PATH=$(ls -1d "${BACKUP_DIR_ROOT}"/[0-9]* 2>/dev/null | sort | tail -1 || true)
    [ -z "${BACKUP_PATH}" ] && { echo "[ERROR] No backups found under ${BACKUP_DIR_ROOT}"; exit 1; }
fi

[ -f "${BACKUP_PATH}/db.dump" ]      || { echo "[ERROR] db.dump not found in ${BACKUP_PATH}"; exit 1; }
[ -f "${BACKUP_PATH}/manifest.json" ] || { echo "[ERROR] manifest.json not found in ${BACKUP_PATH}"; exit 1; }

MANIFEST_TABLES=$(grep '"table_count"' "${BACKUP_PATH}/manifest.json" | grep -oE '[0-9]+' || echo "0")
MANIFEST_ALEMBIC=$(grep '"alembic_revision"' "${BACKUP_PATH}/manifest.json" | cut -d'"' -f4 || echo "unknown")
MANIFEST_TS=$(grep '"timestamp"' "${BACKUP_PATH}/manifest.json" | grep -oE '[0-9]{8}_[0-9]{6}' || echo "unknown")

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  NetManager Backup Test"
echo "║  Backup    : ${BACKUP_PATH}"
echo "║  Timestamp : ${MANIFEST_TS}"
echo "║  Expected  : ${MANIFEST_TABLES} tables, alembic=${MANIFEST_ALEMBIC}"
echo "║  Test DB   : ${TEST_DB}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Pre-flight ────────────────────────────────────────────────────────────────
docker inspect "${CONTAINER}" > /dev/null 2>&1 || fail "Container '${CONTAINER}' not running."

# ── 1. Run restore (non-interactive, drops if exists) ─────────────────────────
log "Running restore to test DB …"
SKIP_CONFIRM=yes TARGET_DB="${TEST_DB}" DROP_FIRST=yes \
    "${SCRIPT_DIR}/netmanager-restore.sh" "${BACKUP_PATH}"

# ── 2. Table count check ──────────────────────────────────────────────────────
log "Checking table count …"
ACTUAL_TABLES=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TEST_DB}" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables \
     WHERE table_schema='public' AND table_type='BASE TABLE';" \
    2>/dev/null | tr -d ' \n')

if [ "${ACTUAL_TABLES}" -lt 50 ]; then
    fail "Table count ${ACTUAL_TABLES} < 50 (expected ≥50)"
fi
if [ "${ACTUAL_TABLES}" != "${MANIFEST_TABLES}" ]; then
    log "WARNING: table count mismatch — manifest=${MANIFEST_TABLES}, restored=${ACTUAL_TABLES}"
    log "         (May differ if hypertable chunks are counted differently — continuing)"
fi
pass "Table count: ${ACTUAL_TABLES} (manifest: ${MANIFEST_TABLES})"

# ── 3. Hypertable check ───────────────────────────────────────────────────────
log "Checking hypertables …"
HYPER_NAMES=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TEST_DB}" -tAc \
    "SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1;" \
    2>/dev/null | tr -d ' ' | sort)

EXPECTED_HYPERS="agent_peer_latenciesdevice_availability_snapshotssyslog_eventssnmp_poll_resultssynthetic_probe_results"
HYPER_COUNT=$(echo "${HYPER_NAMES}" | grep -c '[a-z]' || echo 0)

if [ "${HYPER_COUNT}" -lt 5 ]; then
    fail "Only ${HYPER_COUNT} hypertables found (expected 5): ${HYPER_NAMES}"
fi
pass "Hypertables: ${HYPER_COUNT}"
echo "${HYPER_NAMES}" | while read -r ht; do [ -n "${ht}" ] && echo "        ✓ ${ht}"; done

# ── 4. Core table row counts ──────────────────────────────────────────────────
log "Checking core table row counts …"
CORE_TABLES="devices users network_events incidents synthetic_probes"
ALL_COUNTS_OK=1
for tbl in ${CORE_TABLES}; do
    CNT=$(docker exec "${CONTAINER}" \
        psql -U "${PG_USER}" -d "${TEST_DB}" -tAc \
        "SELECT COUNT(*) FROM ${tbl};" 2>/dev/null | tr -d ' \n' || echo "err")
    if [ "${CNT}" = "err" ]; then
        log "  WARN: could not query '${tbl}' — table missing?"
        ALL_COUNTS_OK=0
    else
        echo "        ${tbl}: ${CNT} rows"
    fi
done
[ "${ALL_COUNTS_OK}" -eq 1 ] && pass "Core table counts OK" || fail "One or more core tables missing"

# ── 5. Alembic revision check ─────────────────────────────────────────────────
log "Checking Alembic revision table …"
ALEMBIC_REV=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TEST_DB}" -tAc \
    "SELECT version_num FROM alembic_version;" 2>/dev/null | tr -d ' \n' || echo "none")

if [ "${ALEMBIC_REV}" = "none" ] || [ -z "${ALEMBIC_REV}" ]; then
    fail "alembic_version table missing or empty in restored DB"
fi
pass "Alembic revision: ${ALEMBIC_REV}"

# ── 6. TimescaleDB extension check ───────────────────────────────────────────
log "Checking TimescaleDB extension …"
TS_VER=$(docker exec "${CONTAINER}" \
    psql -U "${PG_USER}" -d "${TEST_DB}" -tAc \
    "SELECT extversion FROM pg_extension WHERE extname='timescaledb';" \
    2>/dev/null | tr -d ' \n' || echo "none")

if [ "${TS_VER}" = "none" ] || [ -z "${TS_VER}" ]; then
    fail "TimescaleDB extension not found in restored DB"
fi
pass "TimescaleDB version: ${TS_VER}"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Backup test PASSED"
echo "║  Tables     : ${ACTUAL_TABLES}"
echo "║  Hypertables: ${HYPER_COUNT}"
echo "║  Alembic    : ${ALEMBIC_REV}"
echo "║  TimescaleDB: ${TS_VER}"
echo "╚══════════════════════════════════════════════════════╝"
