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


describe('SiteContext — PHASE1A useQuery key carries activeOrgId', () => {
  it('queryKey ends with [..., activeLocationId, activeOrgId]', () => {
    // A regression that drops activeOrgId from the key would cause a
    // super-admin's org switch to read stale cached ctx for the
    // previous tenant — operator confusion + cross-tenant data leak.
    expect(SRC).toMatch(
      /queryKey:\s*\['context',\s*'current',\s*activeLocationId,\s*activeOrgId\]/,
    )
  })
})


describe('SiteContext — PHASE1A non-super-admin cleanup effect', () => {
  it('removes ACTIVE_ORG_KEY for non-super-admin sessions on hydration', () => {
    // The cleanup effect fires when:
    //   1. ctxResolved (backend answered)
    //   2. !isSuperAdmin (user is not a super-admin)
    //   3. activeOrgId != null (stale value sitting in localStorage)
    // → clear the state + localStorage. A demoted user / shared
    // browser profile cannot retain a previous super-admin's scope.
    const cleanupEffect = SRC.match(
      /useEffect\(\(\) => \{\s*if \(!ctxResolved\) return\s*if \(isSuperAdmin\) return[\s\S]+?\}, \[ctxResolved, isSuperAdmin, activeOrgId\]\)/,
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
