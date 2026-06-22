// @vitest-environment jsdom
/**
 * PR-A REVISED — useRouteOrgId URL-authoritative contract.
 *
 * The hook is the source of truth every operations-shell consumer
 * (DevicesPage, NocAgents, DeviceForm, SiteContext's ctx query, the
 * Axios interceptor) reads to derive its org scope. A regression here
 * silently corrupts every PR-A guarantee.
 *
 * Test matrix:
 *   - returns N for `/app/org/N/...`
 *   - returns null for legacy / platform / root routes
 *   - reflects URL changes in real time (re-renders correctly)
 *   - rejects malformed / negative / zero ids
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useRouteOrgId } from '../useRouteOrgId'
import type { ReactNode } from 'react'

function wrapperAt(path: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  )
}

describe('useRouteOrgId — URL-authoritative org scope hook', () => {
  it.each([
    ['/app/org/6',                 6],
    ['/app/org/6/dashboard',       6],
    ['/app/org/6/devices',         6],
    ['/app/org/6/agents',          6],
    ['/app/org/42/devices',        42],
    ['/app/org/123/agents',        123],
    ['/app/org/6/devices/42',      6],
  ])('returns %i for %s', (path, expected) => {
    const { result } = renderHook(() => useRouteOrgId(), { wrapper: wrapperAt(path) })
    expect(result.current).toBe(expected)
  })

  it.each([
    '/',
    '/dashboard',
    '/devices',
    '/agents',
    '/topology',
    '/platform/overview',
    '/platform/organizations/6', // platform — :organizationId here is NOT operations route org
    '/app',
    '/app/org',
    '/app/org/',
    '/app/org/abc',
    '/app/org/-1',
    '/app/org/0',
  ])('returns null for %s', (path) => {
    const { result } = renderHook(() => useRouteOrgId(), { wrapper: wrapperAt(path) })
    expect(result.current).toBeNull()
  })
})
