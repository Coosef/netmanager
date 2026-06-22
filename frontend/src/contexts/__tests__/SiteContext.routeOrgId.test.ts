/**
 * PR-A REVISED — SiteContext routeOrgId integration.
 *
 * Source-level guards on the routeOrgId migration:
 *   1. useRouteOrgId is imported + invoked at SiteProvider top.
 *   2. The ctx query's queryKey carries routeOrgId in the slot specified
 *      by the operator addendum: `['context', 'current', routeOrgId, activeLocationId]`.
 *   3. The legacy `activeOrgId` slot is REMOVED from the ctx queryKey —
 *      routeOrgId is the URL-authoritative authority inside /app/org/*,
 *      and the legacy interceptor fallback covers everything else.
 *   4. SiteCtx exposes `routeOrgId` so consumers (OrgBadge, etc.) can
 *      validate against URL truth without duplicating the URL parsing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../SiteContext.tsx'),
  'utf-8',
)

describe('SiteContext — routeOrgId URL-authoritative integration', () => {
  it('imports useRouteOrgId from @/hooks/useRouteOrgId', () => {
    expect(SRC).toContain("from '@/hooks/useRouteOrgId'")
    expect(SRC).toMatch(/import\s*\{\s*useRouteOrgId\s*\}/)
  })

  it('invokes useRouteOrgId at the top of SiteProvider', () => {
    expect(SRC).toMatch(/const routeOrgId = useRouteOrgId\(\)/)
  })

  it('ctx queryKey is [context, current, routeOrgId, activeLocationId]', () => {
    // PR-A REVISED queryKey shape — routeOrgId FIRST after the namespace,
    // activeLocationId after. The operator-specified shape exactly.
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'context'\s*,\s*'current'\s*,\s*routeOrgId\s*,\s*activeLocationId\s*\]/,
    )
  })

  it('ctx queryKey does NOT include activeOrgId (legacy slot removed)', () => {
    // Defensive: the legacy `['context', 'current', activeLocationId, activeOrgId]`
    // shape MUST NOT come back — activeOrgId in the key would partition the
    // cache by a stale preference instead of the URL-authoritative routeOrgId.
    expect(SRC).not.toMatch(
      /queryKey:\s*\[\s*'context'\s*,\s*'current'\s*,\s*activeLocationId\s*,\s*activeOrgId\s*\]/,
    )
  })

  it('routeOrgId is exposed on the SiteCtx interface', () => {
    expect(SRC).toMatch(/routeOrgId:\s*number\s*\|\s*null/)
  })

  it('routeOrgId is propagated through the Provider value', () => {
    // The provider's value prop MUST include routeOrgId so the hook
    // consumers (DeviceForm fallback computation, OrgBadge validation)
    // can read it via useSite() without duplicating useLocation().
    expect(SRC).toMatch(/value=\{\s*\{[\s\S]*?routeOrgId[\s\S]*?\}/)
  })

  it('default SiteContext value defines routeOrgId: null', () => {
    expect(SRC).toMatch(/createContext<SiteCtx>\(\{[\s\S]*?routeOrgId:\s*null/)
  })
})
