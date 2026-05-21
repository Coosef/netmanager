#!/usr/bin/env bash
# T8.3.B perf-run helper.
#
# A thin ergonomic wrapper around `npx playwright test --config=...`.
# The actual measurement logic lives in `perf/specs/*.spec.ts`; this
# script just sorts out cwd + flags so a contributor can run the suite
# from anywhere in the repo.
#
# Usage:
#   ./perf/scripts/run-perf.sh                       # all specs
#   ./perf/scripts/run-perf.sh cold-boot-1k          # one spec by name
#   PERF_BASE_URL=http://localhost:5174 ./run-perf.sh
#   PERF_AUTO_DEVSERVER=1 ./run-perf.sh              # start Vite ourselves
#
# Assumes the dev server is reachable at $PERF_BASE_URL
# (default http://localhost:5173). Set PERF_AUTO_DEVSERVER=1 to let
# Playwright start it for you — see playwright.config.ts.
set -euo pipefail

# Resolve repo root from this script's location (perf/scripts/) regardless
# of where it was invoked. `realpath` isn't on macOS by default, so use a
# portable two-step.
HERE="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_ROOT="$(cd "$HERE/../.." && pwd)"

cd "$FRONTEND_ROOT"

SPEC_FILTER="${1:-}"
if [[ -n "$SPEC_FILTER" ]]; then
  # Playwright takes a positional pattern matched against test file paths.
  exec npx playwright test --config=perf/playwright.config.ts "$SPEC_FILTER"
fi
exec npx playwright test --config=perf/playwright.config.ts
