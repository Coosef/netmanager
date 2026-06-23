/**
 * PR-A2 — prefixRouteForOperations helper.
 *
 * Sidebar (legacy 12-group), MenuGroupNav, useNavGroups all delegate
 * their tab-route prefix decision to this single pure function. A
 * regression here silently breaks the URL-authoritative org context
 * across every operations sidebar click.
 */
import { describe, it, expect } from 'vitest'
import { prefixRouteForOperations } from '../menuGroups'

describe('prefixRouteForOperations — operations panel routing', () => {
  it.each([
    // [route, routeOrgId, expected]
    ['/devices',                    6, '/app/org/6/devices'],
    ['/topology',                   6, '/app/org/6/topology'],
    ['/monitor',                    42, '/app/org/42/monitor'],
    ['/reports',                    1, '/app/org/1/reports'],
    ['/ipam',                       6, '/app/org/6/ipam'],
    ['/audit',                      6, '/app/org/6/audit'],
    ['/users',                      6, '/app/org/6/users'],
    ['/terminal-sessions',          6, '/app/org/6/terminal-sessions'],
    // Dashboard sentinel
    ['/',                           6, '/app/org/6/dashboard'],
  ])('prefix(%j, %s) → %s', (route, orgId, expected) => {
    expect(prefixRouteForOperations(route, orgId)).toBe(expected)
  })

  it.each([
    // Outside operations panel (routeOrgId === null) — no prefix
    ['/devices',                    null, '/devices'],
    ['/topology',                   null, '/topology'],
    ['/',                           null, '/'],
    ['/platform/overview',          null, '/platform/overview'],
  ])('no-op when routeOrgId is null: prefix(%j, %s) → %s', (route, orgId, expected) => {
    expect(prefixRouteForOperations(route, orgId)).toBe(expected)
  })

  it.each([
    // Already prefixed under correct org — returns as-is
    ['/app/org/6/devices',          6, '/app/org/6/devices'],
    ['/app/org/6/topology',         6, '/app/org/6/topology'],
    // Cross-org path — returns as-is (super-admin scope switch)
    ['/app/org/1/devices',          6, '/app/org/1/devices'],
    ['/app/org/42/agents',          6, '/app/org/42/agents'],
  ])('respects existing /app/org/N/... shape: prefix(%j, %s) → %s', (route, orgId, expected) => {
    expect(prefixRouteForOperations(route, orgId)).toBe(expected)
  })

  it('relative segment (no leading slash) is also prefixed', () => {
    expect(prefixRouteForOperations('devices', 6)).toBe('/app/org/6/devices')
  })
})
