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
import { useHasHydrated } from '@/hooks/useHasHydrated'
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

/**
 * SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) — predicate that gates the
 * stale `localStorage[ACTIVE_LOCATION_KEY]` cleanup for org-wide users.
 *
 * Distinct from `shouldReconcileLocation` because the latter's
 * load-bearing `is_org_wide` short-circuit (the guard against the
 * infinite refetch loop) leaves a real gap: a super_admin / org_admin
 * whose stored active location id points at a row that has since been
 * soft-deleted (or revoked, or just never re-emitted by the backend)
 * will carry that phantom id forever. AntD's <Select> in
 * LocationSelector branch (7) renders an unselected `value` and the
 * X-Location-Id header on every downstream request scopes to a row
 * that no longer exists.
 *
 * The predicate returns true ONLY when ctx is resolved, the stored id
 * is non-null, AND that id is not present in the backend-authoritative
 * `ctx.locations` list. Callers fall back to `ctx.active_location_id`
 * (which itself may be null for the implicit "all locations" org-wide
 * scope).
 *
 * Pure for unit testing — the SiteContext stale cleanup `useEffect`
 * delegates the decision to this predicate so the logic is exercised
 * without rendering React.
 */
export function isActiveLocationStale(
  ctx: CurrentContext | null | undefined,
  activeLocationId: number | null,
): boolean {
  if (!ctx) return false
  if (activeLocationId == null) return false
  return !ctx.locations.some((l) => l.id === activeLocationId)
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
  /** PR #96 — header / agent-modal role-aware UX. True when the active
   * user is a platform super-admin. Distinct from `isOrgWide` because
   * an org_admin is org-wide but is NEVER a tenant chooser. */
  isSuperAdmin: boolean
  /** PR #96 — `null` for a super-admin who has not yet picked a tenant
   * to operate inside. For every other role this is the user's home
   * organization stamped by the auth token, and is always populated.
   * LocationSelector + the agent-create modal use the `(isSuperAdmin
   * && organization === null)` pair to surface the "Önce firma seçin
   * / Select a tenant first" guard. */
  organization: { id: number; name: string; slug: string } | null
  /** T10 — org plan'ındaki feature durumları {key: bool}. Eksik anahtar
   * = açık (opt-out). Nav filtresi bunu okur. */
  features: Record<string, boolean>
  sitesLoading: boolean
  /** LOGIN-DIRECT-NAVIGATE-FIX (2026-06-10) — `/context/current` fetch
   * başarısız olduğunda `ctx` undefined kalıyor + LocationGate defansif
   * `?? true` ile children render ediyordu. Bug: features:{} ile bazı
   * widget'lar gizleniyor, kullanıcı blank algılıyor. Error expose + refetch
   * fonksiyonu LocationGate'in görünür error/retry fallback'i render
   * etmesini sağlar (blank screen → görünür "Bağlantı sorunu" + Yenile). */
  sitesError: boolean
  /** Birleşik failure flag — `sitesError || (!sitesLoading && !ctx)`.
   * Tek başına `sitesError` kontrolü yetersiz çünkü query idle/settled
   * olmasına rağmen ctx undefined kalabiliyor (örn. enabled false'tan
   * true'ya geçiş anı veya queryClient.clear() sonrası). LocationGate
   * bu flag ile her iki durumu da görünür fallback'e yönlendirir. */
  hasContextFailure: boolean
  refetchSite: () => void
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
  isSuperAdmin: false,
  organization: null,
  features: {},
  sitesLoading: false,
  sitesError: false,
  hasContextFailure: false,
  refetchSite: () => {},
  activeSite: null,
  setSite: () => {},
  sites: [],
})

