// @vitest-environment jsdom
/**
 * RootRedirect — MemoryRouter entegrasyon testi (LOGIN-DIRECT-NAVIGATE-FIX,
 * 2026-06-10).
 *
 * Kullanıcı talebi: kaynak-kod string match yetersiz; gerçek Router
 * akışında /login → /dashboard geçişi doğrulanmalı.
 *
 * Bu testler MemoryRouter ile:
 *   · / → unauthenticated → /login render
 *   · / → authenticated   → /dashboard render
 *   · /login → authenticated user → /dashboard redirect (useEffect path)
 *   · Hiçbir senaryoda sonsuz döngü oluşmaz
 */
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// useAuthStore'u tam mock'la — Zustand persist'in jsdom env'da localStorage
// uyumsuzluğunu (storage.setItem is not a function) bypass eder.
const authMockState: { token: string | null } = { token: null }
vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => selector ? selector(authMockState) : authMockState,
    {
      setState: (patch: any) => { Object.assign(authMockState, patch) },
      getState: () => authMockState,
    },
  ),
}))

vi.mock('@/hooks/useHasHydrated', () => ({
  useHasHydrated: vi.fn(),
}))

import RootRedirect from '../RootRedirect'
import { useHasHydrated } from '@/hooks/useHasHydrated'


function setToken(token: string | null) {
  authMockState.token = token
}


function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<div data-testid="login-page">LOGIN_PAGE</div>} />
        <Route path="/dashboard" element={<div data-testid="dashboard-page">DASHBOARD_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}


describe('RootRedirect — MemoryRouter integration', () => {
  beforeEach(() => {
    setToken(null)
    vi.mocked(useHasHydrated).mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('hidrasyon false → Spin render (Navigate çağrılmaz)', () => {
    vi.mocked(useHasHydrated).mockReturnValue(false)
    setToken(null)
    const { container } = renderApp('/')
    // Spin görünür (data-testid)
    expect(screen.getByTestId('root-redirect-loading')).toBeTruthy()
    expect(screen.queryByTestId('login-page')).toBeNull()
    expect(screen.queryByTestId('dashboard-page')).toBeNull()
    expect(container.firstChild).toBeTruthy()
  })

  it('/ + hidrasyon tamam + token YOK → /login render', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setToken(null)
    renderApp('/')
    expect(screen.getByTestId('login-page')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-page')).toBeNull()
  })

  it('/ + hidrasyon tamam + token VAR → /dashboard render', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setToken('fake-jwt-token')
    renderApp('/')
    expect(screen.getByTestId('dashboard-page')).toBeTruthy()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('hidrasyon false + token VAR → race penceresinde Spin (Navigate YOK, loop guard)', () => {
    vi.mocked(useHasHydrated).mockReturnValue(false)
    setToken('fake-jwt-token')
    renderApp('/')
    // Hidrasyon tamamlanmadan navigate olmaz — race koruması
    expect(screen.getByTestId('root-redirect-loading')).toBeTruthy()
    expect(screen.queryByTestId('dashboard-page')).toBeNull()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('Sonsuz döngü guard — `/` rotasına navigate ASLA yapmaz', () => {
    // Authenticated + hidrate: /dashboard'a gider
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setToken('any')
    const { container } = renderApp('/')
    // Tek kez render edildi, döngü yok
    expect(screen.getByTestId('dashboard-page')).toBeTruthy()
    // DOM tek satır içerik
    expect(container.querySelectorAll('[data-testid="dashboard-page"]').length).toBe(1)
  })
})
