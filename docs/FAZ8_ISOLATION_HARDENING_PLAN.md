# Faz 8 — Organization / Location Isolation Hardening

> **Status:** Plan for review — **no code changes until this plan is approved.**
> **Driver:** [ISOLATION_AUDIT.md](ISOLATION_AUDIT.md) — the real product behavior
> does not match the intended `Organization → Location → …` model.
> **Branch:** a new branch off the current head; topology work (T0–T7) pauses
> until Faz 8 lands.

## Context

The Faz 7 RLS layer genuinely isolates 47 tables by `organization_id`, but the
audit found active leaks and incomplete location enforcement: metrics
(`snmp_poll_results`) have no RLS and return every org's rows; the `_scoping`
fallback silently misattributes unresolved writes to the lowest-id org; logs
and discovery results have no `location_id`; agent syslog/command paths and
two cache/WS surfaces are unscoped; and several frontend pages ignore the
location context. Faz 8 closes these — strictly, with verification at every
layer (DB, API, worker, WebSocket, cache, agent, frontend).

**Completion rule:** no phase — and not Faz 8 — is "done" until isolation is
verified at **DB, API, worker, WebSocket, cache, agent and frontend** levels.
"Code written" ≠ "isolation enforced."

---

## Phase A — Stop active leaks immediately  *(highest priority)*

**Objective:** eliminate the live cross-org leaks before anything else.

1. **`snmp_poll_results` isolation.** It is a compressed TimescaleDB hypertable
   — native RLS is unsupported. Options to evaluate (pick one in the phase):
   (a) a `SECURITY BARRIER` view + revoke direct table access; (b) a mandatory
   scoped data-access layer all readers must go through; (c) re-partition the
   recent window into an RLS-capable table. The chosen mechanism must make an
   unscoped query impossible, not merely discouraged.
2. **`/ws/tasks/{task_id}`** — resolve the connection's org from the token and
   verify the task belongs to it before streaming progress.
3. **`cache:device:{id}:interfaces` / `:vlans`** — route through
   `_org_scoped_key()` (or equivalent) so the key embeds organization (+
   location).
4. **`api_tokens`** — enable RLS (or an equivalent enforced scope); make
   `organization_id` NOT NULL.

**Critical files:** `app/models/snmp_metric.py`, `app/api/v1/endpoints/metrics*`/
`monitor.py`/`bandwidth*`, new `alembic` revision; `app/api/v1/endpoints/ws.py`;
`app/api/v1/endpoints/interfaces.py`; `app/models/api_token*.py` + migration.

**Verification gate:** a Postgres test proving an org-A session cannot read any
org-B `snmp_poll_results` row through the new access path; an org-A token
cannot open `/ws/tasks` for an org-B task; the interfaces cache key for org-A ≠
org-B; `api_tokens` RLS reality check (org-A / org-B / no-context).

---

## Phase B — Remove the dangerous fallback

**Objective:** no write may ever be silently stamped into the wrong org.

1. **Delete the `_scoping` default-org / Unassigned safety net** entirely. When
   org/location cannot be resolved for a NOT-NULL-scoped insert, **fail closed
   with an explicit error**, not a default.
2. **`create_device` / `create_location`** — explicitly resolve and set
   `organization_id` / `location_id` (from the validated request context),
   never relying on the hook's fallback.
3. **Fix `create_org`** — the new org-admin user must be created with the
   correct `organization_id` (the `org_id=` attribute bug).

**Critical files:** `app/models/_scoping.py`, `app/api/v1/endpoints/devices.py`,
`locations.py`, `super_admin.py` / org-creation endpoint.

**Verification gate:** an insert with empty org context raises (does not
default); `create_device`/`create_location` set scope explicitly and reject a
missing/ambiguous context; a newly created org-admin has the right
`organization_id`; full test suite + background-traffic run shows no
NULL-org / NOT-NULL-violation errors.

---

## Phase C — Complete the location hierarchy

**Objective:** logs and discovery truly live under `Organization → Location`.

1. **Add `location_id`** to `syslog_events` and `discovery_results`
   (migration + model + `_scoping` coverage); backfill from the related device
   / agent where derivable.
2. **Fix the NOT NULL + `ON DELETE SET NULL` contradiction** on
   `devices.location_id`, `agents.location_id` and peers — either make the
   column nullable, or change the FK to `RESTRICT` / `CASCADE` consistent with
   intent.
3. Confirm every device-bound table is reachable as
   `Organization → Location → Device → row`.

