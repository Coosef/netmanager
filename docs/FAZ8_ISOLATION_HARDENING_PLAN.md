# Faz 8 — Organization / Location Isolation Hardening

> **Status:** Approved — architecture decision folded in; execution starts at
> **Phase A**. **Branch:** `feature/faz8-isolation-hardening`.
> **Driver:** [ISOLATION_AUDIT.md](ISOLATION_AUDIT.md) — the real product behavior
> does not match the intended `Organization → Location → …` model.
> Topology work (T0–T7) is paused until Faz 8 lands.

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

## Product architecture decision — Organization is a hidden tenant boundary

Organization is a **hidden customer / account / license boundary**, not a daily
operational object. **Normal users never see or switch organizations.**
**Location** is the **visible operational boundary** users work in.

### Organization (super-admin domain)
Carries account / licensing metadata — not operational data:
- license plan · package / feature flags
- quotas: max users, max devices, max agents, max locations
- subscription status
- usage counters: current users / devices / agents / locations
- billing / support metadata

### Operational hierarchy
- **Organization** — hidden customer / account / license boundary
- **Location** — visible operational boundary
- **Agent** — bound to exactly one organization + one location
- **Device** — bound to exactly one organization + one location
- All telemetry / logs / metrics / topology / alerts / discovery belong under
  **organization + location**.

### Roles
- **SUPER_ADMIN** — manages organizations; the only role that sees orgs.
- **ORG_ADMIN** — manages every location inside its own organization: create
  locations, add users, assign users to locations, assign per-location roles,
  register agents, manage devices in any of its locations.
- **LOCATION_ADMIN** — manages only the locations granted via `user_locations`.
- **VIEWER** — sees only its assigned locations.

### Authorization model (definitive)
- `user.organization_id` = the hidden tenant boundary (the RLS org scope).
- `user_locations` = **the source of truth** for which locations a user may
  access. Phase E wires it into deps / context / RBAC / frontend.
- LOCATION_ADMIN and VIEWER location access is enforced through
  `user_locations`. ORG_ADMIN implicitly covers every location in its org.

### Frontend
- Normal users see **only a location selector** — no organization selector.
- SUPER_ADMIN has an **organization management area** showing per-org usage
  (users / locations / devices / agents counts), license plan, package limits
  and subscription status.

This decision governs Phases **E** (access model), **F** (frontend) and **H**
(organization management model); Phases A–D are unchanged by it.

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

**Objective:** make `user_locations` the enforced source of truth for location
access (per the product architecture decision above).

1. **`user_locations` is the source of truth.** Wire it into `deps.py` /
   `context.py` / the RBAC engine:
   - The set of locations a non-super, non-ORG_ADMIN user may access = its
     `user_locations` rows. The `X-Location-Id` header is validated against
     that set; an ungranted location is rejected.
   - **LOCATION_ADMIN** — admin rights only for locations it holds a
     `user_locations` grant for; reject location-admin actions on other
     locations.
   - **VIEWER** — read-only, and only its granted locations.
   - **ORG_ADMIN** — implicitly every location in its `organization_id`;
     `user_locations` rows not required.
   - **SUPER_ADMIN** — unaffected (org-management scope).
2. `GET /context/locations` returns the user's accessible locations from
   `user_locations` (ORG_ADMIN → all org locations).
3. Reconcile `user_location_perms` — keep only if it adds per-location
   permission-set granularity beyond `loc_role`; otherwise remove it.
4. Document the final access model.

**Critical files:** `app/core/deps.py`, `app/api/v1/endpoints/context.py`,
`app/services/rbac/*`, `app/models/user_location.py`, `endpoints/users.py`
(location-assignment endpoints), `endpoints/locations.py`.

**Verification gate:** a LOCATION_ADMIN / VIEWER without a `user_locations`
grant for the requested location is denied at the API level and sees zero rows
at the DB level; an ORG_ADMIN reaches every location in its org; a granted user
reaches exactly its granted locations; `/context/locations` matches.

---

## Phase F — Frontend context correction

**Objective:** every page consumes the active location by ID; the organization
stays hidden from normal users.

1. **Location selector** uses `location_id` (integer), not the `site` name
   string — `SiteContext` + the top-bar component. Its options come from the
   user's accessible locations (Phase E `/context/locations`).
2. **No organization selector for normal users.** The organization stays the
   hidden tenant boundary — only the super-admin org-management area (Phase H)
   exposes organizations.
3. **Incidents, Agents, and all Dashboard widgets** consume the active location
   context (React Query keys + request params).
4. Remove dual `site`-name filtering wherever a `location_id` path exists.

**Critical files:** `frontend/src/contexts/SiteContext.tsx`,
`components/Layout/Header.tsx`, `pages/Incidents`, `pages/Agents`,
`pages/Dashboard`, `pages/Devices`, `pages/Monitor`, `pages/Reports`,
classic `pages/Topology`, and their `api/*` modules.

**Verification gate:** switching location refetches and narrows every listed
page; no page filters by `site` name string where `location_id` is available;
no page shows org-wide data while a location is selected; no organization
selector is reachable by a non-super-admin.

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

## Phase H — Organization management model

**Objective:** make Organization the hidden tenant / account / license boundary
with a super-admin-only management surface (per the architecture decision).

1. **Schema** — extend `organizations` with account/licensing fields: license
   plan / package / feature flags, quotas (`max_users`, `max_devices`,
   `max_agents`, `max_locations`), `subscription_status`, billing / support
   metadata. (Some may already exist — `plan_id`, `trial_ends_at`,
   `subscription_ends_at`; reconcile, don't duplicate.) Migration + model.
2. **Usage counters** — a super-admin endpoint returning per-org usage:
   current users / locations / devices / agents counts vs. the plan limits.
3. **Quota enforcement** — creation of a user / location / device / agent
   checks the org's limit and rejects past quota (clear error).
4. **Super-admin organization-management area** — frontend: list orgs, view
   usage + license + subscription; create / edit orgs. Not reachable by
   non-super-admins.
5. Normal users have **no organization UI** anywhere.

**Critical files:** `app/models/shared/organization.py` + migration,
`app/api/v1/endpoints/super_admin.py` / a new `organizations` endpoint,
creation endpoints (quota checks), `frontend/src/pages/SuperAdmin/*`.

**Verification gate:** super-admin sees per-org usage vs. limits; a creation
past quota is rejected; no organization endpoint or UI is reachable by a
non-super-admin; org remains absent from every normal-user surface.

---

## Sequencing & gates

A → B → C → D → E → F → G → H. Phase A first (it stops live leaks); H last (it
is a management surface, not a leak). Each phase is a **clean committed gate** —
tests green, RLS reality check clean, no regressions — before the next begins.
After all phases: a full cross-layer verification (DB, API, worker, WebSocket,
cache, agent, frontend) re-run before Faz 8 is declared complete.

## Out of scope / parallel

- **M6** legacy `tenant_id` drop — tracked separately
  ([M6_LEGACY_DROP_BACKLOG.md](M6_LEGACY_DROP_BACKLOG.md)).
- **TD-1** `@xterm` dependency — tracked separately
  ([TECH_DEBT_BACKLOG.md](TECH_DEBT_BACKLOG.md)).
- Topology "Final Gold Release" (T0–T7) is **paused** until Faz 8 lands.
