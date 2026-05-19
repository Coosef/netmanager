# Organization / Location Isolation — Architecture Audit

> **Date:** 2026-05-19 · **Method:** read-only — 3 parallel code audits + DB
> schema inspection + a live RLS row-count check under no-context / org-A /
> org-B / location / super-admin contexts. No changes made.
> **Outcome:** drives **Faz 8** — see [FAZ8_ISOLATION_HARDENING_PLAN.md](FAZ8_ISOLATION_HARDENING_PLAN.md).

**Honest bottom line:** core RLS org-isolation is genuinely enforced for 47
tables — but the system is **not** fully isolated. Metrics leak at the DB
layer, the scoping fallback can misattribute writes across orgs,
location-level isolation is incomplete (logs/discovery have no location,
several frontend pages ignore it), and agent command/syslog paths have
unenforced gaps. It is **not** "complete."

---

## 1. Data model

59 tables. **48 have RLS** (`org_isolation` policy, `FORCE`, `cmd=ALL`).

| Table | org_id | loc_id | RLS | Scope class |
|---|---|---|---|---|
| organizations | — | — | no (root) | shared/root |
| locations | ✓ NOT NULL | — | ✓ | org-scoped |
| devices | ✓ NOT NULL | ✓ NOT NULL | ✓ | device root (org+location) |
| agents | ✓ NOT NULL | ✓ NOT NULL | ✓ | org+location |
| users | ✓ nullable | — | **no** (in-app) | org-scoped, app-enforced |
| user_locations | via location | ✓ NOT NULL | **no** | join table |
| invite_tokens | ✓ nullable | — | **no** (in-app) | org-scoped, app-enforced |
| topology_links | ✓ NOT NULL | ✓ NOT NULL | ✓ | device-scoped |
| topology_snapshots | ✓ NOT NULL | ✓ nullable | ✓ | org-scoped |
| network_events | ✓ NOT NULL | ✓ nullable | ✓ | device-scoped |
| incidents | ✓ NOT NULL | ✓ nullable | ✓ | device-scoped |
| alert_rules | ✓ NOT NULL | ✓ nullable | ✓ | org/location-scoped |
| **snmp_poll_results** (metrics) | ✓ NOT NULL | ✓ NOT NULL | **✗ NO RLS** | device-scoped — **unenforced** |
| **syslog_events** (logs) | ✓ NOT NULL | **✗ none** | ✓ | **org-scoped only** |
| **discovery_results** | ✓ NOT NULL | **✗ none** | ✓ | org-scoped only |
| config_backups | ✓ NOT NULL | ✓ NOT NULL | ✓ | device-scoped |
| audit_logs | ✓ nullable | — | ✓ | org-scoped |
| api_tokens | ✓ nullable | — | **✗ NO RLS** | org-scoped — **unenforced** |

FK `on_delete`: `organization_id` → CASCADE; `location_id` → **SET NULL on a
NOT NULL column** (`devices`, `agents`, … — contradictory). Legacy `tenant_id`
FKs remain on 9 tables; `locations.tenant_id` is CASCADE.

Scoped tables **without RLS:** `snmp_poll_results`, `api_tokens` (gaps);
`users`, `invite_tokens` (intentional — auth tables, app-enforced).

## 2. Hierarchy check

Intended: `Org → Location → {Agents, Devices} → {Interfaces, Alerts, Metrics,
Topology, Logs, Discovery}`.

- **Holds:** devices, agents, topology_links, config_backups, network_events,
  incidents, alert_rules, mac/arp, command_executions, asset_lifecycle.
- **Breaks:**
  - Logs (`syslog_events`) — **no `location_id`** — org-scoped only.
  - Discovery (`discovery_results`) — **no `location_id`** — org-scoped only.
  - Metrics (`snmp_poll_results`) — org+location columns but **no RLS**.
  - Interfaces — no table; lives in an ephemeral Redis cache with no
    org/location segment.

## 3. User access model

- **One user = one organization** (`users.organization_id`, single FK; nullable
  → org-less user fails closed under RLS).
- `user_locations` allows user → multiple locations, **but is written and
  effectively ignored** — `deps.py`/`context.py`/RLS/`PermissionEngine` never
  read it; only 3 legacy spots use it via the old `role` column.
