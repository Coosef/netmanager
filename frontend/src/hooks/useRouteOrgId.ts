import { useLocation } from 'react-router-dom'
import { extractRouteOrgId } from '@/utils/panelMode'

/**
 * PR-A REVISED — URL-authoritative org scope hook.
 *
 * Returns the `:organizationId` from `/app/org/:organizationId/*` paths
 * via `useLocation()` + the pure `extractRouteOrgId` helper. Returns
 * `null` for every legacy / platform route — callers fall back to
 * `useSite().activeOrgId` only when this returns null.
 *
 * Why `useLocation` instead of `useParams`:
 *   - `useParams` only resolves :organizationId inside a Route child of
 *     OrgRouteShell. The same hook must work for components mounted
 *     OUTSIDE the org route tree (Header.OrgBadge, AppLayout sidebar
 *     switch, the SiteProvider's queryKey) where useParams returns {}.
 *   - `useLocation` is universal: it returns the live URL regardless of
 *     React Router tree position.
 *
 * Why this is THE authority (per PR-A revision):
 *   - Query keys MUST carry `routeOrgId` so React Query cache is
 *     partitioned per tenant. `useQuery({ queryKey: ['org', 6, ...] })`
 *     and `useQuery({ queryKey: ['org', 1, ...] })` are SEPARATE cache
 *     entries — no manual cross-tenant invalidation needed.
 *   - The Axios interceptor reads `extractRouteOrgId(window.location.
 *     pathname)` synchronously on every request so X-Org-Id is the
 *     URL's truth, not localStorage's stale preference.
 *   - localStorage[ACTIVE_ORG_KEY] is a fallback ONLY when the URL is
 *     not /app/org/:id/* (legacy / platform shell). Inside the org
 *     shell, route always wins.
 */
export function useRouteOrgId(): number | null {
  const location = useLocation()
  return extractRouteOrgId(location.pathname)
}