**Critical files:** `app/models/syslog_event.py`,
`app/models/discovery_result*.py`, device/agent models, new `alembic`
revisions; `app/models/_scoping.py`.

**Verification gate:** `syslog_events` / `discovery_results` carry `location_id`
and are RLS-location-scoped; deleting a location no longer errors on dependent
rows; an RLS reality check confirms location filtering narrows logs/discovery.

---

## Phase D — Agent enforcement

**Objective:** an agent can never ingest or command outside its own
organization + location.

1. **Scope-check agent syslog ingest** — `_handle_syslog_event` must validate
   the resolved device against `_devices_in_agent_scope` (or stamp from the
   agent's org/location when device-less).
2. **Scope-check `snmp-get`, `snmp-walk`, `stream-command`** — verify the target
   device's org + location equal the agent's before dispatch.
3. Bound agent **discovery** to the agent's location where feasible.

**Critical files:** `app/services/agent_manager.py`,
`app/api/v1/endpoints/agents.py`.

**Verification gate:** an agent in location X is rejected (logged + dropped)
when ingesting/commanding for a device in location Y or org Z — proven at the
API level and, where applicable, the worker/DB level.

---

## Phase E — Location access model

**Objective:** decide and enforce how users are scoped to locations.

1. **Decide:** is `user_locations` the source of truth for location access?
   - **If yes:** wire it into `deps.py` / `context.py` / the RBAC engine and
     the frontend — `LOCATION_ADMIN` and location visibility must consult a
     real `user_locations` grant for the active location.
   - **If no:** remove `user_locations` (+ `user_location_perms` if redundant)
     and simplify to org-scope + role.
2. Document the decision and the resulting access model.

**Critical files:** `app/core/deps.py`, `app/api/v1/endpoints/context.py`,
`app/services/rbac/*`, `app/models/user_location.py`, frontend context.

**Verification gate:** a `location_admin` without a grant for the active
location is denied (if yes-path); or `user_locations` is fully removed with no
dangling references (if no-path). Documented.

---

## Phase F — Frontend context correction

**Objective:** every page consumes the active organization + location by ID.

1. **Location selector** uses `location_id` (integer), not the `site` name
   string — `SiteContext` + the top-bar component.
2. **Incidents, Agents, and all Dashboard widgets** consume the active
   org/location context (React Query keys + request params).
3. Remove dual `site`-name filtering wherever a `location_id` path exists.

**Critical files:** `frontend/src/contexts/SiteContext.tsx`,
`components/Layout/Header.tsx`, `pages/Incidents`, `pages/Agents`,
`pages/Dashboard`, `pages/Devices`, `pages/Monitor`, `pages/Reports`,
classic `pages/Topology`, and their `api/*` modules.

**Verification gate:** switching location refetches and narrows every listed
page; no page filters by `site` name string where `location_id` is available;
no page shows org-wide data while a location is selected.

---

## Phase G — Device ownership rules

**Objective:** no silent stale location data.

1. **Decide:** is a device's location immutable?
   - **If immutable:** enforce it (reject `location_id` changes) and document.
   - **If movable:** add an explicit **device-move endpoint** that re-stamps
     (or clearly archives) every child row — `topology_links`,
     `network_events`, `incidents`, `config_backups`, `snmp_poll_results`,
     `mac/arp`, `syslog_events` — and writes the move to the audit trail.

**Critical files:** `app/api/v1/endpoints/devices.py`, child models,
`app/core/tenant_audit.py`.

**Verification gate:** either a location change is rejected, or a move
re-stamps/archives all child rows and no stale-location rows remain; audited.

---

## Sequencing & gates

A → B → C → D → E → F → G. Phase A first (it stops live leaks). Each phase is a
**clean committed gate** — tests green, RLS reality check clean, no regressions
— before the next begins. After all phases: a full cross-layer verification
(DB, API, worker, WebSocket, cache, agent, frontend) re-run before Faz 8 is
declared complete.

## Out of scope / parallel

- **M6** legacy `tenant_id` drop — tracked separately
  ([M6_LEGACY_DROP_BACKLOG.md](M6_LEGACY_DROP_BACKLOG.md)).
- **TD-1** `@xterm` dependency — tracked separately
  ([TECH_DEBT_BACKLOG.md](TECH_DEBT_BACKLOG.md)).
- Topology "Final Gold Release" (T0–T7) is **paused** until Faz 8 lands.
