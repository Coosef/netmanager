# Platform / Operations Panel Split — Design Document

**Status:** Design only — NOT implemented in PHASE1A.
**Phase:** Will be addressed as a separate branch (PHASE1B) after PHASE1A merges.
**Author:** Generated 2026-06-22 as part of `t10/platform-operations-split-org-context-phase1` design deliverables.

## 1. Purpose

Separate the React app into two top-level panels:

- **`/app/*`** — Operations panel. Daily tenant operations: devices, agents, monitoring, alerts, network, reports. Always scoped to ONE active organization. Available to every authenticated user.
- **`/platform/*`** — Platform Admin panel. Organization management, licenses, quotas, retention policies, platform users, global health, audit. `super_admin` (and a future `platform_admin` role) only.

The split is **routing-only** — no business logic moves between panels. The split is also **non-breaking** for existing bookmarks: a redirect from the legacy root routes (`/dashboard`, `/devices`, …) to the `/app/*` equivalents is provided for one release.

## 2. Why now

PR #105 fixed the X-Location-Id interceptor clobber bug. PR's t10/platform-operations-split-org-context-phase1 (this branch) adds the Organization Switcher so a super-admin can scope into a different tenant via X-Org-Id. The panel split is the **third leg** of the same operator experience:

- Without the split, the same Sidebar lists both tenant-scoped pages (Devices, Agents) and platform-scoped pages (Organizations, Licenses), and a destructive action on the "wrong" page is one click away from a cross-tenant blunder.
- With the split, the Operations panel **REFUSES** to load without an active tenant — there is no "Platform Mode" for `/app/*` routes. The Platform Admin panel inverts the rule.

## 3. Current state (PRE-split)

```
/login
/invite
/ssh/:deviceId
/welcome
/dashboard                           ← root-level Operations + Platform mixed
/devices
/devices/:deviceId
/devices/:deviceId/ports
/tasks
/topology, /topology-classic, /topology-next
/discovery
/monitor
/live
/reports
/users                               ← could be EITHER operations OR platform
/audit                               ← same
/terminal-sessions
/agents
/settings                            ← currently `super_admin` only
/profile
/playbooks
/approvals
/mac-arp, /ipam, /security-audit, /asset-lifecycle
/diagnostics
/bandwidth
/config-templates, /config-builder
/poe, /firmware
/change-management
/sla
/vlan
/backups
/racks
/credential-profiles
/help
/network-inspector
```

**Count:** 59 `<Route>` elements in `App.tsx`.

## 4. Target structure (POST-split)

### 4.1 Operations panel `/app/*` (every authenticated user; tenant required)

```
/app                                 (index → /app/dashboard)
/app/dashboard
/app/devices
/app/devices/:deviceId
/app/devices/:deviceId/ports
/app/agents
/app/topology
/app/topology-classic
/app/topology-next
/app/discovery
/app/monitor
/app/live
/app/reports
/app/audit
/app/terminal-sessions
/app/playbooks
/app/approvals
/app/mac-arp
/app/ipam
/app/security-audit
/app/asset-lifecycle
/app/diagnostics
/app/bandwidth
/app/config-templates
/app/config-builder
/app/poe
/app/firmware
/app/change-management
/app/sla
/app/vlan
/app/backups
/app/racks
/app/credential-profiles
/app/help
/app/network-inspector
/app/tasks
/app/profile
```

### 4.2 Platform Admin panel `/platform/*` (super_admin / platform_admin only)

```
/platform                            (index → /platform/overview)
/platform/overview                   (global tenants summary)
/platform/organizations              (list + create / edit)
/platform/organizations/:id          (org detail — plan, users, locations, quotas)
/platform/users                      (platform-level user management — NOT tenant users)
/platform/roles                      (role + capability matrix editor)
/platform/licenses                   (subscription / plan editor)
/platform/quotas                     (per-org quota dashboard)
/platform/retention                  (per-org retention policy editor — see RETENTION_POLICY_DESIGN.md)
/platform/global-health              (cross-tenant health board)
/platform/audit                      (platform-level audit — different from per-org audit)
/platform/settings                   (platform settings; existing `/settings` page reused)
```

### 4.3 Auth & public routes (unchanged)

```
/login
/invite
/welcome
/ssh/:deviceId
```

### 4.4 Legacy redirects (one release window)

A `<Route path=":legacy/*" element={<LegacyRedirect />}>` element at the top of the router maps every existing root-level page to its `/app/*` equivalent. After ONE release, the redirects are removed.

```
/dashboard          →  /app/dashboard
/devices            →  /app/devices
/devices/:deviceId  →  /app/devices/:deviceId
… all 59 routes …   →  /app/<same path>
```

## 5. Authorization Matrix

