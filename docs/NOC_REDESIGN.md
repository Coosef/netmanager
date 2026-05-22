# T8.4 — NOC Design Rollout (Claude Design "NetManager" mockups)

Branch: `topology-gold/T8.4-noc-design` · **local only — not pushed, not deployed** until user says.

## Approach
The design's `styles.css` is vendored (scoped) at `frontend/src/styles/noc.css`
(oklch token system; every rule under `.nm-root`/`.nm-*`/`.theme-light`, no global
selectors → safe). Pages are rebuilt against the `nm-*` markup on the existing
React/antd stack + **real data** (Sigma/Three engine untouched). Dark theme is the
NOC look; `.theme-light` flips the design vars.

## Per-page workflow (do each, in order)
1. Read the app page (`frontend/src/pages/<Page>/index.tsx`) — keep its data hooks + routing + permissions.
2. Read the mockup (`/tmp/nm-design/bundle/netmanager/project/` — `pages-*.jsx` + `NetManager *.html`).
3. Rebuild markup to `nm-*` classes; wire **real** data (empty-state where sparse — system in transition, accepted).
4. Verify: `tsc -p tsconfig.json --noEmit` (0) · `vitest run` · `npm run build` (clean).
5. Screenshot in dark mode (Playwright + SwiftShader, login `admin/Admin@1234!`).
6. Commit on the branch (`feat(t8.4): <page> …`).

## Page status
| # | Page | Route | Mockup | Status |
|---|------|-------|--------|--------|
| — | Shell (sidebar/topbar/grid) | — | shell.jsx | ✅ `6953cca` |
| — | Theme tokens (dark NOC + IBM Plex) | — | styles.css | ✅ `6953cca` |
| — | Topology | /topology-next | pages-topology.jsx | ✅ `6953cca` |
| — | Dashboard | / | dashboard.jsx + widgets.jsx | ✅ `a6cdf51` |
| 1 | Cihazlar (Devices) | /devices | pages-devices.jsx · Cihazlar.html | 🟡 `10c4491` header+statbar (table→nm-table pending) |
| 2 | Uyarılar (Alerts) | /monitor (alerts) | pages-alerts.jsx · Uyarilar.html | ⏳ |
| 3 | Canlı İzleme (Monitor) | /monitor | pages-monitor.jsx · Canli Izleme.html | ⏳ |
| 4 | Servisler (Services) | /services | Servisler.html | ⏳ |
| 5 | Kabinler (Racks) | /racks | pages-racks.jsx · Kabinler.html | ⏳ |
| 6 | Ajanlar (Agents) | /agents | Ajanlar.html | ⏳ |
| 7 | Playbooklar | /playbooks | Playbooklar.html | ⏳ |
| 8 | Otomasyon | /automation? | Otomasyon.html | ⏳ |
| 9 | Config Drift | /config-drift | Config Drift.html | ⏳ |
| 10 | SLA & Uptime | /sla | SLA.html | ⏳ |
| 11 | Audit Log | /audit | pages-audit.jsx · Audit.html | ⏳ |
| 12 | Ayarlar (Settings) | /settings | Ayarlar.html | ⏳ |

**Pages without a mockup** (IPAM, VLAN, Backups, Compliance, Floor-plan, Intelligence,
Alert-rules, Bandwidth, Mac-arp, Security-audit, Asset-lifecycle, Diagnostics, Tasks,
Config-templates, Change-management, Approvals, Synthetic-probes, Incidents, Escalation,
Topology-twin, Reports, SuperAdmin, Permissions, AI-assistant, Users, Locations,
Driver-templates, Help) inherit the dark NOC theme + shell automatically; rebuild only
if a mockup is provided later.

## Conventions (match the design, keep real behaviour)
- Page header: `ENVANTER › X` crumb + `<h1>` + count chip + action buttons (right).
- KPI stat row: `nm-hero` / `nm-kpi`.
- Filters: chips (`nm-pill`) + search input.
- Tables/lists: `nm-row` rows, `nm-pill`/`nm-chip` status, `nm-bar` for scores.
- Cards: `nm-card` + `nm-card-hd` (`<h3>` + pill).
