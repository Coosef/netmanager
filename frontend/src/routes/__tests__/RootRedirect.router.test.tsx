// @vitest-environment jsdom
/**
 * RootRedirect — MemoryRouter entegrasyon testi.
 *
 * PR-A (2026-06-22) — RootRedirect rolü gözeten matrise dönüştürüldü.
 * Eski "her authenticated user /dashboard'a gider" sözleşmesi kalktı;
 * yerine:
 *   super_admin       → /platform/overview
 *   normal + org_id   → /app/org/<id>/dashboard
 *
 * Bu testler MemoryRouter ile gerçek Router akışını doğrular ve
 * LOGIN-DIRECT-NAVIGATE-FIX'in (2026-06-10) blank screen guard
 * sözleşmesini koruur (token-first matris).
 */
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// useAuthStore'u tam mock'la — Zustand persist'in jsdom env'da localStorage
// uyumsuzluğunu (storage.setItem is not a function) bypass eder.
type MockUser = {
  id: number
  username: string
  role: string
  system_role: string
  org_id?: number | null
} | null

interface AuthMockState {
  token: string | null
  user: MockUser
}

const authMockState: AuthMockState = { token: null, user: null }

vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => (selector ? selector(authMockState) : authMockState),
    {
      setState: (patch: any) => { Object.assign(authMockState, patch) },
      getState: () => authMockState,
    },
  ),
}))

vi.mock('@/hooks/useHasHydrated', () => ({
  useHasHydrated: vi.fn(),
}))

// PR-A — RootRedirect now also reads useSite() for ctxResolved + activeOrgId
// + isPlatformSuperAdmin. Mock with sane defaults; per-test overrides set
// the relevant fields.
const siteMockState: {
  ctxResolved: boolean
  activeOrgId: number | null
  isPlatformSuperAdmin: boolean
} = {
  ctxResolved: true,
  activeOrgId: null,
  isPlatformSuperAdmin: false,
}

vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteMockState,
}))

import RootRedirect from '../RootRedirect'
import { useHasHydrated } from '@/hooks/useHasHydrated'


function setAuth(token: string | null, user: MockUser = null) {
  authMockState.token = token
  authMockState.user = user
}

function setSite(patch: Partial<typeof siteMockState>) {
  Object.assign(siteMockState, patch)
}

function makeUser(role: 'super_admin' | 'org_admin' | 'viewer', orgId: number | null = 6): MockUser {
  return {
    id: 1,
    username: 'test',
    role,
    system_role: role,
    org_id: orgId,
  }
}


function renderApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<div data-testid="login-page">LOGIN_PAGE</div>} />
        <Route path="/platform/overview" element={<div data-testid="platform-overview-page">PLATFORM_OVERVIEW</div>} />
        <Route path="/app/org/:organizationId/dashboard" element={<div data-testid="org-dashboard">ORG_DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  )
}


describe('RootRedirect — MemoryRouter integration (PR-A role-based)', () => {
  beforeEach(() => {
    setAuth(null, null)
    setSite({ ctxResolved: true, activeOrgId: null, isPlatformSuperAdmin: false })
    vi.mocked(useHasHydrated).mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('1) token YOK + hidrasyon FALSE → görünür Spin (Navigate çağrılmaz)', () => {
    vi.mocked(useHasHydrated).mockReturnValue(false)
    setAuth(null, null)
    const { container } = renderApp('/')
    expect(screen.getByTestId('root-redirect-loading')).toBeTruthy()
    expect(screen.queryByTestId('login-page')).toBeNull()
    expect(screen.queryByTestId('platform-overview-page')).toBeNull()
    expect(container.firstChild).toBeTruthy()
  })

  it('2) token YOK + hidrasyon TRUE → /login render', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setAuth(null, null)
    renderApp('/')
    expect(screen.getByTestId('login-page')).toBeTruthy()
    expect(screen.queryByTestId('platform-overview-page')).toBeNull()
  })

  it('3) super_admin + hidrate + ctxResolved → /platform/overview', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setAuth('fake-jwt-token', makeUser('super_admin', null))
    setSite({ ctxResolved: true, isPlatformSuperAdmin: true })
    renderApp('/')
    expect(screen.getByTestId('platform-overview-page')).toBeTruthy()
    expect(screen.queryByTestId('org-dashboard')).toBeNull()
  })

  it('4) normal user + org_id + hidrate + ctxResolved → /app/org/<id>/dashboard', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setAuth('fake-jwt-token', makeUser('org_admin', 6))
    setSite({ ctxResolved: true, isPlatformSuperAdmin: false })
    renderApp('/')
    expect(screen.getByTestId('org-dashboard')).toBeTruthy()
    expect(screen.queryByTestId('platform-overview-page')).toBeNull()
  })

  it('5) token VAR + ctxResolved FALSE → görünür Spin (blank YOK)', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setAuth('fake-jwt-token', makeUser('org_admin', 6))
    setSite({ ctxResolved: false })
    renderApp('/')
    expect(screen.getByTestId('root-redirect-loading')).toBeTruthy()
    expect(screen.queryByTestId('org-dashboard')).toBeNull()
  })

  it('6) token VAR + user mevcut + ctxResolved + hidrasyon FALSE → render eder (token-first matris)', () => {
    // PR #73 token-first contract: token+user mevcutsa Zustand persist
    // hidrasyon flag'inden BAĞIMSIZ render. hydrated kullanıcı YOK senaryosunda
    // sadece login için kullanılır.
    vi.mocked(useHasHydrated).mockReturnValue(false)
    setAuth('fake-jwt-token', makeUser('org_admin', 6))
    setSite({ ctxResolved: true })
    renderApp('/')
    expect(screen.getByTestId('org-dashboard')).toBeTruthy()
  })

  it('Sonsuz döngü guard — `/` rotasına navigate ASLA yapmaz', () => {
    vi.mocked(useHasHydrated).mockReturnValue(true)
    setAuth('fake-jwt-token', makeUser('org_admin', 6))
    setSite({ ctxResolved: true })
    const { container } = renderApp('/')
    expect(screen.getByTestId('org-dashboard')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="org-dashboard"]').length).toBe(1)
  })
})
