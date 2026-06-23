// @vitest-environment jsdom
/**
 * PR-A2 — useOperationsNavigate hook contract.
 *
 * The hook is the single source of truth for "does this navigate stay
 * inside /app/org/:routeOrgId/* or deliberately leave it?". Operator-
 * mandated rule:
 *
 *   Silent legacy escape from operations panel = FORBIDDEN.
 *   Explicit global navigation = ALLOWED via `intentionalGlobal: true`.
 *
 * The fixture matrix below pins every documented branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

import { useOperationsNavigate } from '../useOperationsNavigate'

function wrapperAt(path: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  )
}

describe('useOperationsNavigate — inside operations panel (/app/org/6/*)', () => {
  beforeEach(() => {
    navigateMock.mockClear()
  })

  it('absolute /devices → /app/org/6/devices (auto-prefix)', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/topology') })
    result.current('/devices')
    expect(navigateMock).toHaveBeenCalledWith('/app/org/6/devices', { replace: undefined })
  })

  it('absolute /devices?search=x → /app/org/6/devices?search=x (query preserved)', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/topology') })
    result.current('/devices?search=cisco')
    expect(navigateMock).toHaveBeenCalledWith('/app/org/6/devices?search=cisco', { replace: undefined })
  })

  it('relative devices/42 → /app/org/6/devices/42', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/devices') })
    result.current('devices/42')
    expect(navigateMock).toHaveBeenCalledWith('/app/org/6/devices/42', { replace: undefined })
  })

  it('absolute /platform/overview WITHOUT intentionalGlobal → navigates AS-IS (with dev warning)', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/devices') })
    result.current('/platform/overview')
    // Still navigated, but to legacy root — dev warning logged separately
    expect(navigateMock).toHaveBeenCalledWith('/platform/overview', { replace: undefined })
  })

  it('absolute /settings WITH intentionalGlobal → navigates AS-IS (no prefix, no warning)', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/bandwidth') })
    result.current('/settings?tab=snmp', { intentionalGlobal: true })
    expect(navigateMock).toHaveBeenCalledWith('/settings?tab=snmp', { replace: undefined })
  })

  it('cross-org /app/org/1/devices → navigates AS-IS (super-admin scope switch)', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/devices') })
    result.current('/app/org/1/devices')
    expect(navigateMock).toHaveBeenCalledWith('/app/org/1/devices', { replace: undefined })
  })

  it('replace flag is propagated', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/app/org/6/devices') })
    result.current('/agents', { replace: true })
    expect(navigateMock).toHaveBeenCalledWith('/app/org/6/agents', { replace: true })
  })
})

describe('useOperationsNavigate — OUTSIDE operations panel (legacy / platform / login)', () => {
  it.each([
    ['/dashboard', '/devices'],
    ['/topology', '/monitor'],
    ['/platform/overview', '/platform/organizations'],
    ['/login', '/dashboard'],
  ])('at %s, navigate(%s) → AS-IS (no prefix)', (currentPath, targetPath) => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt(currentPath) })
    result.current(targetPath)
    expect(navigateMock).toHaveBeenCalledWith(targetPath, { replace: undefined })
  })

  it('intentionalGlobal flag has no effect outside operations panel', () => {
    navigateMock.mockClear()
    const { result } = renderHook(() => useOperationsNavigate(), { wrapper: wrapperAt('/dashboard') })
    result.current('/settings', { intentionalGlobal: true })
    expect(navigateMock).toHaveBeenCalledWith('/settings', { replace: undefined })
  })
})
