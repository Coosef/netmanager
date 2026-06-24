/**
 * SiteContext — DASHBOARD-INIT-ROUTER-FIX sözleşmesi (2026-06-10).
 *
 * Browser-side bulgular:
 *   · Login sonrası URL /dashboard AMA Router internal state'te kalan
 *     race + SiteContext mid-fetch + token interceptor race üretiyor.
 *   · /api/v1/context/current ilk istek 401 dönebiliyor (token persist
 *     hidrasyon race).
 *   · stuck `ctx: undefined` LocationGate/Dashboard render hattını
 *     boş bırakıyor.
 *
 * Bu testler kaynak düzeyinde:
 *   · `useHasHydrated` import edilir + kullanılır
 *   · useQuery `enabled` koşulu `!!token && hydrated` (race guard)
 *   · `retry: 1` + `retryDelay: 500` (transient 401 recovery)
 *   · queryKey + activeLocationId pattern korundu (regresyon yok)
 *
 * Mevcut codebase pattern: kaynak string-match smoke (jsdom yok).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../SiteContext.tsx'),
  'utf-8',
)


describe('SiteContext — hidrasyon guard + retry sözleşmesi', () => {
  it('useHasHydrated import edilir', () => {
    expect(SRC).toContain("from '@/hooks/useHasHydrated'")
    expect(SRC).toMatch(/import.*useHasHydrated/)
  })

  it('hydrated hook çağrısı VAR', () => {
    expect(SRC).toMatch(/const hydrated = useHasHydrated\(\)/)
  })

  it('useQuery enabled: !!token (P0.2.2 token-only gate)', () => {
    // P0.2.2 CONTEXT QUERY TOKEN-ONLY GATE (2026-06-24) — the
    // `hydrated` clause was removed from this query's enable
    // condition after a live audit proved the per-instance
    // `useHasHydrated()` snapshot inside SiteProvider could stay
    // pinned at false even when the user was already authenticated
    // (sibling unconditional queries fired; only this gated query
    // never reached the network). Token is the right gate: persist
    // restores `token` ONLY after rehydration completes, so a non-
    // null token IS the proof that the store is hydrated. See the
    // SiteContext.tsx comment block above the useQuery for the full
    // rationale.
    expect(SRC).toMatch(/enabled:\s*!!token\s*,/)
    // Defense-in-depth: the pre-P0.2.2 `&& hydrated` clause MUST NOT
    // come back to this gate. (`hydrated` is still legitimately used
    // BELOW for `sitesLoading` / `hasContextFailure` / diagnostic
    // log — those uses are NOT the API-fetch trigger.)
    expect(SRC).not.toMatch(/enabled:\s*!!token\s*&&\s*hydrated/)
  })

  it('retry: 1 + retryDelay: 500 (transient 401 recovery)', () => {
    expect(SRC).toMatch(/retry:\s*1/)
    expect(SRC).toMatch(/retryDelay:\s*500/)
  })

  it('queryKey sessionEpoch + routeOrgId + activeLocationId taşıyor (P0.2.1 SESSION EPOCH REFETCH)', () => {
    // PR-A REVISED (2026-06-22) — queryKey carries `routeOrgId`
    // (URL-authoritative) and `activeLocationId` for per-tenant +
    // per-location cache partitioning. The pre-revision shape
    // `[..., activeLocationId, activeOrgId]` is gone.
    //
    // P0.2.1 SITECONTEXT SESSION EPOCH REFETCH (2026-06-24) — `sessionEpoch`
    // is now inserted between `'current'` and `routeOrgId` so the
    // queryKey shape changes per login session. Required because the
    // SiteProvider observer persists across logout/login (mounted above
    // ProtectedRoute) and React Query 5 will not re-trigger queryFn on
    // `enabled` false→true when the queryKey is unchanged. See the
    // SiteContext.tsx comment block above the useQuery call for the
    // full rationale.
    expect(SRC).toMatch(
      /queryKey:\s*\['context',\s*'current',\s*sessionEpoch,\s*routeOrgId,\s*activeLocationId\]/,
    )
  })

  it('queryFn contextApi.current çağrısı korundu', () => {
    expect(SRC).toMatch(/queryFn:\s*\(\)\s*=>\s*contextApi\.current\(\)/)
  })

  it('staleTime: 60_000 korundu (refetch politikası değişmedi)', () => {
    expect(SRC).toMatch(/staleTime:\s*60_000/)
  })
})


describe('SiteContext — shouldReconcileLocation regresyon (Faz 8 davranışı korundu)', () => {
  it('shouldReconcileLocation function imzası korundu', () => {
    expect(SRC).toMatch(/export function shouldReconcileLocation/)
    expect(SRC).toContain('is_org_wide')
    expect(SRC).toContain('allowed_location_ids')
  })
})


// ─── SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) ──────────────────────────
//
// LocationSelector branch (5) AND NocAgents create modal both compute
// their "blocked" state from `locations.length === 0 + isSuperAdmin =
// false`. During the hydration window (token present + Zustand persist
// not yet finished) `ctx` is undefined → both flags carry their safe
// defaults → branches fire → operator reads it as a hard refusal.
//
// Fix: redefine `sitesLoading` so the priority-chain "still resolving"
// branch fires throughout the hydration window in addition to the
// React Query loading state.
describe('SiteContext — sitesLoading hidrasyon penceresini de kapsar', () => {
  it('useQuery isLoading destructure adı `queryLoading` (intermediate var)', () => {
    expect(SRC).toMatch(/isLoading:\s*queryLoading/)
    // Eski doğrudan `isLoading: sitesLoading` regresyon guard'ı.
    expect(SRC).not.toMatch(/isLoading:\s*sitesLoading\b/)
  })

  it('sitesLoading semantik: !!token && (!hydrated || queryLoading)', () => {
    expect(SRC).toMatch(
      /const sitesLoading:\s*boolean\s*=\s*!!token\s*&&\s*\(!hydrated\s*\|\|\s*queryLoading\)/,
    )
  })

  it('SITE-CONTEXT-HYDRATION-GUARD imzası dosyada yorum olarak var', () => {
    expect(SRC).toContain('SITE-CONTEXT-HYDRATION-GUARD')
  })

  it('LocationSelector + NocAgents için sitesLoading hala provider değerinde export ediliyor', () => {
    // Provider value içinde sitesLoading hala consumer'a verilmeli;
    // semantik genişledi, alan adı aynı kaldı.
    expect(SRC).toMatch(/sitesLoading,/)
  })
})


// ─── Stale activeLocationId cleanup (covers org-wide gap) ───────────────


describe('SiteContext — isActiveLocationStale predicate + cleanup useEffect', () => {
  it('isActiveLocationStale export edilir', () => {
    expect(SRC).toMatch(/export function isActiveLocationStale/)
  })

  it('cleanup useEffect predicate üzerinden delege eder', () => {
    expect(SRC).toMatch(/if \(!isActiveLocationStale\(ctx, activeLocationId\)\) return/)
  })

  it('cleanup queryClient.invalidateQueries\\(\\) çağırmaz (sadece UI repair)', () => {
    // Stale id cleanup, scope değiştirmek için DEĞIL — sadece UI'da
    // phantom id'yi siler. invalidateQueries() çağrısı eklerse
    // org-wide refetch döngüsü riskini geri getirir.
    // Bu testin amacı: yeni cleanup bloğunda invalidate yok.
    const cleanupBlock = SRC.match(
      /if \(!isActiveLocationStale\(ctx, activeLocationId\)\) return[\s\S]+?\}, \[ctx, activeLocationId\]\)/,
    )
    expect(cleanupBlock).not.toBeNull()
    expect(cleanupBlock![0]).not.toMatch(/invalidateQueries/)
  })
})


// ─── SITE-CONTEXT-HYDRATION-GUARD v2 — ctxResolved flag ──────────────────
//
// Operator-confirmed (2026-06-19) console fragment during a location
// switch:
//   [SiteContext] {tokenPresent: false, sitesLoading: false,
//                  ctx_present: false, hydrated: true, ...}
//
// `sitesLoading` alone goes false the instant the query is `enabled:
// false` (token transient null) → branch 5 of LocationSelector +
// noAssignedLocations of NocAgents both fire for one render cycle.
// `ctxResolved: !!ctx` is the stricter "did the backend answer?" flag
// that down-stream components AND-gate on.
describe('SiteContext — v2 ctxResolved flag', () => {
  it('ctxResolved boolean field SiteCtx interface\'ine eklenmiş', () => {
    expect(SRC).toMatch(/ctxResolved:\s*boolean/)
  })

  it('ctxResolved local türetimi `!!ctx`', () => {
    expect(SRC).toMatch(/const ctxResolved:\s*boolean\s*=\s*!!ctx/)
  })

  it('Provider value içinde ctxResolved expose edilir', () => {
    expect(SRC).toMatch(/^\s+ctxResolved,$/m)
  })

  it('default context value\'da ctxResolved=false (transient default)', () => {
    expect(SRC).toMatch(/createContext<SiteCtx>\(\{[\s\S]+?ctxResolved:\s*false/)
  })
})
