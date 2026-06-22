/**
 * PR-A REVISED — DeviceForm queryKey contract.
 *
 * Source-level guard that the locations + agents queries partition on
 * routeOrgId per the operator addendum:
 *
 *   ['org', routeOrgId, 'locations']
 *   ['org', routeOrgId, 'agents']
 *
 * The queryFn `organization_id` filter is derived from `scopeOrgId`
 * (= routeOrgId ?? organization?.id) so the backend request scope
 * matches the URL-authoritative tenant — a stale localStorage value
 * cannot leak.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../DeviceForm.tsx'),
  'utf-8',
)

describe('DeviceForm — routeOrgId-scoped queryKeys', () => {
  it('imports useRouteOrgId hook', () => {
    expect(SRC).toContain("from '@/hooks/useRouteOrgId'")
  })

  it('invokes useRouteOrgId in the component body', () => {
    expect(SRC).toMatch(/const routeOrgId = useRouteOrgId\(\)/)
  })

  it('agents queryKey is [org, routeOrgId, agents]', () => {
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'org'\s*,\s*routeOrgId\s*,\s*'agents'\s*\]/,
    )
  })

  it('locations queryKey is [org, routeOrgId, locations]', () => {
    expect(SRC).toMatch(
      /queryKey:\s*\[\s*'org'\s*,\s*routeOrgId\s*,\s*'locations'\s*\]/,
    )
  })

  it('legacy queryKey shapes are gone', () => {
    // The pre-revision keys are explicitly removed.
    expect(SRC).not.toMatch(/queryKey:\s*\[\s*'agents'\s*,\s*activeOrgId\s*\]/)
    expect(SRC).not.toMatch(
      /queryKey:\s*\[\s*'locations'\s*,\s*\{\s*organization_id:\s*activeOrgId\s*\}\s*\]/,
    )
  })

  it('scopeOrgId is derived as routeOrgId ?? organization?.id ?? null (URL-authoritative)', () => {
    expect(SRC).toMatch(/scopeOrgId\s*=\s*routeOrgId\s*\?\?\s*\(?\s*organization\?\.id/)
  })

  it('locations queryFn uses scopeOrgId for organization_id filter', () => {
    expect(SRC).toMatch(/organization_id:\s*scopeOrgId/)
  })

  it('compatibleAgents filter uses activeOrgId alias of scopeOrgId (URL-authoritative)', () => {
    // After the revision activeOrgId is `const activeOrgId = scopeOrgId`,
    // so the downstream guards that filter agents by organization_id
    // still work but now reflect the URL-authoritative tenant.
    expect(SRC).toMatch(/const activeOrgId = scopeOrgId/)
  })
})
