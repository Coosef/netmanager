import { useEffect } from 'react'
import { Navigate, Outlet, useParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'

/**
 * PR-A — URL-authoritative organization context shell.
 *
 * Wraps every `/app/org/:organizationId/*` route. The contract:
 *
 *   1. The organization id comes from the URL, not from header/
 *      localStorage state. A super-admin's `activeOrgId` is kept in
 *      sync with the URL param via `setOrganization(routeOrgId)`, which
 *      writes the X-Org-Id header consumed by the Axios interceptor and
 *      the backend `resolve_location_context`.
 *   2. Normal (non-super-admin) users may only enter `/app/org/<own>/*`.
 *      A mismatched id redirects to `/app/org/<own>/dashboard` — the URL
 *      cannot be used to escalate scope.
 *   3. The id is validated at mount + on every URL change. Stale
 *      `activeOrgId` from a previous session never leaks into the
 *      operations panel.
 *
 * The shell renders `<Outlet />`; the surrounding AppLayout's sidebar
 * switches to `OperationsSidebar` via `detectPanelMode(pathname)`.
 */
export default function OrgRouteShell() {
  const { organizationId } = useParams<{ organizationId: string }>()
  const routeOrgId = organizationId ? Number(organizationId) : NaN
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.system_role === 'super_admin'
  const userOrgId = user?.org_id ?? null

  const { activeOrgId, setOrganization, isPlatformSuperAdmin, ctxResolved } = useSite()

  // URL-authoritative sync: when a super-admin enters /app/org/:id, the
  // activeOrgId in SiteContext (and therefore the X-Org-Id header) MUST
  // mirror the URL. Without this sync the operator's bookmark to
  // /app/org/6/devices would render the previously-active tenant's data
  // for the first paint while the header sticky-cached the wrong org.
  useEffect(() => {
    if (!Number.isFinite(routeOrgId) || routeOrgId <= 0) return
    if (!isPlatformSuperAdmin) return // normal users: tenant fixed by JWT
    if (activeOrgId === routeOrgId) return
    setOrganization(routeOrgId)
  }, [routeOrgId, isPlatformSuperAdmin, activeOrgId, setOrganization])

  // Defensive: invalid / non-numeric :organizationId in the URL.
  if (!Number.isFinite(routeOrgId) || routeOrgId <= 0) {
    return <Navigate to="/" replace />
  }

  // Wait for context resolution before deciding scope — premature
  // redirect on a still-resolving normal user would push them to /
  // and loop. ctxResolved is the same hydration guard PR #103 codified.
  if (!ctxResolved) return null

  // Normal user (not super-admin) can only enter their own org.
  if (!isSuperAdmin) {
    if (userOrgId == null) {
      // Defensive: a user with no org_id at all. Bounce home — RootRedirect
      // handles the actual fallback (login / message).
      return <Navigate to="/" replace />
    }
    if (routeOrgId !== userOrgId) {
      return <Navigate to={`/app/org/${userOrgId}/dashboard`} replace />
    }
  }

  return <Outlet />
}
