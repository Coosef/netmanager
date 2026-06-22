/**
 * PR-A REVISED — NocAgents queryKey contract.
 *
 * Source-level guard that the agents-list query partitions on
 * routeOrgId per the operator addendum:
 *
 *   ['org', routeOrgId, 'agents-list']
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../NocAgents.tsx'),
  'utf-8',
)

describe('NocAgents — routeOrgId-scoped queryKey', () => {
  it('imports useRouteOrgId', () => {
    expect(SRC).toContain("from '@/hooks/useRouteOrgId'")
  })

  it('invokes useRouteOrgId in the component body', () => {
    expect(SRC).toMatch(/const routeOrgId = useRouteOrgId\(\)/)
  })

  it('agents-list queryKey is [org, routeOrgId, agents-list]', () => {
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'org'\s*,\s*routeOrgId\s*,\s*'agents-list'\s*\]/,
    )
  })

  it('invalidateQueries targets [org, routeOrgId, agents-list]', () => {
    const invalidates = SRC.match(/invalidateQueries\(\{\s*queryKey:\s*\[[^\]]+\]/g) || []
    const agentsInvalidates = invalidates.filter((m) => m.includes("'agents-list'"))
    expect(agentsInvalidates.length).toBeGreaterThan(0)
    for (const inv of agentsInvalidates) {
      expect(inv).toMatch(/'org'\s*,\s*routeOrgId\s*,\s*'agents-list'/)
    }
  })

  it('legacy unscoped queryKey [agents-list] is gone', () => {
    expect(SRC).not.toMatch(/queryKey:\s*\[\s*'agents-list'\s*\]/)
  })

  it('legacy invalidateQueries({ queryKey: [agents-list] }) is gone', () => {
    expect(SRC).not.toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\[\s*'agents-list'\s*\]\s*\}\)/,
    )
  })
})
