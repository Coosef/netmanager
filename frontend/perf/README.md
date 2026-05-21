# `frontend/perf/` — browser-side performance harness (T8.3)

This tree is **not part of the production bundle**. Vite never traverses
it; the application `tsconfig.json` excludes it. Playwright owns it.

## Why it exists

Following the T8.3 "measure-before-optimize" gate (see
`docs/TOPOLOGY_T8_3_MEASUREMENT_PLAN.md`), we need numbers — real
browser numbers — before deciding what to tune in the topology surface.
This harness produces those numbers by driving a real headless Chromium
through canonical scenarios and writing deterministic JSON artifacts.

## Layout

```
perf/
├── playwright.config.ts   # locked-down chromium-headless config
├── tsconfig.json          # isolated TS scope (extends frontend/)
├── harness/
│   ├── cdpMetrics.ts      # CDP collector + in-page recorder
│   └── artifact.ts        # JSON schema v1 + atomic write
├── specs/
│   └── cold-boot-1k.spec.ts   # T8.3.B canonical first cell
├── fixtures/              # synthetic graphs (T8.3.A)
├── results/               # generated artifacts (gitignored)
└── scripts/
    └── run-perf.sh        # ergonomic invocation wrapper
```

## Running

1. Start the Vite dev server in another terminal:
   ```bash
   cd frontend && npm run dev
   ```
2. Run the perf suite:
   ```bash
   ./perf/scripts/run-perf.sh                 # all specs
   ./perf/scripts/run-perf.sh cold-boot-1k    # one spec
   ```
3. Find the artifact under `perf/results/<scenario>-<size>.json`.

For CI, set `PERF_AUTO_DEVSERVER=1` and Playwright will start + stop
Vite itself (slightly less deterministic but self-contained).

## What the harness does NOT do

- It does **not** mutate page state. The collector is read-only;
  it scrapes the in-app `<PerfOverlay>` and reads CDP counters.
- It does **not** import from `frontend/src`. Stress-mode entry is
  via the URL (`?stress=N&perf=1`) — the same path a developer would
  take in their own Chrome session. This is the T8.3.0 §11
  "single source of truth" lock.
- It does **not** affect production. No production code path imports
  from this directory; the production bundle never sees `@playwright/test`.

## Schema versioning

The artifact JSON shape is locked at `SCHEMA_VERSION = 1` in
`harness/artifact.ts`. T8.3.C automation and T8.3.D reporting consume
this shape — bump the version on any incompatible change and update
both consumers in the same series.