export function SiteProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthStore()
  // DASHBOARD-INIT-ROUTER-FIX (2026-06-10) — Zustand persist hidrasyon
  // tamamlanmadan `token` selector eski/null değer dönebiliyor. Hidrasyon
  // pencerisinde useQuery fire ederse interceptor `getState().token` null
  // okuyor → 401. Sonraki refetch staleTime: 60sn'ye takılı kalıyor, ctx
  // undefined → LocationGate/Dashboard render hattı boş. Hydrated guard
  // ile query hidrasyon tamamlanana kadar bekler.
  const hydrated = useHasHydrated()
  const queryClient = useQueryClient()

  const [activeLocationId, setActiveLocationIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(ACTIVE_LOCATION_KEY)
    return v ? Number(v) : null
  })

  // Faz 8 Phase E — the location list + scope come from /context/current,
  // which derives them from user_locations. The query key carries the
  // active location so a switch refetches the context under the new scope.
  //
  // DASHBOARD-INIT-ROUTER-FIX (2026-06-10):
  //   · `enabled` artık `hydrated` ALSO gerektiriyor — token race penceresi
  //     kapatıldı. Hidrasyon tamam + token mevcut → query çalışır.
  //   · `retry: 1` + `retryDelay: 500` — transient 401 (token interceptor
  //     race veya backend network jitter) recover edilir. Stuck `ctx`
  //     undefined senaryosu kırılır.
  //
  // ANTI-FLICKER (2026-06-18):
  //   · `placeholderData: keepPreviousData` — refetch sırasında önceki
  //     başarılı response'u koru, header'da kısa süreli "Atanmış lokasyon
  //     yok" flash'ı engelle. React Query 5 yeni adı; v4'teki
  //     `keepPreviousData: true` ile aynı semantik.
  //   · `isFetching` ek olarak export edilir; LocationSelector
  //     `locations.length === 0` durumunda refetch tetiklendiyse loading
  //     gösterir, "no_assigned" tag'i flicker olarak yanmaz.
  const { data: ctx, isLoading: queryLoading, isError, refetch } = useQuery({
    queryKey: ['context', 'current', activeLocationId],
    queryFn: () => contextApi.current(),
    staleTime: 60_000,
    enabled: !!token && hydrated,
    retry: 1,
    retryDelay: 500,
    // PR #101 — drop `placeholderData: (prev) => prev`. React Query 5
    // with a fail-then-recover sequence (initial 401 from a token-
    // race retry: 1) kept `data` pinned to the `undefined` returned by
    // `prev` from the very first failed attempt, ignoring the
    // subsequent 200 OK payload — so SiteContext rendered defaults
    // (`locations: []`, `is_super_admin: false`) even though the
    // network log showed multiple successful responses. Removing the
    // placeholder lets `data` update normally; the org-wide
    // reconciliation effect below already has its own carve-out
    // against the infinite refetch loop.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // PR #101 DIAGNOSTIC — temporary console log so an operator can
  // confirm the resolved context arrives on the wire AND lands in
  // SiteContext state. Remove once the flicker root cause is
  // permanently pinned by a regression test.
  // SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) — when token is present
  // but Zustand persist has not yet finished rehydrating, the query is
  // `enabled: false` and React Query 5 reports `isLoading: false`
  // (`isPending && isFetching`, and a disabled query is not fetching).
  // Down-stream consumers that branch on `sitesLoading` previously
  // skipped their "still resolving" branch in this window and fell
  // through to "no_assigned_tag" (LocationSelector branch 5) or
  // `installBlocked` (NocAgents create modal) even though we had not
  // yet decided. Treating the hydration window as a loading window
  // keeps the priority chain in LocationSelector honest and prevents
  // the agent-create modal from rendering an alarming Alert before the
  // backend has even been asked.
  //
  // Hidrasyon penceresinde + sorgu çalışırken sitesLoading=true. Token
  // hiç yoksa (kullanıcı login değil) loading false — bağlam beklemiyoruz.
  const sitesLoading: boolean = !!token && (!hydrated || queryLoading)
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[SiteContext]', {
      ctx_present: !!ctx,
      is_super_admin: ctx?.is_super_admin,
      is_org_wide: ctx?.is_org_wide,
      organization_name: ctx?.organization?.name,
      locations_length: ctx?.locations?.length,
      sitesLoading,
      isError,
      activeLocationId,
      tokenPresent: !!token,
      hydrated,
    })
  }, [ctx, sitesLoading, isError, activeLocationId, token, hydrated])
  // LOGIN-DIRECT-NAVIGATE-FIX (2026-06-10) — error state'i sadece "fetch
  // gerçekten fail oldu + ctx hala yok" durumunda true. retry sonrası 200
  // gelirse `isError: false`. Stale cache sırasında error false kalır.
  const sitesError: boolean = isError && !ctx
  // Birleşik failure flag — sitesError OR (idle/settled + ctx undefined).
  // Tek başına sitesError yeterli değil çünkü query enabled false'tan
  // true'ya geçiş anı veya queryClient.clear() sonrası `isLoading: false`,
  // `isError: false`, `ctx: undefined` durumu kısa süreli görülebilir.
  // LocationGate her iki durumu da görünür fallback'e yönlendirir.
  const hasContextFailure: boolean = sitesError || (!sitesLoading && !ctx && !!token && hydrated)
  const refetchSite = () => { refetch() }
  const locations: AccessibleLocation[] = ctx?.locations ?? []
  const allowedLocationIds: number[] = ctx?.allowed_location_ids ?? []
  const hasLocationAccess: boolean = ctx?.has_location_access ?? true
  const isOrgWide: boolean = ctx?.is_org_wide ?? false
  // PR #96 — surface the role identity + tenant context the backend
  // already returns in CurrentContext so the header and the agent-
  // create modal can branch on it. Pre-hydration / pre-fetch both
  // resolve to `false` / `null` — the safe-by-default value that
  // matches the "still resolving" branch in LocationSelector.
  const isSuperAdmin: boolean = ctx?.is_super_admin ?? false
  const organization: { id: number; name: string; slug: string } | null =
    ctx?.organization ?? null
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
      // Faz 8 Phase E + ANTI-FLICKER (2026-06-18) — switching location
      // invalidates every cached query so each consumer refetches under
      // the new scope. The earlier `queryClient.clear()` was too
      // aggressive: it dropped the in-flight `/context/current` result
      // too, so the header rendered `locations: []` for a brief
      // window between the cache wipe and the next response, which
      // surfaced as the "Atanmış lokasyon yok" / "No assigned
      // location" flash that operators reported. `invalidateQueries`
      // marks every cache entry stale + triggers a background refetch
      // but keeps the previous data on screen until the new payload
      // arrives — RLS still isolates per-request because every refetch
      // carries the X-Location-Id header set above.
      queryClient.invalidateQueries()
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
    // ANTI-FLICKER (2026-06-18) — see setLocation comment above.
    // `invalidate` keeps the rendered list in place until the new
    // payload arrives; `clear` was wiping the in-flight ctx response
    // and producing the "Atanmış lokasyon yok" flash.
    queryClient.invalidateQueries()
  }, [ctx, activeLocationId, queryClient])

  // SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) — stale activeLocationId
  // cleanup that covers the gap left by `shouldReconcileLocation`.
  //
  // The regular reconciliation effect above intentionally short-circuits
  // for org-wide users (`is_org_wide` === true → never reconcile, see
  // `shouldReconcileLocation` for the load-bearing rationale). That
  // preserves the infinite-loop guard, but it also means a super_admin
  // / org_admin whose `localStorage[ACTIVE_LOCATION_KEY]` points at a
  // location that has since been soft-deleted (e.g. operator deleted
  // the location while another tab was open) carries a phantom id
  // forever. The AntD <Select> in LocationSelector branch (7) renders
  // an unselected `value` and every list-query that derives its
  // X-Location-Id header from this id scopes to a deleted row.
  //
  // The cleanup is narrowly-scoped: it only runs when ctx is loaded,
  // a non-null activeLocationId is set, AND that id is not present in
  // the backend-authoritative `ctx.locations`. It falls back to the
  // backend-resolved default (`ctx.active_location_id`, which may itself
  // be `null` for the "all locations" implicit org-wide scope). No
  // `queryClient.invalidateQueries()` here — we are repairing a UI-only
  // stale-state mismatch, not changing the request scope.
  useEffect(() => {
    if (!isActiveLocationStale(ctx, activeLocationId)) return
    const fallback = ctx!.active_location_id
    setActiveLocationIdState(fallback)
    if (fallback != null) {
      localStorage.setItem(ACTIVE_LOCATION_KEY, String(fallback))
    } else {
      localStorage.removeItem(ACTIVE_LOCATION_KEY)
    }
  }, [ctx, activeLocationId])

  // Faz 8 Phase E — cross-tab safety. If another tab switches location,
  // adopt it here and drop this tab's cache so two tabs can never render
  // each other's location data.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACTIVE_LOCATION_KEY) return
      const next = e.newValue ? Number(e.newValue) : null
      setActiveLocationIdState((prev) => (prev === next ? prev : next))
      // ANTI-FLICKER (2026-06-18) — invalidate keeps cross-tab consumers
      // rendering the previous data until the refetch under the new
      // X-Location-Id resolves. Previous behaviour (`clear`) caused a
      // brief blank window between tabs.
      queryClient.invalidateQueries()
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
        isSuperAdmin,
        organization,
        features,
        sitesLoading,
        sitesError,
        hasContextFailure,
        refetchSite,
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
