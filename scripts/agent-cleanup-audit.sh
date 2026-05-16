#!/usr/bin/env bash
# NetManager — decommissioned agent cleanup audit (Faz 6B G7-5)
#
# Symptom this addresses:
#   The backend log fills with repeated WebSocket "403" handshake lines such as
#     INFO: ('1.2.3.4', 0) - "WebSocket /api/v1/agents/ws/<id>?key=..." 403
#   These come from agent machines whose DB record was decommissioned
#   (agents.is_active = false) but whose agent process keeps reconnecting with
#   the old agent_id/key. The 403 is CORRECT — a decommissioned agent must be
#   rejected — but the offending machines should be cleaned up so they stop
#   hammering the endpoint and spamming logs.
#
# What this script does (READ-ONLY — it changes nothing):
#   1. Greps the backend log for WS handshakes that were rejected (403).
#   2. Extracts the agent_id + source IP + attempt count.
#   3. Cross-references each agent_id against the DB.
#   4. Prints a per-agent verdict and the recommended resolution.
#
# Usage:   ./scripts/agent-cleanup-audit.sh [LOG_WINDOW]
#   LOG_WINDOW  docker logs --since value (default: 30m)
#
# Run from the compose project root (where docker-compose.yml lives).

set -uo pipefail
WINDOW="${1:-30m}"

echo "=== Agent cleanup audit — window: last ${WINDOW} ==="
echo

# 1. Collect rejected WS handshakes as: count  agent_id  source_ip
REJECTED=$(docker compose logs backend --since="${WINDOW}" 2>/dev/null \
    | grep -E '"WebSocket /api/v1/agents/ws/[a-z0-9]+.*" 403' \
    | sed -E 's/.*\(([0-9.]+), [0-9]+\).*agents\/ws\/([a-z0-9]+).*/\2 \1/' \
    | sort | uniq -c | sort -rn)

if [ -z "$REJECTED" ]; then
    echo "No rejected (403) agent WebSocket handshakes in the window. Nothing to clean up."
    exit 0
fi

echo "Rejected handshakes (count | agent_id | source_ip):"
echo "$REJECTED" | sed 's/^/  /'
echo

# 2. Per-agent DB cross-reference + verdict
echo "=== DB cross-reference ==="
echo "$REJECTED" | awk '{print $2}' | sort -u | while read -r AID; do
    [ -z "$AID" ] && continue
    ROW=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-netmgr}" \
        -d "${POSTGRES_DB:-network_manager}" -tAc \
        "SELECT name, is_active, last_disconnected_at FROM agents WHERE id='${AID}';" \
        2>/dev/null | grep -v -E 'warning|version' | head -1)
    if [ -z "$ROW" ]; then
        echo "  ${AID}: NOT IN DB → agent record was deleted."
        echo "      → Resolution: stop/uninstall the agent process on the source machine."
    else
        NAME=$(echo "$ROW" | cut -d'|' -f1)
        ACTIVE=$(echo "$ROW" | cut -d'|' -f2)
        if [ "$ACTIVE" = "f" ]; then
            echo "  ${AID} (${NAME}): is_active=false → DECOMMISSIONED but still connecting."
            echo "      → Resolution (pick one):"
            echo "         a) Reinstall the agent on its machine with a fresh agent_id/key"
            echo "            (preferred — clean re-onboard)."
            echo "         b) Stop/uninstall the agent process if the device is retired."
            echo "         c) If the device IS still needed, re-onboard it as a new agent"
            echo "            from the UI; do NOT just flip is_active back on (the old"
            echo "            key may be compromised / rotated)."
        else
            echo "  ${AID} (${NAME}): is_active=true but handshake 403 →"
            echo "      likely a wrong/rotated key or an allowed_ips mismatch."
            echo "      → Resolution: verify the agent's key matches; check allowed_ips."
        fi
    fi
done

echo
echo "=== Notes ==="
echo "  - The 403 itself is correct behavior; no backend change is needed."
echo "  - After the source machines are cleaned up, the log spam stops on its own."
echo "  - Re-run this script after cleanup to confirm zero rejected handshakes."
