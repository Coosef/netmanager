import { useEffect, useRef, useState } from 'react'
import { Navigate, Outlet, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'
import { clearOperationalQueryCache } from '@/utils/operationalCacheScope'
import OrgContextSpinner from '@/components/Layout/OrgContextSpinner'
import OrgContextError from '@/components/Layout/OrgContextError'

/**
 * PR-A2 — URL-authoritative organization context shell with CACHE-SAFE
 * route bridge.
 *
 * The shell wraps every `/app/org/:organizationId/*` route. Its job is
 * three-fold:
 *
 *   1. URL → org context contract (PR-A foundation, retained):
 *      - super-admin's `activeOrgId` is kept in sync with the URL param
 *      - normal user attempting `/app/org/<other>/*` is redirected to
 *        their own `/app/org/<own>/dashboard`
 *      - invalid `:organizationId` (NaN, 0, negative) → redirect home
 *
 *   2. Cache bridge (PR-A2 — operator-mandated cross-org cache safety):
 *      WHENEVER `routeOrgId` changes from the previously-committed value,
 *      execute the transition sequence:
 *        a. cancelQueries on every operational queryKey (in-flight
 *           cancel — stale responses cannot write to the new scope's
 *           cache)
 *        b. removeQueries on every operational queryKey (cache wipe —
 *           the next render starts from an empty operational cache
 *           under the new scope)
 *        c. setLocation(null) — clears activeLocationId since the
 *           previous tenant's location is almost never valid in the
 *           new tenant
 *        d. setOrganization(routeOrgId) — preference hint sync for the
 *           legacy panel + cross-tab safety
 *
 *      AUTH / SESSION / USER / FEATURE-FLAG / PLATFORM cache entries are
 *      preserved per `operationalCacheScope.ts`'s allowlist — without
 *      this carveout, the user would silently lose their permission
 *      map / profile / bootstrap config on every tenant switch.
 *
 *   3. Child render gate (PR-A2):
 *      `<Outlet />` is rendered ONLY in the `ready` state. During
 *      `transitioning` and `validating`, an OrgContextSpinner stands in.
 *      This guarantees that child useQuery observers are not even
 *      mounted while the cache bridge runs — eliminating the residual
 *      "in-flight response writes to fresh cache" race that cancelQueries
 *      cannot fully close on its own (some pre-PR-A2 axios callers may
 *      not honor AbortController; the unmount belt-and-braces removes
 *      the observer entirely).
 *
 * State machine:
 *
 *       (mount, routeOrgId=N)        (URL change, routeOrgId=M, M≠N)
 *              │                              │
 *              ▼                              ▼
 *      ┌──────────────┐                ┌──────────────┐
 *      │ transitioning │ ──────────── │ transitioning │
 *      └──────────────┘                └──────────────┘
 *              │
 *      (cache wipe done)
 *              ▼
 *      ┌──────────────┐
 *      │  validating  │     waits for ctxResolved && ctx.org.id === routeOrgId
 *      └──────────────┘
 *              │
 *      (ctx matches routeOrgId)        (backend mismatch)
 *              ▼                              ▼
 *      ┌──────────────┐                ┌──────────────┐
 *      │    ready     │                │    error     │
 *      └──────────────┘                └──────────────┘
 *              │                              │
 *      <Outlet />                     <OrgContextError onRetry>
 */
type GateState = 'transitioning' | 'validating' | 'ready' | 'error'

export default function OrgRouteShell() {
  const { organizationId } = useParams<{ organizationId: string }>()
  const routeOrgId = organizationId ? Number(organizationId) : NaN

  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.system_role === 'super_admin'
  const userOrgId = user?.org_id ?? null

  const {
    activeOrgId,
    setOrganization,
    setLocation,
    isPlatformSuperAdmin,
    ctxResolved,
    organization,
  } = useSite()
  const queryClient = useQueryClient()

  const lastCommittedOrgRef = useRef<number | null>(null)
  const [gateState, setGateState] = useState<GateState>('transitioning')

  // ── Transition trigger ──────────────────────────────────────────────
  // PR-A2 cache bridge: whenever routeOrgId differs from the previously-
  // committed org, run the operational-cache wipe before letting the
  // child Outlet mount under the new scope.
  useEffect(() => {
    if (!Number.isFinite(routeOrgId) || routeOrgId <= 0) return

    // Non-super-admin scope guard is enforced below at render time —
    // for them, routeOrgId is always === userOrgId (mismatch redirects).
    // We still run the transition on FIRST mount so the very first paint
    // also clears any stale cache from a prior session or login.
    if (lastCommittedOrgRef.current === routeOrgId) {
      // Same org as last commit; no transition needed.
      return
    }

    // ORG CHANGED — full operational cache reset.
    setGateState('transitioning')

    // 1. Scoped cancel + remove. AUTH / PROFILE / PERMISSIONS / FEATURE
    //    FLAGS / PLATFORM queries survive per the allowlist in
    //    operationalCacheScope.ts.
    clearOperationalQueryCache(queryClient)

    // 2. Clear the active location (previous tenant's id is almost
    //    never valid in the new tenant; cross-tab handler in SiteContext
    //    propagates the clear to other tabs).
    setLocation(null)

    // 3. Preference hint sync for super-admin only. Normal users have
    //    a JWT-fixed org_id; the backend ignores X-Org-Id from them.
    if (isPlatformSuperAdmin && activeOrgId !== routeOrgId) {
      setOrganization(routeOrgId)
    }

    // 4. Enter validating — wait for SiteProvider's ctx query to refetch
    //    under the new routeOrgId (queryKey changed, React Query
    //    auto-triggers the fetch) AND confirm the backend returned the
    //    expected org.
    setGateState('validating')
  }, [
    routeOrgId,
    isPlatformSuperAdmin,
    activeOrgId,
    queryClient,
    setLocation,
    setOrganization,
  ])

  // ── Validation gate ─────────────────────────────────────────────────
  // Commit `routeOrgId` as the new lastCommittedOrg ONLY after the
  // backend echoes a matching organization id. This closes the
  // "X-Org-Id sent but backend returned a different tenant" theoretical
  // attack surface AND guards against the very-first-render race where
  // `organization` is still the previous tenant's payload.
  useEffect(() => {
    if (gateState !== 'validating') return
    if (!ctxResolved) return

    if (organization?.id === routeOrgId) {
      lastCommittedOrgRef.current = routeOrgId
      setGateState('ready')
    } else if (organization == null) {
      // ctxResolved is true but organization is null — possible for a
      // super-admin who has cleared the active org (organization is null
      // in SiteContext payload for a "no tenant active" super-admin
      // scope). Inside /app/org/:id, the backend MUST have returned a
      // tenant; otherwise this is a backend bug or a hard 401 race.
      // Treat as mismatch.
      setGateState('error')
    } else {
      setGateState('error')
    }
  }, [gateState, ctxResolved, organization, routeOrgId])

  // ── Render ──────────────────────────────────────────────────────────

  // Invalid URL guard — runs every render. Stale ref check: we MUST
  // return Navigate here NOT inside an effect, otherwise the effect
  // dependency change triggers double-renders.
  if (!Number.isFinite(routeOrgId) || routeOrgId <= 0) {
    return <Navigate to="/" replace />
  }

  // Non-super-admin scope escalation guard (PR-A foundation, retained):
  // A normal user attempting another tenant's URL is redirected to
  // their own home dashboard. The check must run AFTER user object is
  // loaded — pre-hydration returns null (loading) so the guard does not
  // trigger on the very-first paint.
  if (user != null && !isSuperAdmin) {
    if (userOrgId == null) {
      // No org_id at all — bounce home (RootRedirect handles fallback).
      return <Navigate to="/" replace />
    }
    if (routeOrgId !== userOrgId) {
      return <Navigate to={`/app/org/${userOrgId}/dashboard`} replace />
    }
  }

  // Pre-user-hydration: show spinner instead of blank.
  if (user == null) {
    return <OrgContextSpinner phase="validating" targetOrgId={routeOrgId} />
  }

  // Gate state render:
  if (gateState === 'transitioning' || gateState === 'validating') {
    return <OrgContextSpinner phase={gateState} targetOrgId={routeOrgId} />
  }

  if (gateState === 'error') {
    return (
      <OrgContextError
        routeOrgId={routeOrgId}
        ctxOrgId={organization?.id ?? null}
        onRetry={() => {
          // Re-trigger the transition. Reset lastCommittedOrgRef so the
          // useEffect predicate re-fires.
          lastCommittedOrgRef.current = null
          setGateState('transitioning')
          clearOperationalQueryCache(queryClient)
          setLocation(null)
          if (isPlatformSuperAdmin) {
            setOrganization(routeOrgId)
          }
          setGateState('validating')
        }}
      />
    )
  }

  // ready — child pages mount with a clean operational cache under the
  // committed org context.
  return <Outlet />
}