- **LOCATION_ADMIN not truly enforced** — `require_system_role` checks the role
  string only; it does **not** verify a `user_locations` row for the active
  location.
- **"All Locations"** = `activeLocationId=null` → org-wide (not global).
- Location identity is split: integer `location_id` context vs the still
  load-bearing `Device.site` name string.

## 4. Creation flows

| Flow | org_id | location_id | Fallback risk |
|---|---|---|---|
| Create organization | n/a | n/a | `create_org` passes wrong `org_id=` attr → new admin user **NULL org** |
| Create location | `_scoping` hook (GUC) | n/a | org not set explicitly; no org-check on super-admin's `tenant_id` |
| Create agent | authoritative from `Location.organization_id` | required | **safe** |
| Create device (manual) | `_scoping` hook (GUC) | `_scoping` hook | **default-org + Unassigned fallback** if context empty |
| Discovery / hop-discover | `_scoping` hook | same | safe if context set; else default-org fallback |
| discover-ghost | `_scoping` hook | same | default-org fallback in "All Locations" |

**Dangerous fallback** — `_scoping.py` last-resort net stamps unresolved rows
with `_default_org()` = **the lowest-id org** + its "Unassigned" location.
A write with empty org context is silently misattributed to the wrong org.

## 5. Device ownership

- Every device gets org+location (NOT NULL via `_scoping`) — but derived from
  the caller's session, never validated against the payload.
- `DeviceUpdate` has **no `location_id`** → the API cannot move a device; a move
  is only possible via direct ORM mutation.
- **No child-row re-stamping** — `topology_links`, `network_events`,
  `incidents`, `config_backups`, `snmp_poll_results`, `mac/arp` freeze
  org/location at insert; a device move leaves all history stale.

## 6. Agent isolation

- ✓ Each agent bound 1:1 to org+location; token = per-agent key hash.
- ✓ `device_status_report` + `snmp_trap` ingest call `_devices_in_agent_scope`.
- ✗ `_handle_syslog_event` does **not** call `_devices_in_agent_scope`.
- ✗ Agent command endpoints `snmp-get` / `snmp-walk` / `stream-command` do
  **not** verify the target device against the agent's org/location.
- ✗ Agent discovery subnet is unbounded by tenancy.
- Agent WS handlers run RLS-bypassed — no DB backstop for the gaps above.

## 7. RLS reality check (live row counts)

| table | no-context | org1 | org2 | super-admin | verdict |
|---|---|---|---|---|---|
| devices | 0 | 63 | 0 | 63 | ✅ isolated |
| agents | 0 | 7 | 0 | 7 | ✅ |
| topology_links | 0 | 1000 | 0 | 1000 | ✅ |
| network_events | 0 | 4384 | 0 | 4384 | ✅ |
| incidents / config_backups / tasks | 0 | 2 / 1093 / 99 | 0 | same | ✅ |
| locations | 0 | 3 | 1 | 4 | ✅ |
| audit_logs | 0 | 762 | 1 | 787 | ✅ (24 NULL-org → super-only) |
| **snmp_poll_results** | **786 149** | **786 149** | **786 149** | 786 149 | ❌ **LEAK** |

The 47 RLS tables are genuinely isolated (org-A ≠ org-B, no-context fails
closed, super-admin sees all). **`snmp_poll_results` has no RLS** (compressed
TimescaleDB hypertable) and returns every org's metrics in every context.

## 8. Cache / realtime

- ✓ Topology cache key `topology:graph:o={org}:l={loc}:…`; aggregation caches
  `_org_scoped_key()`-prefixed; `/ws/events` + `/ws/anomalies` per-org channels.
- ✗ `cache:device:{id}:interfaces` / `:vlans` — no org/location segment.
- ✗ `/ws/tasks/{task_id}` — only a valid-token check, **no org scoping**.
- ⚠️ `/ws/events` location filter is permissive — `location_id=null` events
  broadcast org-wide across locations.

## 9. Frontend context

- ✗ No organization selector / super-admin org-switch (org is JWT-fixed —
  cross-org UI mixing not reachable).
