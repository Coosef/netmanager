#!/usr/bin/env bash
# NetManager post-deploy smoke test
#
# Usage:
#   ./scripts/netmanager-verify.sh           # quick checks only
#   ./scripts/netmanager-verify.sh --full    # quick checks + full test suite
#
# Exit codes: 0=PASS, 1=FAIL
# Designed to be used in CI/CD pipelines or after manual deployments.

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
FULL_TESTS=0
PASS=0
FAIL=0

for arg in "$@"; do
  [[ "$arg" == "--full" ]] && FULL_TESTS=1
done

_pass() { echo "  [PASS] $*"; ((PASS++)) || true; }
_fail() { echo "  [FAIL] $*" >&2; ((FAIL++)) || true; }
_info() { echo "  [INFO] $*"; }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  NetManager Deploy Verification"
echo "  Backend: $BACKEND_URL"
echo "  Mode:    $([ "$FULL_TESTS" -eq 1 ] && echo 'full (tests included)' || echo 'quick')"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1. Health readiness ───────────────────────────────────────────────────────
echo "▶ /health/ready"
HEALTH=$(curl -sf --max-time 10 "${BACKEND_URL}/health/ready" 2>/dev/null || echo "CURL_FAIL")
if [[ "$HEALTH" == "CURL_FAIL" ]]; then
  _fail "/health/ready unreachable"
else
  STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "parse_error")
  if [[ "$STATUS" == "ok" ]]; then
    _pass "/health/ready → ok"
    # Per-component check
    for comp in db redis timescaledb; do
      COMP_STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('$comp',{}).get('status','missing'))" 2>/dev/null || echo "unknown")
      if [[ "$COMP_STATUS" == "ok" || "$COMP_STATUS" == "unavailable" ]]; then
        _info "$comp: $COMP_STATUS"
      else
        _fail "$comp: $COMP_STATUS"
      fi
    done
  else
    _fail "/health/ready → $STATUS (expected: ok)"
  fi
fi

# ── 2. Alembic head ───────────────────────────────────────────────────────────
echo ""
echo "▶ alembic current"
if docker compose exec -T backend alembic current 2>/dev/null | grep -q "(head)"; then
  _pass "alembic at head revision"
else
  REVISION=$(docker compose exec -T backend alembic current 2>/dev/null || echo "unavailable")
  _fail "alembic NOT at head: $REVISION"
fi

# ── 3. Device count ───────────────────────────────────────────────────────────
echo ""
echo "▶ DB device count"
DEVICE_COUNT=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-netmgr}" -d "${POSTGRES_DB:-network_manager}" -tAc "SELECT count(*) FROM devices;" 2>/dev/null | tr -d '[:space:]' || echo "0")
if [[ "$DEVICE_COUNT" =~ ^[0-9]+$ ]] && [[ "$DEVICE_COUNT" -gt 0 ]]; then
  _pass "device count: $DEVICE_COUNT"
else
  _info "device count: $DEVICE_COUNT (0 may be expected on fresh install)"
fi

# ── 4. Celery queue depth ─────────────────────────────────────────────────────
echo ""
echo "▶ Celery queue depth"
QUEUE_DEPTH=$(docker compose exec -T redis redis-cli LLEN celery 2>/dev/null | tr -d '[:space:]' || echo "unknown")
if [[ "$QUEUE_DEPTH" =~ ^[0-9]+$ ]]; then
  if [[ "$QUEUE_DEPTH" -gt 500 ]]; then
    _fail "celery queue depth HIGH: $QUEUE_DEPTH (check worker health)"
  else
    _pass "celery queue depth: $QUEUE_DEPTH"
  fi
else
  _info "celery queue depth: $QUEUE_DEPTH"
fi

# ── 5. Metrics endpoint ───────────────────────────────────────────────────────
echo ""
echo "▶ /metrics"
METRICS_STATUS=$(curl -sf --max-time 5 -o /dev/null -w "%{http_code}" "${BACKEND_URL}/metrics" 2>/dev/null || echo "0")
if [[ "$METRICS_STATUS" == "200" ]]; then
  _pass "/metrics accessible (HTTP 200)"
else
  _fail "/metrics returned HTTP $METRICS_STATUS"
fi

# ── 6. Full test suite (optional) ────────────────────────────────────────────
if [[ "$FULL_TESTS" -eq 1 ]]; then
  echo ""
  echo "▶ Test suite (this may take 30–60s)"
  if docker compose exec -T backend python -m pytest tests/ -q --tb=short 2>&1 | tee /tmp/netmanager-verify-tests.log | tail -3; then
    if grep -q "passed" /tmp/netmanager-verify-tests.log; then
      PASSED=$(grep -oE '[0-9]+ passed' /tmp/netmanager-verify-tests.log | tail -1)
      _pass "test suite: $PASSED"
    else
      _fail "test suite output unclear — check /tmp/netmanager-verify-tests.log"
    fi
  else
    _fail "test suite FAILED — check /tmp/netmanager-verify-tests.log"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "RESULT: FAIL — $FAIL check(s) failed" >&2
  exit 1
else
  echo "RESULT: PASS"
  exit 0
fi
