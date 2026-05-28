import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  contextApi,
  type AccessibleLocation,
  type CurrentContext,
} from '@/api/context'
import { useAuthStore } from '@/store/auth'
import { ACTIVE_LOCATION_KEY } from '@/api/client'

/**
 * Decide whether the locally-stored `activeLocationId` needs to be
 * reconciled against the backend-authoritative context.
 *
 * Reconciliation runs when a location-scoped user has a stale or
 * revoked location id sitting in localStorage — we drop it back to
 * the backend's resolved default so the page never operates on
 * unreachable data.
 *
 * Pure for unit testing — the SiteContext reconciliation `useEffect`
 * is a thin wrapper around this predicate. Returning `false` here is
 * the load-bearing guard against the org-wide infinite refetch loop:
 *
 *   * Org-wide roles (super_admin, org_admin) get
 *     `allowed_location_ids: []` from the backend — semantically
 *     "no whitelist; every location is allowed". The membership check
 *     `[].includes(x)` is always false, so without the `is_org_wide`
 *     short-circuit the reconciliation branch fires every time, calls
 *     `queryClient.clear()`, evicts the ctx cache, useQuery refetches
 *     the same ctx, and the effect re-runs forever — surfacing as a
 *     stuck "Lokasyon bağlamı çözümleniyor…" spinner, location switch
 *     not taking, topology never loading, and a WS reconnect storm.
 *
 *   * For location-scoped users `allowed_location_ids` IS the
 *     explicit whitelist and the membership check is exactly the
 *     intended behaviour.
 */
export function shouldReconcileLocation(
  ctx: CurrentContext | null | undefined,
  activeLocationId: number | null,
): boolean {
  if (!ctx) return false
  // Org-wide → no whitelist exists; scope is enforced server-side by
  // RLS, not a per-user list. NEVER reconcile.
  if (ctx.is_org_wide) return false
  if (activeLocationId == null) return false
  return !ctx.allowed_location_ids.includes(activeLocationId)
}

interface SiteCtx {
  /** The active location id; null = backend-resolved default / all. */
  activeLocationId: number | null
  setLocation: (id: number | null) => void
  /** Locations the user may access — from user_locations (source of truth). */
  locations: AccessibleLocation[]
  /** The ids the backend will accept in X-Location-Id for this user. */
  allowedLocationIds: number[]
  /** False when a location-scoped user has no usable location. */
  hasLocationAccess: boolean
  /** super-admin / org-admin — operates across the whole organization. */
  isOrgWide: boolean
  /** T10 — org plan'ındaki feature durumları {key: bool}. Eksik anahtar
   * = açık (opt-out). Nav filtresi bunu okur. */
  features: Record<string, boolean>
  sitesLoading: boolean
  /** Backward-compat: the active location's NAME, and the name list. */
  activeSite: string | null
  setSite: (site: string | null) => void
  sites: string[]
}

const SiteContext = createContext<SiteCtx>({
  activeLocationId: null,
  setLocation: () => {},
  locations: [],
  allowedLocationIds: [],
  hasLocationAccess: true,
  isOrgWide: false,
  features: {},
  sitesLoading: false,
  activeSite: null,
  setSite: () => {},
  sites: [],
})

export function SiteProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthStore()
  const queryClient = useQueryClient()

  const [activeLocationId, setActiveLocationIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(ACTIVE_LOCATION_KEY)
    return v ? Number(v) : null
  })

  // Faz 8 Phase E — the location list + scope come from /context/current,
  // which derives them from user_locations. The query key carries the
  // active location so a switch refetches the context under the new scope.
  const { data: ctx, isLoading: sitesLoading } = useQuery({
    queryKey: ['context', 'current', activeLocationId],
    queryFn: () => contextApi.current(),
    staleTime: 60_000,
    enabled: !!token,
  })
  const locations: AccessibleLocation[] = ctx?.locations ?? []
  const allowedLocationIds: number[] = ctx?.allowed_location_ids ?? []
  const hasLocationAccess: boolean = ctx?.has_location_access ?? true
  const isOrgWide: boolean = ctx?.is_org_wide ?? false
  const features: Record<string, boolean> = ctx?.features ?? {}
  const sites: string[] = locations.map((l) => l.name)

  const setLocation = useCallback(
    (id: number | null) => {
      setActiveLocationIdState(id)
      if (id != null) {
        localStorage.setItem(ACTIVE_LOCATION_KEY, String(id))
      } else {
        localStorage.removeItem(ACTIVE_LOCATION_KEY)
      }
      // Faz 8 Phase E — clear the ENTIRE query cache on a location switch.
      // invalidate() alone keeps stale rows that can flash as the new
      // location's data; clear() guarantees no previous-location data
      // survives the switch, even momentarily.
      queryClient.clear()
    },
    [queryClient],
  )

  // Backward-compat: components that still switch by location NAME.
  const setSite = useCallback(
    (site: string | null) => {
      if (site == null) {
        setLocation(null)
        return
      }
      const loc = locations.find((l) => l.name === site)
      setLocation(loc ? loc.id : null)
    },
    [locations, setLocation],
  )

  const activeSite =
    locations.find((l) => l.id === activeLocationId)?.name ?? null

  // Faz 8 Phase E — reconcile a stale/revoked active location against
  // the backend's authoritative allowed set. The predicate is pulled
  // out as `shouldReconcileLocation` above so the guard logic is
  // unit-testable (see SiteContext.test.ts) and the org-wide
  // carveout — the single load-bearing line preventing the infinite
  // spinner/refetch loop — is impossible to elide by accident.
  useEffect(() => {
    if (!shouldReconcileLocation(ctx, activeLocationId)) return
    const fallback = ctx!.active_location_id
    setActiveLocationIdState(fallback)
    if (fallback != null) {
      localStorage.setItem(ACTIVE_LOCATION_KEY, String(fallback))
    } else {
      localStorage.removeItem(ACTIVE_LOCATION_KEY)
    }
    queryClient.clear()
  }, [ctx, activeLocationId, queryClient])

  // Faz 8 Phase E — cross-tab safety. If another tab switches location,
  // adopt it here and drop this tab's cache so two tabs can never render
  // each other's location data.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACTIVE_LOCATION_KEY) return
      const next = e.newValue ? Number(e.newValue) : null
      setActiveLocationIdState((prev) => (prev === next ? prev : next))
      queryClient.clear()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [queryClient])

  return (
    <SiteContext.Provider
      value={{
        activeLocationId,
        setLocation,
        locations,
        allowedLocationIds,
        hasLocationAccess,
        isOrgWide,
        features,
        sitesLoading,
        activeSite,
        setSite,
        sites,
      }}
    >
      {children}
    </SiteContext.Provider>
  )
}

export const useSite = () => useContext(SiteContext)
