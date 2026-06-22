/**
 * PR-A — Platform/Operations panel split + URL-authoritative org routing.
 *
 * `PanelMode` is the orthogonal dimension to RBAC: it answers "which
 * layout shell + sidebar + header surface is this route?" without
 * touching the existing 12-group legacy sidebar.
 *
 *   - `platform`   → `/platform/*` super-admin control plane
 *                    (Overview, Firmalar, … Yakında)
 *   - `operations` → `/app/org/:organizationId/*` URL-authoritative
 *                    org-scoped operations panel (Dashboard, Devices,
 *                    Agents, … Yakında)
 *   - `legacy`     → every other in-app route. The existing AppLayout
 *                    sidebar/header render unchanged so PR-A is a
 *                    purely additive foundation; subsequent PRs migrate
 *                    each legacy module into the operations panel.
 *
 * Pure for unit testing — every panel decision in AppLayout/Header
 * derives from this single function so a future regression is caught by
 * a single test fixture matrix.
 */
export type PanelMode = 'platform' | 'operations' | 'legacy'

export function detectPanelMode(pathname: string): PanelMode {
  if (pathname === '/platform' || pathname.startsWith('/platform/')) {
    return 'platform'
  }
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    return 'operations'
  }
  return 'legacy'
}

/**
 * Extract `:organizationId` from a route shaped like `/app/org/<id>/...`.
 * Returns `null` for any non-operations or non-numeric path — callers
 * use that to decide between rendering the operations shell and falling
 * back to the LegacyRedirect home resolution.
 */
export function extractRouteOrgId(pathname: string): number | null {
  const match = pathname.match(/^\/app\/org\/(\d+)(?:\/|$)/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isFinite(id) && id > 0 ? id : null
}
