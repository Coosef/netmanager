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
import { ACTIVE_LOCATION_KEY, ACTIVE_ORG_KEY } from '@/api/client'

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
  /** PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — the active organization
   * id for super-admins. `null` means "no override" → backend uses the
   * super-admin RLS bypass (sees every tenant). When non-null, the
   * Axios interceptor attaches it as `X-Org-Id` and the backend drops
   * the bypass + scopes into that tenant — the unblocking primitive
   * for the "Mövempic / org=6 from a super-admin's session" use case
   * the operator hit on the PR #105 production smoke. */
  activeOrgId: number | null
  /** Switch the super-admin's active organization scope. Side-effects:
   *   1. activeLocationId is cleared (the old tenant's location id is
   *      almost never a valid pick for the new tenant)
   *   2. localStorage gets the new id (or removed when `null`)
   *   3. queryClient.invalidateQueries() — every operational dataset
   *      refetches under the new X-Org-Id; we deliberately do NOT
   *      `queryClient.clear()` so the PR #103 anti-flicker contract
   *      survives. */
  setOrganization: (orgId: number | null) => void
  /** The active location id; null = backend-resolved default / all. */
  activeLocationId: number | null
  setLocation: (id: number | null) => void
  /** Locations the user may access — from user_locations (source of truth). */
  locations: AccessibleLocation[]
  /** The ids the backend will accept in X-Location-Id for this user. */
  allowedLocationIds: number[]
  /** False when a location-scoped user has no usable location. */
  hasLocationAccess: boolean
  /** True when `/context/current` has returned a non-undefined payload.
   *
   * SITE-CONTEXT-HYDRATION-GUARD v2 (2026-06-19) — a stricter
   * companion to `sitesLoading`. The former goes false the instant
   * React Query 5 reports `isLoading: false` AND token is non-null,
   * which leaves a brief in-render window where ctx is still
   * `undefined` (transient token blip from a Zustand re-subscription
   * race, query-cache eviction during a location switch, or an in-
   * flight refetch with no `placeholderData`). Down-stream components
   * that branch on "ctx is empty" need a different signal: was the
   * backend ever asked, and did it answer? `ctxResolved` is exactly
   * that — `!!ctx`. LocationSelector branch (1) AND the NocAgents
   * create-modal blocked-state both AND-gate on it so a transient
   * undefined never commits to a final empty state.
   */
  ctxResolved: boolean
  /** super-admin / org-admin — operates across the whole organization. */
  isOrgWide: boolean
  /** PR #96 — header / agent-modal role-aware UX. True when the active
   * user is a platform super-admin. Distinct from `isOrgWide` because
   * an org_admin is org-wide but is NEVER a tenant chooser. */
  isSuperAdmin: boolean
  /** ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — the user's platform role
   * identity, derived from `ctx.system_role === 'super_admin'`.
   *
   * Distinct from `isSuperAdmin` (which mirrors the backend's
   * `ctx.is_super_admin` — the CURRENTLY-ACTIVE RLS bypass flag).
   * When a super-admin scopes into another tenant via X-Org-Id, the
   * backend drops the bypass (`sup = False` at
   * `request_context.py:157`), so `ctx.is_super_admin` flips to false
   * EVEN THOUGH the user's role is still `super_admin`. Every
   * consumer that asks "is this user a platform super-admin?"
   * (widget visibility, role-gated cleanup, tenant-required gates)
   * must read `isPlatformSuperAdmin`. Consumers that need the
   * scope-active flag (rare) read `isSuperAdmin`. */
  isPlatformSuperAdmin: boolean
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
  activeOrgId: null,
  setOrganization: () => {},
  activeLocationId: null,
  setLocation: () => {},
  locations: [],
  allowedLocationIds: [],
  hasLocationAccess: true,
  ctxResolved: false,
  isOrgWide: false,
  isSuperAdmin: false,
  isPlatformSuperAdmin: false,
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

  // PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — the active organization
  // id picked by a super-admin from the Organization Switcher. Persists
  // across reloads via localStorage; the Axios interceptor attaches it
  // as `X-Org-Id` on every request so the backend's
  // `resolve_location_context` scopes into that tenant.
  //
  // Non-super-admin sessions defensively prune this key on hydration —
  // a previously-super-admin user that was demoted (or a user who
  // somehow inherited a teammate's localStorage in a shared browser
  // profile) cannot keep a stale org id.
  const [activeOrgId, setActiveOrgIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(ACTIVE_ORG_KEY)
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
    // PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — queryKey carries
    // `activeOrgId` so a super-admin's org switch refetches the context
    // under the new `X-Org-Id` header. The cache stays separated per
    // tenant scope; the queryClient.invalidateQueries() in
    // setOrganization triggers the actual refetch.
    queryKey: ['context', 'current', activeLocationId, activeOrgId],
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
  // SITE-CONTEXT-HYDRATION-GUARD v2 (2026-06-19) — see SiteCtx interface
  // for the full rationale. Down-stream consumers AND-gate their "final
  // empty" branches on this so a transient ctx-undefined (token blip,
  // refetch with no placeholder) never falls through to a warning.
  const ctxResolved: boolean = !!ctx
  const isOrgWide: boolean = ctx?.is_org_wide ?? false
  // PR #96 — surface the role identity + tenant context the backend
  // already returns in CurrentContext so the header and the agent-
  // create modal can branch on it. Pre-hydration / pre-fetch both
  // resolve to `false` / `null` — the safe-by-default value that
  // matches the "still resolving" branch in LocationSelector.
  const isSuperAdmin: boolean = ctx?.is_super_admin ?? false
  // ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — role identity, distinct
  // from the bypass-state flag above. See the SiteCtx interface for
  // why every existing UI consumer of `isSuperAdmin` was switched to
  // `isPlatformSuperAdmin` in the same commit: a scoped super-admin
  // (X-Org-Id active) flips `is_super_admin` to false at the backend,
  // and the pre-fix UI mistook that for "demoted to non-super-admin"
  // — triggering the cleanup effect that wiped `activeOrgId` and
  // looped the operator back to Platform Mode on every location pick.
  const isPlatformSuperAdmin: boolean = ctx?.system_role === 'super_admin'
  const organization: { id: number; name: string; slug: string } | null =
    ctx?.organization ?? null
  const features: Record<string, boolean> = ctx?.features ?? {}
  const sites: string[] = locations.map((l) => l.name)

  // PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — super-admin's
  // Organization Switcher entry-point. Three coordinated side-effects:
  //   1. Set the new org id in state + localStorage (or clear it).
  //   2. CLEAR `activeLocationId` — the previous tenant's location id
  //      almost never maps to a valid pick in the new tenant; carrying
  //      it forward would produce the same cross-tenant 400 PR #102's
  //      guard rejects. (`scopedLocations` in DeviceForm + the
  //      LocationSelector dropdown would have hidden it anyway, but we
  //      prefer the explicit clear so the X-Location-Id header is
  //      omitted on the first request under the new scope.)
  //   3. `queryClient.invalidateQueries()` — mirrors `setLocation`'s
  //      PR #103 anti-flicker contract: every cached query refetches
  //      under the new `X-Org-Id` header, but the previously-rendered
  //      data stays on screen until the new payload arrives. We never
  //      `queryClient.clear()` here — that would drop the in-flight
  //      ctx response and reintroduce the "Atanmış lokasyon yok" flash.
  const setOrganization = useCallback(
    (orgId: number | null) => {
      setActiveOrgIdState(orgId)
      if (orgId != null) {
        localStorage.setItem(ACTIVE_ORG_KEY, String(orgId))
      } else {
        localStorage.removeItem(ACTIVE_ORG_KEY)
      }
      // Clear the active location too — see rule (2) above.
      setActiveLocationIdState(null)
      localStorage.removeItem(ACTIVE_LOCATION_KEY)
      queryClient.invalidateQueries()
    },
    [queryClient],
  )

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

  // PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — cross-tab safety for the
  // active organization id (mirror of the activeLocationId handler
  // above). Two tabs cannot end up scoped into different tenants for
  // the same session.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACTIVE_ORG_KEY) return
      const next = e.newValue ? Number(e.newValue) : null
      setActiveOrgIdState((prev) => (prev === next ? prev : next))
      queryClient.invalidateQueries()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [queryClient])

  // PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — non-super-admin cleanup.
  // The `nm-active-org-id` key only makes sense for super-admins (the
  // backend `resolve_location_context` ignores X-Org-Id for normal
  // users anyway). If the session resolves as non-super-admin BUT the
  // localStorage still holds an org id, clear it on hydration so:
  //   1. The interceptor stops sending the dead header.
  //   2. A user who was previously a super-admin and is now demoted
  //      does not retain a stale scope.
  //   3. Shared browser profiles (kiosk / family) cannot inherit a
  //      previous super-admin's org pick.
  //
  // ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — the gate now reads
  // `isPlatformSuperAdmin` (role identity), NOT `isSuperAdmin` (the
  // currently-active RLS bypass flag). The pre-fix gate fired the
  // moment a scoped super-admin's /context/current response carried
  // `is_super_admin: false` — wiping `activeOrgId`, dropping the
  // X-Org-Id header on the next request, and looping the operator
  // back to Platform Mode every time they touched the LocationSelector.
  // Role identity stays stable across scope flips, so the cleanup
  // only fires for users who are not super-admins at all.
  useEffect(() => {
    if (!ctxResolved) return
    if (isPlatformSuperAdmin) return
    if (activeOrgId == null) return
    setActiveOrgIdState(null)
    localStorage.removeItem(ACTIVE_ORG_KEY)
  }, [ctxResolved, isPlatformSuperAdmin, activeOrgId])

  return (
    <SiteContext.Provider
      value={{
        activeOrgId,
        setOrganization,
        activeLocationId,
        setLocation,
        locations,
        allowedLocationIds,
        hasLocationAccess,
        ctxResolved,
        isOrgWide,
        isSuperAdmin,
        isPlatformSuperAdmin,
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
