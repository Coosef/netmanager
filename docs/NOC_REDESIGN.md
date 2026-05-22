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
| 2 | Uyarılar (/monitor) | /monitor | pages-alerts.jsx · Uyarilar.html | 🟡 header+statbar |
| 3 | Canlı İzleme (Monitor) | /monitor | pages-monitor.jsx · Canli Izleme.html | ⏳ |
| 4 | Servisler (Services) | /services | Servisler.html | 🟡 header |
| 5 | Kabinler (Racks) | /racks | pages-racks.jsx · Kabinler.html | 🟡 header |
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
- KPI stat row: `nm-hero` / `nm-kpi` (dashboards) or `nm-statbar` / `nm-stat` (list pages).
- Filters: chips (`nm-pill`) + search input.
- Tables/lists: `nm-table` / `nm-row` rows, `nm-pill`/`nm-chip` status, `nm-bar` for scores.
- Cards: `nm-card` + `nm-card-hd` (`<h3>` + pill).

## ✅ Definition of Done (per page — no partial pages)
A page is **done** only when ALL of these match its mockup:
1. **Header** — `nm-page-hd`: crumb + `<h1>` title + count `nm-pill` + right-aligned action buttons (`nm-btn`/`nm-btn primary`).
2. **Stat bar** — `nm-statbar` with the mockup's exact stat tiles (real data).
3. **Filters** — `nm-pill` filter chips + search input (real filtering kept).
4. **Main content** — table → `nm-table` (mockup columns, `nm-pill`/`nm-chip` status, `nm-bar` scores) OR card grid → `nm-card`/`nm-grid` (real data).
5. **Modals/drawers/forms** — design-consistent (dark NOC; antd themed is acceptable if visually clean).
6. **Verify** — `tsc` 0 · `vitest` · `build` clean.
7. **Screenshot** (dark) + **commit** + flip status to ✅ in the table above.

> Current gap: pages will first land at 🟡 (header+statbar) then be finished to ✅ (filters + nm-table/content). Devices is at 🟡.

## 🙋 What I need from you (to verify + match exactly)
- **Stay in DARK mode** when checking (top-bar sun/moon) — the NOC look lives there.
- **Per page: send the mockup screenshot** (like you did for Dashboard + Cihazlar). I have the source (`pages-*.jsx`/`*.html`) but a screenshot removes all guesswork and lets me match pixel-for-pixel.
- After each page's commit, **glance at it in the UI** (`http://localhost/<route>`) and tell me anything off (spacing, a column, a color) — I fix before moving on.
- If a page has **no mockup** (IPAM, VLAN, Reports, Users, etc.), tell me whether to (a) leave it on the inherited dark theme, or (b) design it to match the family.

## Detailed step list (execution order)
For EACH page, in this order, I will:
`read app page → read its mockup → header → statbar → filters → table/content (nm-*) → tsc/build → screenshot → commit → mark ✅`

1. **Cihazlar** 🟡 → finish: filter chips (vendor/site/layer) + nm-table (hostname·durum·vendor/model·firmware·katman·lokasyon·tag·agent·24sa·risk).
2. **Uyarılar** — header + statbar + alert list (`nm-row`, severity `nm-pill`, ack actions).
3. **Canlı İzleme** — live event stream + telemetry tiles.
4. **Servisler** — service-impact cards (`nm-card`) + dependency view.
5. **Kabinler** — rack elevation visualization.
6. **Ajanlar** — agent fleet table (status/devices/latency/cpu/ram).
7. **Playbooklar** — playbook list/cards.
8. **Otomasyon** — automation rules.
9. **Config Drift** — drift table + diff.
10. **SLA & Uptime** — SLA donuts + uptime tables.
11. **Audit Log** — audit `nm-table`.
12. **Ayarlar** — settings sections (`nm-card`).

## Phase 2 — Interactive features (LAST, after all page visuals)
Net-new product features from the mockup (state + persistence + decisions). Build
after the page-by-page visual rollout is complete. Tracked here so nothing is lost:
- **Özelleştir panel** — preset/role layouts (Operator/Admin/Exec/Wall) + top-bar role tabs (NOC/Admin/Yönetici); density (compact/regular/spacious); accent-color picker; menu position (side/top).
- **Dashboard edit mode** — drag-drop widget reorder, hide/show, "Widget Ekle"; **saved layouts** (named, persisted).
- **⌘K command palette** — nav + actions (customize/theme/edit/rotation/sound) on top of existing GlobalSearch.
- **NOC wall mode** — live ticker (done on dashboard), auto-rotation (cycle views fullscreen), critical sound alerts.
