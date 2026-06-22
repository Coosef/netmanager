/**
 * PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — SiteContext organization
 * scope extensions, source-level pinning.
 *
 * Mirrors the lightweight string-match pattern used by
 * `SiteContext.hydration.test.ts` to keep the test harness
 * jsdom-free and immune to axios/zustand internal refactors.
 *
 * Coverage:
 *   1. `activeOrgId` state + persistence in localStorage
 *   2. `setOrganization` callback semantics:
 *        - writes/removes ACTIVE_ORG_KEY
 *        - clears activeLocationId + ACTIVE_LOCATION_KEY
 *        - invalidateQueries (NOT clear) → PR #103 anti-flicker
 *   3. queryKey carries activeOrgId
 *   4. Non-super-admin cleanup effect
 *   5. Cross-tab `storage` event handler for ACTIVE_ORG_KEY
 *   6. SiteCtx interface exposes activeOrgId + setOrganization
 *   7. createContext default value includes the new fields
 *   8. Provider value re-exports them
 *
 * Operator constraint ledger:
 *   - NO production deploy
 *   - NO VPS / DB / migration mutation
 *   - PR #103 hydration contract preserved (queryClient.clear()
 *     never reintroduced)
 *   - PR #104 location scope contract preserved
 *   - PR #105 interceptor caller-respect contract preserved
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../SiteContext.tsx'),
  'utf-8',
)


describe('SiteContext — PHASE1A activeOrgId state + persistence', () => {
  it('imports ACTIVE_ORG_KEY from @/api/client', () => {
    expect(SRC).toMatch(/ACTIVE_ORG_KEY/)
    expect(SRC).toMatch(/from '@\/api\/client'/)
  })

  it('declares activeOrgId useState with localStorage initializer', () => {
    expect(SRC).toMatch(
      /const \[activeOrgId, setActiveOrgIdState\] = useState<number \| null>/,
    )
    expect(SRC).toMatch(/localStorage\.getItem\(ACTIVE_ORG_KEY\)/)
  })
})


describe('SiteContext — PHASE1A setOrganization callback contract', () => {
  it('writes ACTIVE_ORG_KEY when orgId != null', () => {
    expect(SRC).toMatch(
      /localStorage\.setItem\(ACTIVE_ORG_KEY, String\(orgId\)\)/,
    )
  })

  it('removes ACTIVE_ORG_KEY when orgId == null (Platform Mode)', () => {
    expect(SRC).toMatch(/localStorage\.removeItem\(ACTIVE_ORG_KEY\)/)
  })

  it('CLEARS the active location on every org switch (cross-tenant safety)', () => {
    // The previous tenant's location id rarely maps to a valid pick in
    // the new tenant. Forcing the clear means the very first request
    // under the new X-Org-Id omits X-Location-Id and lets the backend
    // pick a sane default. A regression that drops the clear would
    // immediately reintroduce the cross-tenant 400 the operator's
    // production smoke surfaced.
    const setOrgBlock = SRC.match(
      /const setOrganization = useCallback\([\s\S]+?\}, \[queryClient\],?\s*\)/,
    )
    expect(setOrgBlock).not.toBeNull()
    expect(setOrgBlock![0]).toMatch(/setActiveLocationIdState\(null\)/)
    expect(setOrgBlock![0]).toMatch(
      /localStorage\.removeItem\(ACTIVE_LOCATION_KEY\)/,
    )
  })

  it('uses invalidateQueries() — NEVER queryClient.clear() (PR #103 contract)', () => {
    const setOrgBlock = SRC.match(
      /const setOrganization = useCallback\([\s\S]+?\}, \[queryClient\],?\s*\)/,
    )
    expect(setOrgBlock).not.toBeNull()
    expect(setOrgBlock![0]).toMatch(/queryClient\.invalidateQueries\(\)/)
    // Strip comments before checking — the explanatory block above the
    // callback discusses why `queryClient.clear()` is NOT used, so a
    // raw string-match would catch that prose. Drop // line comments
    // first, then assert no actual call.
    const codeOnly = setOrgBlock![0].replace(/\/\/[^\n]*\n/g, '\n')
    expect(codeOnly).not.toMatch(/queryClient\.clear\(\)/)
  })
})


describe('SiteContext — PR-A REVISED queryKey carries routeOrgId (URL-authoritative)', () => {
  it('queryKey is [context, current, routeOrgId, activeLocationId]', () => {
    // PR-A REVISED: queryKey carries `routeOrgId` (URL-authoritative)
    // first then `activeLocationId`. Replaces the PHASE1A shape
    // `[..., activeLocationId, activeOrgId]` per the operator
    // addendum that closed the cache-leak window in PR #108 review.
    expect(SRC).toMatch(
      /queryKey:\s*\['context',\s*'current',\s*routeOrgId,\s*activeLocationId\]/,
    )
  })

  it('queryKey does NOT include activeOrgId (legacy slot removed)', () => {
    expect(SRC).not.toMatch(
      /queryKey:\s*\['context',\s*'current',\s*activeLocationId,\s*activeOrgId\]/,
    )
  })
})


describe('SiteContext — PHASE1A non-super-admin cleanup effect', () => {
  it('removes ACTIVE_ORG_KEY for non-super-admin sessions on hydration', () => {
    // The cleanup effect fires when:
    //   1. ctxResolved (backend answered)
    //   2. !isPlatformSuperAdmin (user is not a super-admin by ROLE)
    //      — switched from `is_super_admin` (BYPASS state) by
    //      ORG-CONTEXT-FALLBACK-FIX (2026-06-22). The pre-fix gate
    //      mistook a scoped super-admin's bypass-off state for "not
    //      a super-admin" and wiped activeOrgId on every refetch.
    //   3. activeOrgId != null (stale value sitting in localStorage)
    // → clear the state + localStorage. A demoted user / shared
    // browser profile cannot retain a previous super-admin's scope.
    const cleanupEffect = SRC.match(
      /useEffect\(\(\) => \{\s*if \(!ctxResolved\) return\s*if \(isPlatformSuperAdmin\) return[\s\S]+?\}, \[ctxResolved, isPlatformSuperAdmin, activeOrgId\]\)/,
    )
    expect(cleanupEffect).not.toBeNull()
    expect(cleanupEffect![0]).toMatch(/setActiveOrgIdState\(null\)/)
    expect(cleanupEffect![0]).toMatch(/localStorage\.removeItem\(ACTIVE_ORG_KEY\)/)
  })
})


describe('SiteContext — PHASE1A cross-tab storage handler', () => {
  it('listens for ACTIVE_ORG_KEY storage events', () => {
    expect(SRC).toMatch(/if \(e\.key !== ACTIVE_ORG_KEY\) return/)
    expect(SRC).toMatch(/setActiveOrgIdState\(\(prev\)/)
  })
})


describe('SiteContext — PHASE1A interface + default + provider value', () => {
  it('SiteCtx interface declares activeOrgId + setOrganization', () => {
    expect(SRC).toMatch(/activeOrgId:\s*number \| null/)
    expect(SRC).toMatch(/setOrganization:\s*\(orgId:\s*number \| null\)\s*=>\s*void/)
  })

  it('createContext default includes activeOrgId: null + setOrganization no-op', () => {
    expect(SRC).toMatch(
      /createContext<SiteCtx>\(\{[\s\S]+?activeOrgId:\s*null,[\s\S]+?setOrganization:\s*\(\)\s*=>\s*\{\},/,
    )
  })

  it('provider value re-exports activeOrgId + setOrganization', () => {
    expect(SRC).toMatch(/^\s+activeOrgId,$/m)
    expect(SRC).toMatch(/^\s+setOrganization,$/m)
  })
})


// ─── ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — role vs bypass split ────


describe('SiteContext — ORG-CONTEXT-FALLBACK-FIX role vs bypass split', () => {
  // Operator-confirmed regression in PR #106 production smoke:
  //   1. Super-admin picks ATG Hotels in the new switcher
  //   2. /context/current responds with `system_role: "super_admin"`
  //      AND `is_super_admin: false` (backend correctly drops the RLS
  //      bypass once the super-admin is scoped into a tenant)
  //   3. The pre-fix SiteContext read `is_super_admin` as the "is
  //      this user a super-admin?" signal, the cleanup useEffect
  //      mistook the bypass-off state for "user is not a super-admin
  //      at all", wiped activeOrgId, dropped the X-Org-Id header on
  //      the next refetch, and looped the operator back to Platform
  //      Mode with all 8 cross-org locations visible.
  //
  // The fix introduces `isPlatformSuperAdmin` (ROLE identity, derived
  // from `ctx.system_role === 'super_admin'`) alongside the existing
  // `isSuperAdmin` (BYPASS state, unchanged). Every UI consumer
  // switched over to the role flag; the bypass flag remains exported
  // for the rare edge cases that genuinely need to know "is the
  // current request running in super-admin RLS bypass mode?".

  it('SiteCtx interface declares isPlatformSuperAdmin: boolean', () => {
    expect(SRC).toMatch(/isPlatformSuperAdmin:\s*boolean/)
  })

  it('isPlatformSuperAdmin is derived from ctx?.system_role === \'super_admin\'', () => {
    expect(SRC).toMatch(
      /const isPlatformSuperAdmin:\s*boolean\s*=\s*ctx\?\.system_role\s*===\s*'super_admin'/,
    )
  })

  it('isSuperAdmin derivation UNCHANGED — still reads ctx.is_super_admin (bypass state)', () => {
    expect(SRC).toMatch(/const isSuperAdmin:\s*boolean\s*=\s*ctx\?\.is_super_admin\s*\?\?\s*false/)
  })

  it('createContext default includes isPlatformSuperAdmin: false', () => {
    expect(SRC).toMatch(
      /createContext<SiteCtx>\(\{[\s\S]+?isPlatformSuperAdmin:\s*false/,
    )
  })

  it('provider value re-exports isPlatformSuperAdmin', () => {
    expect(SRC).toMatch(/^\s+isPlatformSuperAdmin,$/m)
  })

  it('cleanup effect gate switched from isSuperAdmin to isPlatformSuperAdmin', () => {
    // The full regex on the cleanup useEffect already pins both the
    // gate AND the dependency array — this duplicates it as a
    // negative-invariant guard so a future regression that flips
    // ONE of them (gate but not deps, or vice versa) still trips a
    // failing test.
    expect(SRC).toMatch(/if \(isPlatformSuperAdmin\) return/)
    // The pre-fix gate MUST NOT come back via a copy-paste.
    const cleanupBlock = SRC.match(
      /\/\/ PLATFORM\/OPERATIONS-PHASE1A \(2026-06-22\) — non-super-admin cleanup\.[\s\S]+?\}, \[ctxResolved, isPlatformSuperAdmin, activeOrgId\]\)/,
    )
    expect(cleanupBlock).not.toBeNull()
    expect(cleanupBlock![0]).not.toMatch(/if \(isSuperAdmin\) return/)
    expect(cleanupBlock![0]).not.toMatch(/\[ctxResolved, isSuperAdmin, activeOrgId\]/)
  })

  it('the scoped-super-admin contract is explicitly named in the fix comment', () => {
    // Belt + braces — the fix comment names the operator-confirmed
    // bug so a future reader understands the gate's history.
    expect(SRC).toMatch(/ORG-CONTEXT-FALLBACK-FIX/)
  })
})


describe('SiteContext — preserved contracts', () => {
  it('PR #103 hydration: SITE-CONTEXT-HYDRATION-GUARD comments still present', () => {
    expect(SRC).toMatch(/SITE-CONTEXT-HYDRATION-GUARD/)
    expect(SRC).toMatch(/const ctxResolved:\s*boolean\s*=\s*!!ctx/)
  })

  it('PR #103 hydration: setLocation still uses invalidateQueries (NOT clear)', () => {
    const setLocBlock = SRC.match(
      /const setLocation = useCallback\([\s\S]+?\}, \[queryClient\],?\s*\)/,
    )
    expect(setLocBlock).not.toBeNull()
    expect(setLocBlock![0]).toMatch(/queryClient\.invalidateQueries/)
    const codeOnly = setLocBlock![0].replace(/\/\/[^\n]*\n/g, '\n')
    expect(codeOnly).not.toMatch(/queryClient\.clear\(\)/)
  })

  it('shouldReconcileLocation + isActiveLocationStale signatures unchanged', () => {
    expect(SRC).toMatch(/export function shouldReconcileLocation/)
    expect(SRC).toMatch(/export function isActiveLocationStale/)
  })
})
