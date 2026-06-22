/**
 * PR-A REVISED — DevicesPage queryKey contract.
 *
 * Source-level guard that the devices list + devices stats queries
 * partition on routeOrgId per the operator addendum:
 *
 *   ['org', routeOrgId, 'devices-list', search, vendor, status, deviceTypeFilter, tag, page, activeSite]
 *   ['org', routeOrgId, 'devices-stats', activeSite]
 *
 * A regression that drops routeOrgId from either key would re-introduce
 * the cross-tenant cache leak the operator flagged in the PR #108 review.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../index.tsx'),
  'utf-8',
)

describe('DevicesPage — routeOrgId-scoped queryKeys', () => {
  it('imports useRouteOrgId hook', () => {
    expect(SRC).toContain("from '@/hooks/useRouteOrgId'")
    expect(SRC).toMatch(/import\s*\{\s*useRouteOrgId\s*\}/)
  })

  it('invokes useRouteOrgId in the component body', () => {
    expect(SRC).toMatch(/const routeOrgId = useRouteOrgId\(\)/)
  })

  it('devices list queryKey starts with [org, routeOrgId, devices-list, ...]', () => {
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'org'\s*,\s*routeOrgId\s*,\s*'devices-list'\s*,/,
    )
  })

  it('devices stats queryKey starts with [org, routeOrgId, devices-stats, ...]', () => {
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'org'\s*,\s*routeOrgId\s*,\s*'devices-stats'\s*,/,
    )
  })

  it('legacy unscoped [devices, ...] queryKey is gone', () => {
    expect(SRC).not.toMatch(/queryKey:\s*\[\s*'devices'\s*,\s*search/)
  })

  it('invalidateQueries calls target routeOrgId-scoped keys', () => {
    // After PR-A revision, every invalidateQueries for the devices list
    // MUST target `['org', routeOrgId, 'devices-list']` — the partial
    // key matches every variant of the full list key.
    const invalidates = SRC.match(/invalidateQueries\(\{\s*queryKey:\s*\[[^\]]+\]/g) || []
    const devicesInvalidates = invalidates.filter((m) => m.includes("'devices-list'") || m.includes("'devices-stats'"))
    // At least the basic devices-list + devices-stats invalidations exist.
    expect(devicesInvalidates.length).toBeGreaterThan(0)
    for (const inv of devicesInvalidates) {
      expect(inv).toMatch(/'org'\s*,\s*routeOrgId/)
    }
  })

  it('legacy unscoped invalidateQueries({ queryKey: [devices] }) is gone', () => {
    expect(SRC).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\[\s*'devices'\s*\]\s*\}\)/)
  })
})
