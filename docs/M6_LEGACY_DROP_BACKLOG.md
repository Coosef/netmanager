# M6 — Legacy `tenant_id` Drop Backlog

Faz 7 Phase 7 (migration **M6**) drops the legacy tenancy layer one release
after Phase 6 ships and verifies clean in production. M6 is **blocked** until
every item below is done — dropping the column / enum before then breaks
isolation or import.

Status as of Phase 6 closure: Phases 1–6 complete and verified. RLS by
`organization_id` is the live isolation mechanism. The legacy `tenant_id`
column is still populated and a small number of code paths still read it.

## Blockers (must clear before M6)

### B1 — `users.py` still filters by `tenant_id`
`app/api/v1/endpoints/users.py` scopes user queries with
`User.tenant_id == current_user.tenant_id` (list/get/update/delete/
reset-password/user-location endpoints, ~7 sites). The `users` table is
intentionally **outside RLS** (auth must query users before org context
exists), so `tenant_id` is currently the *only* isolation for these
endpoints. Convert to `User.organization_id == current_user.organization_id`.
`_is_platform_admin()` (`not user.tenant_id`) → `not user.organization_id`.

### B2 — `invites.py` still filters by `tenant_id`
`app/api/v1/endpoints/invites.py` scopes invite-token queries with
`InviteToken.tenant_id == current_user.tenant_id` (list/delete, 2 sites).
`invite_tokens` is also outside RLS. Convert to `organization_id`.

### B3 — Tenant→Organization quota logic
`users.py::create_user` enforces the SaaS user quota against
`Tenant.max_users` and looks the tenant up via `select(Tenant)`. The
`Organization` model must carry the equivalent quota field (or the quota
must move to `Plan`), and the lookup must switch to `Organization`. The
`UserCreate` schema field `tenant_id` must become `organization_id`.

### B4 — `UserRole` enum retirement
The legacy `UserRole` enum is still imported and used for role checks
(`require_roles(UserRole.SUPER_ADMIN, …)`, `_is_platform_admin`, branch
logic in `users.py` and elsewhere). Phase 4 introduced the 4-role
`SystemRole` model (`SUPER_ADMIN/ORG_ADMIN/LOCATION_ADMIN/VIEWER`); all
remaining `UserRole` references must move to `SystemRole`, then
`UserRole` + `ROLE_PERMISSIONS` are deleted.

## Also part of M6 (mechanical, after B1–B4)

- Drop `tenant_id` from all tables; drop `users.role`; drop the `tenants`
  table; delete `models/tenant.py`, `endpoints/tenants.py`.
- Remove `_create_default_tenant()` + the deprecated `ALTER TABLE` block
  from `main.py`.
- Remove the legacy `TenantFilter` / `LocationFilter` / `LocationNameFilter`
  deps and `get_tenant_context` from `deps.py`, plus the now-dead guarded
  `if tenant_filter is not None:` clauses (~70 sites — harmless until then).

## Verification gate before M6 ships

The `tenant_id` audit (Phase 6 closure) confirmed **no current runtime
dependence** on `tenant_id` that breaks isolation — every legacy
`.where(tenant_id == tenant_filter)` is guarded and dead. B1–B4 are the
*only* live readers. After B1–B4 land, re-run the audit; it must report
zero `tenant_id` reads outside `tenants.py` before M6 may drop the column.