| Route prefix     | Required role                              | Active tenant required? | Behavior                                                                                                                        |
| ---------------- | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/login`, `/invite`, `/welcome`, `/ssh/:deviceId` | Public                            | No                      | Existing behavior                                                                                                               |
| `/app/*`         | Any authenticated user                     | **YES — REQUIRED**      | If `useSite().organization === null` AND `isSuperAdmin === true`, redirect to `/platform/overview` and prompt to pick a tenant. |
| `/platform/*`    | `super_admin` (and future `platform_admin`) | No                      | Renders even without an active tenant — this is the "Platform Mode" panel.                                                      |

`PermRoute` and `RoleRoute` wrappers stay verbatim; only the path prefix changes.

## 6. Sidebar / MenuGroupNav changes

The Sidebar gains a **panel switch** at the top:

```
┌─────────────────────┐
│  Charon NM          │
│ ┌─────────────────┐ │
│ │ ▸ Operations    │ │  ← /app/*
│ │   Platform Admin│ │  ← /platform/* (super_admin only)
│ └─────────────────┘ │
│                     │
│  ─ Sidebar items ─  │  (filtered by panel)
│                     │
└─────────────────────┘
```

When the operator switches panels, the Sidebar regenerates its item list against the panel-aware MenuGroupNav data. Currently MenuGroupNav.tsx has hardcoded route paths; the migration replaces them with two parallel sections:

```ts
const OPERATIONS_NAV = [ /* /app/* routes */ ]
const PLATFORM_NAV   = [ /* /platform/* routes */ ]

const activeNav = currentPanel === 'platform' ? PLATFORM_NAV : OPERATIONS_NAV
```

## 7. Header changes

| Element                | Operations panel                    | Platform Admin panel                |
| ---------------------- | ----------------------------------- | ----------------------------------- |
| Active organization    | **Required**, shown as badge        | Switcher (PHASE1A widget), **optional** |
| Active location        | LocationSelector                    | Hidden — platform mode is org-wide  |
| Page title             | "Devices — ATG Hotels"              | "Platform Admin"                    |

The Header detects the active panel via `useLocation().pathname.startsWith('/platform')`.

## 8. Migration Plan (when PHASE1B starts)

### 8.1 Phase 1B.1 — Routing + Layout (1-2 days)

- Add `<Route path="app">` + `<Route path="platform">` wrappers in `App.tsx`.
- Move every existing `<Route>` (except auth/public) into the `app` wrapper.
- Add new `<Route>` skeletons in the `platform` wrapper (mostly placeholders for now).
- Add `<LegacyRedirect>` at the top.
- Update `RootRedirect` to `/app/dashboard`.
- Update Sidebar/MenuGroupNav with panel-aware navigation.
- Update Header active-tenant badge.

### 8.2 Phase 1B.2 — Internal `navigate()` callers (1 day)

`grep -rn "navigate('/" frontend/src` → ~60 call sites. Each gets updated to `/app/<path>`. Where the destination is platform-only (Organizations, Licenses, Retention), update to `/platform/<path>`.

### 8.3 Phase 1B.3 — Tests (1 day)

- `RootRedirect.test.tsx` — updated assertions.
- `ProtectedRoute.tokenFirst.test.tsx` — updated paths.
- Integration smoke for legacy redirects.

### 8.4 Estimated total

3-4 days focused work, ~100 files touched, ~1500 LOC delta. Worth a dedicated PR.

## 9. Risks & Mitigations

| Risk                                                                                              | Mitigation                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 — Existing bookmarks 404                                                                       | `<LegacyRedirect>` for one release window; documented sunset date.                                                                                                        |
| R2 — Sidebar regression                                                                           | Sidebar tests (existing + new panel-switch test); MenuGroupNav data tables are pure JS, easy to snapshot.                                                                 |
| R3 — Operator confusion ("where did /devices go?")                                                | Documentation + a one-time toast on the first login after deploy.                                                                                                         |
| R4 — `/app/*` requires tenant; super-admin in Platform Mode would be locked out of all ops pages  | Detect this in the `<RequireTenant>` guard and redirect to `/platform/overview` with an inline "Pick a tenant to enter Operations" CTA.                                   |
| R5 — Tests that hardcode `/devices`                                                               | Suite-wide grep + mechanical update; `LegacyRedirect` covers any that escape.                                                                                             |

## 10. Test Plan (PHASE1B)

Frontend:
- LegacyRedirect maps `/dashboard` → `/app/dashboard`
- `/app/devices` requires active tenant (redirect path verified)
- `/platform/organizations` requires `super_admin`
- Sidebar shows OPERATIONS_NAV when on `/app/*`
- Sidebar shows PLATFORM_NAV when on `/platform/*`
- Header active-tenant badge renders on `/app/*` and not on `/platform/*`
- Panel switch widget toggles `navigate('/app/...')` / `navigate('/platform/...')`
- ProtectedRoute still token-first (PR #73 + #103 contract preserved)

## 11. Open Questions (for product review)

1. Should `/platform/audit` and `/app/audit` show different data slices, or is `/app/audit` a filtered view of the same store?
2. Where does **profile** live? Currently `/profile`; proposed `/app/profile`. Same routing for `/platform/profile`?
3. Should the `Settings` page (`super_admin` only currently) move to `/platform/settings`, or stay reachable from both panels?

## 12. Non-Goals

- This document does NOT implement the split.
- This document does NOT change backend endpoints.
- This document does NOT touch the X-Org-Id mechanism (handled by PHASE1A).
- This document does NOT design Cross-Org Device Transfer (Phase 3 — separate doc).

## 13. References

- `docs/design/RETENTION_POLICY_DESIGN.md` — companion design doc.
- `frontend/src/App.tsx` — current 59-route source of truth.
- `frontend/src/components/Layout/Sidebar.tsx` and `MenuGroupNav.tsx` — current navigation tree.
- PR #102 — backend cross-tenant guards (gate of last resort).
- PR #103 — site-context hydration guard (consumed by Phase 1A).
- PR #104 — DeviceForm location scope filter.
- PR #105 — X-Location-Id interceptor caller-respect (foundation for X-Org-Id mirror).
