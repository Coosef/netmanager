// @vitest-environment jsdom
/**
 * ProtectedRoute — token-first karar matrisi (AUTH-GUARD-TOKEN-FIRST-FIX,
 * 2026-06-10).
 *
 * Production bug: useHasHydrated() Login → Dashboard navigate sırasında
 * false kalabiliyor → eski `if (!hydrated) return null` blank screen
 * üretiyordu (canlı browser: URL=/dashboard, token=var, rootText="").
 *
 * Yeni matris:
 *   token VAR              → children (hydrated bağımsız)
 *   token YOK + !hydrated  → <ProtectedRouteLoading> (görünür)
 *   token YOK + hydrated   → <Navigate to="/login">
 *
 * Bu testler kullanıcı talebine göre KRİTİK senaryoyu (token var +
 * hydrated FALSE) kapsar. Mock'ta `useHasHydrated → true` vermek
 * production bug'ını saklar — burada hidrasyon false ile test edilir.
 */
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// useHasHydrated MOCK — production bug'ı simüle eder
const useHasHydratedMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useHasHydrated', () => ({
  useHasHydrated: useHasHydratedMock,
}))

// useAuthStore mock — Zustand persist jsdom uyumsuzluk bypass
const { authState } = vi.hoisted(() => {
  const authState: any = { token: null }
  return { authState }
})
vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => (selector ? selector(authState) : authState),
    {
      setState: (patch: any) => Object.assign(authState, patch),
      getState: () => authState,
    },
  ),
}))

// react-i18next mock (ProtectedRouteLoading kullanır)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import React from 'react'
// Test wrapper komponenti — App.tsx ProtectedRoute kopyası (export
// edilmediği için aynı sözleşmeyi yeniden uygular).
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'
import ProtectedRouteLoading from '../ProtectedRouteLoading'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const hydrated = useHasHydrated()
  const token = useAuthStore((s: any) => s.token)
  if (token) return <>{children}</>
  if (!hydrated) return <ProtectedRouteLoading />
  return <Navigate to="/login" replace />
}


function setToken(token: string | null) {
  authState.token = token
}


function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div data-testid="dashboard-children">DASHBOARD_CHILDREN</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div data-testid="login-page">LOGIN_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}


describe('ProtectedRoute — token-first karar matrisi', () => {
  beforeEach(() => {
    setToken(null)
    useHasHydratedMock.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('1) token VAR + hydrated FALSE → children render (KRİTİK production senaryosu)', () => {
    setToken('fake-jwt-token')
    useHasHydratedMock.mockReturnValue(false)
    renderRoute()
    // Children render edilmeli — token store'da var
    expect(screen.getByTestId('dashboard-children')).toBeTruthy()
    // Loading GÖRÜNMEMELI
    expect(screen.queryByTestId('protected-route-loading')).toBeNull()
    // /login navigate OLMAMALI
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('2) token VAR + hydrated TRUE → children render', () => {
    setToken('fake-jwt-token')
    useHasHydratedMock.mockReturnValue(true)
    renderRoute()
    expect(screen.getByTestId('dashboard-children')).toBeTruthy()
    expect(screen.queryByTestId('protected-route-loading')).toBeNull()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('3) token YOK + hydrated FALSE → görünür <ProtectedRouteLoading> (blank YOK)', () => {
    setToken(null)
    useHasHydratedMock.mockReturnValue(false)
    const { container } = renderRoute()
    expect(screen.getByTestId('protected-route-loading')).toBeTruthy()
    // Spin DOM'da
    expect(container.querySelector('.ant-spin')).toBeTruthy()
    // children + login navigate YOK
    expect(screen.queryByTestId('dashboard-children')).toBeNull()
    expect(screen.queryByTestId('login-page')).toBeNull()
    // null DOM YOK
    expect(container.firstChild).toBeTruthy()
  })

  it('4) token YOK + hydrated TRUE → <Navigate to="/login">', () => {
    setToken(null)
    useHasHydratedMock.mockReturnValue(true)
    renderRoute()
    expect(screen.getByTestId('login-page')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-children')).toBeNull()
    expect(screen.queryByTestId('protected-route-loading')).toBeNull()
  })

  it('App.tsx ProtectedRoute KAYNAK kontrolü — token-first sıra korunmuş', () => {
    const fs = require('fs')
    const path = require('path')
    const rawSrc = fs.readFileSync(
      path.resolve(__dirname, '../../App.tsx'),
      'utf-8',
    )
    // Yorumu STRIP et — sadece çalıştırılabilir kod üzerinde regex
    const codeOnly = rawSrc
      .split('\n')
      .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim()))
      .join('\n')
    // function ProtectedRoute içinde `if (token) return <>...</>` daha önce
    expect(codeOnly).toMatch(
      /function ProtectedRoute[\s\S]*?if\s*\(token\)\s*return\s*<>\{children\}<\/>[\s\S]*?if\s*\(!hydrated\)\s*return\s*<ProtectedRouteLoading/,
    )
    // Çalıştırılabilir kodda `if (!hydrated) return null` YOK
    expect(codeOnly).not.toMatch(/function ProtectedRoute[\s\S]*?if\s*\(!hydrated\)\s*return\s*null/)
  })
})