- ⚠️ Location selector drives by **name string** (`setSite`/`activeSite`), not
  `location_id`.
- ✗ **Incidents** and **Agents** pages ignore location context entirely.
- ⚠️ **Dashboard** — ~10 widgets not location-keyed/filtered (org-wide).
- ⚠️ Devices / classic Topology / Monitor / Reports filter by `site` name
  string alongside the `X-Location-Id` header (dual mechanism).

## Current architecture

```
Organization (root, no RLS)
├── users (nullable org FK, NO RLS — app-enforced; user_locations IGNORED)
├── Location (org FK, RLS) ──── identity split: location_id (int) ‖ Device.site (string)
│   ├── Agent (org+loc, RLS) ── ingest scope-checked for status/trap, NOT syslog;
│   │                            commands NOT agent↔device scope-checked
│   └── Device (org+loc NOT NULL, RLS)
│       ├── topology_links / config_backups / mac / arp   (org+loc, RLS)   OK
│       ├── network_events / incidents                    (org, loc nullable, RLS) OK
│       ├── snmp_poll_results  (METRICS)                   (org+loc cols, NO RLS)  LEAK
│       ├── syslog_events      (LOGS)                      (org only, NO location)
│       └── discovery_results                             (org only, NO location)
└── _scoping safety net → unresolved rows → LOWEST-ID ORG + "Unassigned" loc  LEAK VECTOR
Redis: per-org event channels OK · interfaces cache unscoped · /ws/tasks unscoped
Frontend: JWT-fixed org · location-by-name · Incidents/Agents ignore location
```

## Intended architecture

```
Organization
└── Location  (the hard sub-boundary; everything below carries location_id, RLS-enforced)
    ├── Agent     — bound 1:1 org+location; all ingest + commands scope-checked at API AND DB
    └── Device    — org+location NOT NULL; a move re-stamps every child row
        └── Interfaces · Alerts · Metrics · Topology · Logs · Discovery
            — all device-bound tables RLS-scoped by org AND location, no exceptions
Caches + realtime: every key/channel namespaced by org (+ location where location-scoped)
Frontend: org + location selectors both by ID; every page consumes the active context
```

## Confirmed working

- RLS on 47 tables — org isolation verified (org-A ≠ org-B, no-context = 0,
  super-admin = all).
- Agent registration binds org+location authoritatively; status/trap ingest
  scope-checked.
- Per-org WebSocket event channels; org-namespaced aggregation/topology caches.
- Audit trail on tenancy-critical mutations; soft-delete RLS.
- Frontend org scope is JWT-fixed — cross-org UI mixing not reachable.

## Broken / incomplete

1. `snmp_poll_results` (metrics) — no RLS; leaks all orgs' rows in every context.
2. `syslog_events` (logs) + `discovery_results` — no `location_id`.
3. `user_locations` written but ignored; LOCATION_ADMIN enforced by role string only.
4. No device-move API; child rows never re-stamped on a move.
5. Agent syslog ingest + `snmp-get`/`snmp-walk`/`stream-command` not agent↔device scope-checked.
6. `/ws/tasks/{task_id}` and `cache:device:{id}:interfaces` not org-scoped.
7. Frontend: Incidents & Agents ignore location; Dashboard partial; selector by name.
8. `api_tokens` no RLS (latent). NOT NULL `location_id` columns with `ON DELETE SET NULL` FKs.

## Dangerous fallbacks

- `_scoping` default-org safety net → unresolved rows land in the lowest-id org.
- `create_org` `org_id=` bug → new org-admin user with NULL org.
- Legacy `tenant_id` FKs still live; `locations.tenant_id` CASCADE.

## Data-leak risks (ranked)

1. **HIGH** — `snmp_poll_results`: DB-level cross-org metric leak.
2. **HIGH** — `_scoping` default-org fallback: writes misattributed to the wrong org.
3. **MED** — `/ws/tasks/{task_id}`: cross-org task-progress leak.
4. **MED** — agent command endpoints: cross-location command execution.
5. **MED** — `cache:device:{id}:interfaces`: unscoped cache key.
6. **LOW** — cross-location event broadcast within an org; agent syslog not handler-scoped.
