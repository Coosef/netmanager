#!/usr/bin/env bash
# T8.3.C aggregator wrapper.
#
# Reads every `frontend/perf/results/*.json`, evaluates against the
# threshold config, writes `results/SUMMARY.md`, and prints a hotspot
# ranking. Uses Node's native `--experimental-strip-types` so the
# script can stay in TS without adding a transpiler dev-dep.
#
# Usage:
#   ./perf/scripts/run-aggregate.sh           # generate summary, exit 0
#   ./perf/scripts/run-aggregate.sh --strict  # also exit 1 on any FAIL band
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$FRONTEND_ROOT"
exec node --experimental-strip-types --no-warnings "$HERE/aggregate.ts" "$@"
