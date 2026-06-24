/**
 * P0.2.1 SITECONTEXT SESSION EPOCH REFETCH (2026-06-24).
 *
 * Runs under the default `node` vitest environment (per vite.config.ts —
 * "jsdom env globally zustand persist localStorage uyumsuzluğu yaratıyor").
 * The Zustand store is exercised directly via getState / setAuth / logout;
 * we never mount a React tree, so jsdom is unnecessary.
 *
 * ──── Problem this regression suite locks in ──────────────────────────
 *
 * P0.2 shipped two fixes for the production "Lokasyon bağlamı
 * çözümleniyor…" hard-refresh deadlock:
 *   Fix 1 — 3-stage hydration recheck in useHasHydrated (sync +
 *           queueMicrotask + setTimeout(0)).
 *   Fix 2 — auth store `logout()` calls
 *           `queryClient.removeQueries({ queryKey: ['context'] })`
 *           so the next session starts cold.
 *
 * Post-deploy live tracing showed Fix 1 + Fix 2 cover the FRESH-LOGIN
 * path (admin session 1: `/context/current` fires 5 times, ctx
 * resolves, dashboard renders). But the RE-LOGIN path on the SAME tab
 * still hangs — `/context/current` never fires after logout/login
 * round-trip, SiteContext stays stuck on the resolving spinner.
 *
 * Root cause: SiteProvider is mounted ABOVE ProtectedRoute (App.tsx
 * places it between BrowserRouter and Routes), so the underlying
 * useQuery observer instance survives logout/login. With React Query
 * 5, the previous cache entry is wiped by Fix 2, but the surviving
 * observer's `enabled` transition false→true does NOT re-trigger
 * queryFn when the queryKey is identity-stable. Result: query stays
 * idle forever despite `enabled` being true.
 *
 * Fix 3 (this PR — P0.2.1): the auth store gains a transient
 * `sessionEpoch: number` field that increments on every successful
 * `setAuth()` call. SiteContext threads `sessionEpoch` into its
 * queryKey as `['context', 'current', sessionEpoch, routeOrgId,
 * activeLocationId]`. Each new login session changes the queryKey
 * identity → React Query allocates a fresh observer slot → queryFn
 * fires → /context/current returns → SiteContext unblocks.
 *
 * ──── Security pin ────────────────────────────────────────────────────
 *
 * `sessionEpoch` is an opaque monotonic integer. The raw bearer
 * token is intentionally NEVER part of the queryKey — operator's
 * directive — so that DevTools, telemetry, error reporters, browser
 * memory dumps, etc. never see the bearer surface as anything other
 * than "1, 2, 3". This file pins that invariant against future
 * "let's just put the token in the key for simplicity" regressions.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { useAuthStore } from '@/store/auth'

const AUTH_SRC = readFileSync(
  resolve(__dirname, '../../store/auth.ts'),
  'utf-8',
)
const SITE_SRC = readFileSync(
  resolve(__dirname, '../SiteContext.tsx'),
  'utf-8',
)
const codeOnlyAuth = AUTH_SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
const codeOnlySite = SITE_SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

// Helper to reset the Zustand store to its initial state for each test.
// Note: this preserves the production setAuth/logout reducers — we are
// asserting on real reducer behavior, not mocks.
function resetAuthStore() {
  useAuthStore.setState({
    token: null,
    user: null,
    permissions: null,
    sessionEpoch: 0,
  })
}

const ADMIN_USER = {
  id: 1,
  username: 'admin',
  email: 'admin@example.com',
  system_role: 'super_admin' as const,
}
const EMRE_USER = {
  id: 2,
  username: 'emre',
  email: 'emre@example.com',
  system_role: 'org_admin' as const,
}

describe('auth store — sessionEpoch field + increment behavior', () => {
  beforeEach(resetAuthStore)

  it('AuthState type declares sessionEpoch: number', () => {
    expect(codeOnlyAuth).toMatch(/sessionEpoch:\s*number/)
  })

  it('initial state seeds sessionEpoch to 0 (NOT 1, NOT undefined)', () => {
    // Pin both the source and the runtime value. Initial 0 means the
    // first authenticated session reads sessionEpoch === 1 — a
    // distinguishable signal that a real setAuth has occurred at
    // least once.
    expect(codeOnlyAuth).toMatch(/sessionEpoch:\s*0,/)
    const state = useAuthStore.getState()
    expect(state.sessionEpoch).toBe(0)
  })

  it('first successful setAuth bumps sessionEpoch 0 → 1', () => {
    useAuthStore.getState().setAuth('tok-A', ADMIN_USER as any, null)
    expect(useAuthStore.getState().sessionEpoch).toBe(1)
  })

  it('subsequent setAuth calls bump monotonically (1 → 2 → 3)', () => {
    const setAuth = useAuthStore.getState().setAuth
    setAuth('tok-A', ADMIN_USER as any, null)
    expect(useAuthStore.getState().sessionEpoch).toBe(1)
    setAuth('tok-B', EMRE_USER as any, null)
    expect(useAuthStore.getState().sessionEpoch).toBe(2)
    setAuth('tok-C', ADMIN_USER as any, null)
    expect(useAuthStore.getState().sessionEpoch).toBe(3)
  })

  it('logout DOES NOT reset sessionEpoch (operator contract)', () => {
    // Operator-verbatim contract from P0.2.1 brief:
    //   "Logout içinde sessionEpoch'i keyfi şekilde eski değere geri
    //    alma. Yeni login her zaman yeni epoch üretmeli."
    // The next setAuth that follows MUST yield a strictly-greater
    // epoch than the value observed at the moment logout fired.
    const { setAuth, logout } = useAuthStore.getState()
    setAuth('tok-A', ADMIN_USER as any, null)
    const epochBeforeLogout = useAuthStore.getState().sessionEpoch
    expect(epochBeforeLogout).toBe(1)
    logout()
    // logout cleared token/user/permissions but NOT sessionEpoch
    expect(useAuthStore.getState().sessionEpoch).toBe(epochBeforeLogout)
    expect(useAuthStore.getState().token).toBeNull()
    // Re-login must bump the counter strictly above the pre-logout value
    setAuth('tok-B', EMRE_USER as any, null)
    expect(useAuthStore.getState().sessionEpoch)
      .toBeGreaterThan(epochBeforeLogout)
    expect(useAuthStore.getState().sessionEpoch).toBe(2)
  })

  it('source: setAuth reads previous epoch via get() (not stale closure)', () => {
    // The reducer must use the live store snapshot via `get()` —
    // capturing a stale closure value would freeze the counter at
    // whatever value was visible when the closure was created.
    expect(codeOnlyAuth).toMatch(
      /setAuth:\s*\(token,\s*user,\s*permissions[^)]*\)\s*=>[\s\S]{0,400}sessionEpoch:\s*get\(\)\.sessionEpoch\s*\+\s*1/,
    )
  })

  it('source: logout body does NOT touch sessionEpoch field', () => {
    // Walk the body of the `logout:` arrow function and confirm
    // neither a `sessionEpoch:` reset literal nor a `sessionEpoch =`
    // mutation appears inside. The set({token:null,...}) call at the
    // end is allowed; what we ban is any sessionEpoch RHS.
    const logoutBody = codeOnlyAuth.match(
      /logout:\s*\(\)\s*=>\s*\{([\s\S]+?)\n\s*\},\s*\n\s*can:/,
    )
    expect(logoutBody).toBeTruthy()
    expect(logoutBody![1]).not.toMatch(/sessionEpoch\s*:/)
    expect(logoutBody![1]).not.toMatch(/sessionEpoch\s*=/)
  })
})


describe('auth store — sessionEpoch persistence policy', () => {
  it('partialize does NOT persist sessionEpoch (transient runtime state)', () => {
    // Persisting the counter would let a stale cross-tab boot
    // participate in a queryKey that was minted by a different
    // session — defense against ghost cache hits. The header comment
    // on AuthState.sessionEpoch documents the rationale; this pin
    // makes the policy machine-enforced.
    const partializeBlock = codeOnlyAuth.match(
      /partialize:\s*\(state\)\s*=>\s*\(\{([\s\S]+?)\}\)/,
    )
    expect(partializeBlock).toBeTruthy()
    expect(partializeBlock![1]).not.toMatch(/sessionEpoch/)
    expect(partializeBlock![1]).toMatch(/token:\s*state\.token/)
    expect(partializeBlock![1]).toMatch(/user:\s*state\.user/)
    expect(partializeBlock![1]).toMatch(/permissions:\s*state\.permissions/)
  })
})


describe('SiteContext — sessionEpoch wired into queryKey', () => {
  it('imports sessionEpoch from the auth store via the existing useAuthStore() call', () => {
    // We do NOT want a second useAuthStore() invocation that
    // captures the epoch in a separate selector — every re-render of
    // SiteProvider should read both token and sessionEpoch from the
    // same store snapshot to avoid mismatched render frames.
    expect(SITE_SRC).toMatch(
      /const\s*\{\s*token,\s*sessionEpoch\s*\}\s*=\s*useAuthStore\(\)/,
    )
  })

  it('queryKey shape is exactly [context, current, sessionEpoch, routeOrgId, activeLocationId]', () => {
    expect(SITE_SRC).toMatch(
      /queryKey:\s*\['context',\s*'current',\s*sessionEpoch,\s*routeOrgId,\s*activeLocationId\]/,
    )
  })

  it('sessionEpoch sits BEFORE routeOrgId so a session bump invalidates ALL per-tenant entries', () => {
    // Order matters: if sessionEpoch came after routeOrgId,
    // each routeOrgId would have its own per-epoch cache entry,
    // which is fine — but if a session bump happens mid-flight
    // (logout-while-fetching) the in-flight cache entry could
    // race with the new entry. Putting sessionEpoch FIRST guarantees
    // any new session opens a completely fresh observer slot
    // regardless of routeOrgId / activeLocationId.
    const keyMatch = codeOnlySite.match(/queryKey:\s*\[([^\]]+)\]/)
    expect(keyMatch).toBeTruthy()
    const segments = keyMatch![1].split(',').map((s) => s.trim())
    expect(segments).toEqual([
      "'context'",
      "'current'",
      'sessionEpoch',
      'routeOrgId',
      'activeLocationId',
    ])
  })

  it('queryKey contains NO raw token (security pin — operator directive)', () => {
    // Operator-verbatim contract: "Query key içine raw token EKLEME.
    // Token React Query cache, DevTools, telemetry veya hata
    // çıktılarında görünmemeli." A future contributor who adds
    // `token` to the key (or any alias of it like `bearer`,
    // `authToken`, `auth_token`, `accessToken`) makes this pin fail.
    const keyMatch = codeOnlySite.match(/queryKey:\s*\[([^\]]+)\]/)
    expect(keyMatch).toBeTruthy()
    const keyBody = keyMatch![1]
    expect(keyBody).not.toMatch(/\btoken\b/)
    expect(keyBody).not.toMatch(/\bbearer\b/i)
    expect(keyBody).not.toMatch(/\bauthToken\b/i)
    expect(keyBody).not.toMatch(/\bauth_token\b/i)
    expect(keyBody).not.toMatch(/\baccessToken\b/i)
  })

  it('enabled condition is !!token only (P0.2.2 contract)', () => {
    // P0.2.2 CONTEXT QUERY TOKEN-ONLY GATE (2026-06-24) supersedes the
    // P0.2 `!!token && hydrated` shape. Live production audit proved
    // that SiteProvider's per-instance `useHasHydrated()` snapshot
    // could stay pinned at false even after ProtectedRoute's token-
    // first matrix had admitted the user, leaving the gate stuck at
    // false forever. Token is the right gate — see SiteContext.tsx
    // comment block above the useQuery for the full rationale. The
    // P0.2.1 sessionEpoch queryKey shape (next test) is preserved
    // unchanged.
    expect(codeOnlySite).toMatch(/enabled:\s*!!token\s*,/)
    expect(codeOnlySite).not.toMatch(/enabled:\s*!!token\s*&&\s*hydrated/)
  })
})


describe('SiteContext — P0.2 regression preserved alongside P0.2.1', () => {
  it('useHasHydrated hook import + call still present (P0.2 Fix 1)', () => {
    expect(SITE_SRC).toContain("from '@/hooks/useHasHydrated'")
    expect(SITE_SRC).toMatch(/const hydrated = useHasHydrated\(\)/)
  })

  it('auth.ts logout still calls removeQueries({queryKey:[context]}) (P0.2 Fix 2)', () => {
    // P0.2.1 ADDS a session-epoch key change; it does NOT remove
    // the cache wipe. Both fixes coexist:
    //   - removeQueries wipes the prior session's cache entry.
    //   - sessionEpoch bump forces a new observer slot.
    expect(AUTH_SRC).toMatch(
      /removeQueries\(\s*\{\s*queryKey:\s*\[['"]context['"]\]\s*\}\s*\)/,
    )
  })

  it('auth.ts logout does NOT add a global queryClient.clear() call', () => {
    // Operator-verbatim contract: "Global queryClient.clear() ekleme."
    // The scoped removeQueries({queryKey:['context']}) is the only
    // sanctioned cache mutation in logout — a `.clear()` would also
    // wipe unrelated queries (LLDP, audit, devices, …) that have no
    // bearing on the session-isolation problem.
    expect(codeOnlyAuth).not.toMatch(/queryClient\.clear\s*\(/)
  })

  it('P0.2 STRICT PlatformShell three-state path still present in PlatformShell.tsx', () => {
    // Defense-in-depth check that P0.2.1 did not inadvertently
    // resurrect the `if (!ctxResolved) return null` blank path.
    const platformSrc = readFileSync(
      resolve(__dirname, '../../routes/PlatformShell.tsx'),
      'utf-8',
    )
    const platformCode = platformSrc
      .replace(/\/\/[^\n]*\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(platformCode).not.toMatch(/if\s*\(!ctxResolved\)\s*return\s+null/)
    expect(platformCode).toMatch(/data-testid="platform-shell-loading"/)
    expect(platformCode).toMatch(/data-testid="platform-shell-error"/)
  })
})


describe('SiteContext — logout → login bumps queryKey identity (refetch contract)', () => {
  beforeEach(resetAuthStore)

  it('queryKey identity diverges across logout → login round-trip', () => {
    // This is the END-TO-END behavioral contract that P0.2.1 buys.
    // We don't need to render React or mount a useQuery to verify
    // the contract — we can compute the queryKey value the way
    // SiteContext does and assert it changes per session.
    const { setAuth, logout } = useAuthStore.getState()
    setAuth('session-1-token', ADMIN_USER as any, null)
    const epochSession1 = useAuthStore.getState().sessionEpoch
    // Snapshot the per-session key (same routeOrgId + activeLocationId)
    const keySession1 = ['context', 'current', epochSession1, 1, 42]
    logout()
    setAuth('session-2-token', EMRE_USER as any, null)
    const epochSession2 = useAuthStore.getState().sessionEpoch
    const keySession2 = ['context', 'current', epochSession2, 1, 42]
    expect(epochSession2).toBeGreaterThan(epochSession1)
    expect(JSON.stringify(keySession1)).not.toBe(JSON.stringify(keySession2))
    // Sanity: routeOrgId + activeLocationId tail still identical
    expect(keySession1[3]).toBe(keySession2[3])
    expect(keySession1[4]).toBe(keySession2[4])
  })

  it('within a single session, queryKey identity is stable across re-renders', () => {
    // Cache partitioning by routeOrgId / activeLocationId must NOT
    // be defeated by sessionEpoch — within ONE session, the same
    // route should serve the same cache entry, so React Query's
    // existing staleTime + observer machinery does its job. We
    // verify by reading sessionEpoch twice across rapid getState
    // calls without any setAuth in between.
    useAuthStore.getState().setAuth('tok', ADMIN_USER as any, null)
    const a = useAuthStore.getState().sessionEpoch
    const b = useAuthStore.getState().sessionEpoch
    expect(a).toBe(b)
    expect(['context', 'current', a, 7, 99]).toEqual(
      ['context', 'current', b, 7, 99],
    )
  })
})
