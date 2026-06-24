// @vitest-environment jsdom
/**
 * P0.2 PLATFORM RECOVERY (2026-06-24) — PlatformShell three-state UI.
 *
 * Pre-fix behavior: `if (!ctxResolved) return null` produced a fully
 * empty DOM whenever ctx was undefined. Combined with the hydration
 * race, an operator hard-refreshing /platform/organizations saw a
 * permanently blank page with no spinner, no error, no retry button.
 *
 * Post-fix behavior:
 *   1. sitesLoading=true       → visible Spin with platform.shell.loading
 *   2. hasContextFailure=true  → Result + Yenile button (refetchSite)
 *   3. ctx ready + super_admin → Outlet renders
 *   4. ctx ready + non-super   → Navigate to "/"
 *
 * Banner i18n keys are platform-specific (`platform.shell.*`) so the
 * platform panel doesn't borrow operations-themed location_gate copy.
 */
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const authState: { user: any } = { user: null }
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: any) => selector ? selector(authState) : authState,
}))

const siteState: {
  ctxResolved: boolean
  isPlatformSuperAdmin: boolean
  sitesLoading: boolean
  hasContextFailure: boolean
  refetchSite: () => void
} = {
  ctxResolved: false,
  isPlatformSuperAdmin: false,
  sitesLoading: false,
  hasContextFailure: false,
  refetchSite: vi.fn(),
}
vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteState,
}))

import PlatformShell from '../PlatformShell'

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/platform/overview']}>
      <Routes>
        <Route path="platform" element={<PlatformShell />}>
          <Route path="overview" element={<div data-testid="platform-outlet">OUTLET</div>} />
        </Route>
        <Route path="/" element={<div data-testid="root-redirect">/</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function reset() {
  authState.user = null
  siteState.ctxResolved = false
  siteState.isPlatformSuperAdmin = false
  siteState.sitesLoading = false
  siteState.hasContextFailure = false
  siteState.refetchSite = vi.fn()
}

beforeEach(reset)
afterEach(cleanup)

describe('PlatformShell — P0.2 three-state UI', () => {
  it('State 1: sitesLoading=true → visible spinner (NOT blank)', () => {
    authState.user = { id: 1, system_role: 'super_admin' }
    siteState.sitesLoading = true
    const { container } = renderShell()
    expect(screen.getByTestId('platform-shell-loading')).toBeTruthy()
    expect(container.querySelector('.ant-spin')).toBeTruthy()
    expect(screen.queryByTestId('platform-outlet')).toBeNull()
    expect(container.firstChild).toBeTruthy()   // DOM is NOT empty
  })

  it('State 2: hasContextFailure=true → Result + Yenile button', () => {
    authState.user = { id: 1, system_role: 'super_admin' }
    siteState.hasContextFailure = true
    const { container } = renderShell()
    expect(screen.getByTestId('platform-shell-error')).toBeTruthy()
    // Result component visible
    expect(container.querySelector('.ant-result')).toBeTruthy()
    // Yenile button text rendered (i18n mock returns key literally)
    expect(screen.getByText('platform.shell.retry')).toBeTruthy()
    expect(screen.getByText('platform.shell.error_title')).toBeTruthy()
  })

  it('State 2: Yenile button click → refetchSite() called exactly once', () => {
    authState.user = { id: 1, system_role: 'super_admin' }
    siteState.hasContextFailure = true
    const spy = vi.fn()
    siteState.refetchSite = spy
    renderShell()
    const errorEl = screen.getByTestId('platform-shell-error')
    const btn = errorEl.querySelector('button')
    expect(btn).toBeTruthy()
    fireEvent.click(btn!)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('State 3a: ctx ready + super_admin role → Outlet renders', () => {
    authState.user = { id: 1, system_role: 'super_admin' }
    siteState.ctxResolved = true
    renderShell()
    expect(screen.getByTestId('platform-outlet')).toBeTruthy()
    expect(screen.queryByTestId('platform-shell-loading')).toBeNull()
    expect(screen.queryByTestId('platform-shell-error')).toBeNull()
  })

  it('State 3b: ctx ready + non-super-admin → Navigate to "/"', () => {
    authState.user = { id: 6, system_role: 'org_admin' }
    siteState.ctxResolved = true
    siteState.isPlatformSuperAdmin = false
    renderShell()
    expect(screen.getByTestId('root-redirect')).toBeTruthy()
    expect(screen.queryByTestId('platform-outlet')).toBeNull()
  })

  it('State 3c: ctx ready + scoped super_admin (isPlatformSuperAdmin=true, system_role!=super_admin) → Outlet', () => {
    // Scoped super-admin (X-Org-Id active) has is_super_admin=false at
    // backend but system_role='super_admin'. Role-identity guard lets
    // them in.
    authState.user = { id: 1, system_role: 'super_admin' }
    siteState.ctxResolved = true
    siteState.isPlatformSuperAdmin = false  // backend echo says no
    renderShell()
    // user.system_role==='super_admin' alone passes the guard
    expect(screen.getByTestId('platform-outlet')).toBeTruthy()
  })

  it('Pre-token: user null → renders nothing (ProtectedRoute owns this case upstream)', () => {
    authState.user = null
    const { container } = renderShell()
    expect(container.firstChild).toBeNull()
  })
})

// ─── Source-level pins ─────────────────────────────────────────────────

describe('PlatformShell — P0.2 source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../PlatformShell.tsx'),
    'utf-8',
  )
  const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

  it('three test-ids present for the three visible states', () => {
    expect(SRC).toContain('data-testid="platform-shell-loading"')
    expect(SRC).toContain('data-testid="platform-shell-error"')
  })

  it('reads sitesLoading, hasContextFailure, refetchSite from useSite()', () => {
    expect(SRC).toMatch(/useSite\(\)/)
    expect(SRC).toMatch(/sitesLoading/)
    expect(SRC).toMatch(/hasContextFailure/)
    expect(SRC).toMatch(/refetchSite/)
  })

  it('error branch wires refetchSite to retry button onClick', () => {
    expect(SRC).toMatch(/onClick=\{\(\)\s*=>\s*refetchSite\(\)\}/)
  })

  it('loading + error branches use platform.shell.* i18n keys', () => {
    expect(SRC).toMatch(/t\('platform\.shell\.loading'\)/)
    expect(SRC).toMatch(/t\('platform\.shell\.error_title'\)/)
    expect(SRC).toMatch(/t\('platform\.shell\.error_desc'\)/)
    expect(SRC).toMatch(/t\('platform\.shell\.retry'\)/)
  })

  it('NO blank-page paths: sitesLoading branch returns a Spin, error branch returns Result', () => {
    // sitesLoading branch contains <Spin
    expect(codeOnly).toMatch(/if\s*\(sitesLoading\)[\s\S]{0,400}<Spin/)
    // hasContextFailure branch contains <Result
    expect(codeOnly).toMatch(/if\s*\(hasContextFailure\)[\s\S]{0,400}<Result/)
  })

  it('P0.2 STRICT — no `if (!ctxResolved) return null` fallback anywhere in the file', () => {
    // Operator's verbatim contract: the previous defensive fallback
    // must be GONE from PlatformShell entirely. The three-state UI
    // (loading / error / ready) is the only acceptable shape for the
    // platform panel; any future regression that re-introduces the
    // null fallback would resurrect the production blank-page risk.
    expect(codeOnly).not.toMatch(/if\s*\(!ctxResolved\)\s*return\s+null/)
    // Defense-in-depth: `ctxResolved` should no longer be destructured
    // from useSite() in the runtime code path either — keeping it
    // around invites a future reintroduction.
    const destructureMatch = codeOnly.match(/const\s*\{\s*([^}]+)\}\s*=\s*useSite\(\)/)
    expect(destructureMatch).toBeTruthy()
    expect(destructureMatch![1]).not.toContain('ctxResolved')
  })

  it('P0.2 STRICT — only three reachable return paths plus user==null pre-token guard', () => {
    // Pin the return-paths inventory so a future contributor cannot
    // silently re-add a hidden `return null` for ctx-undefined.
    // Exhaustive list of acceptable `return` statements in this file:
    //   1. `if (user == null) return null` — pre-token guard
    //      (ProtectedRoute upstream is the canonical owner of this
    //      window; PlatformShell yielding null here is allowed)
    //   2. sitesLoading → return <div…><Spin…/></div>
    //   3. hasContextFailure → return <div…><Result…/></div>
    //   4. non-super → return <Navigate to="/" replace />
    //   5. default → return <Outlet />
    const returnNullMatches = (codeOnly.match(/return\s+null/g) ?? []).length
    // Exactly ONE `return null` — the user==null pre-token guard.
    expect(returnNullMatches).toBe(1)
    // The single null path must be gated on user==null, not ctx.
    expect(codeOnly).toMatch(/if\s*\(user\s*==\s*null\)\s*return\s+null/)
  })
})

// ─── i18n key parity (4 locales) ───────────────────────────────────────

describe('PlatformShell — platform.shell.* i18n keys exist in all 4 locales', () => {
  it.each(['tr', 'en', 'de', 'ru'])('locale %s has platform.shell with 4 keys', (lang) => {
    const json = readFileSync(
      resolve(__dirname, `../../i18n/locales/${lang}.json`),
      'utf-8',
    )
    const obj = JSON.parse(json)
    const shell = obj.platform?.shell
    expect(shell).toBeTruthy()
    expect(shell.loading).toBeTruthy()
    expect(shell.error_title).toBeTruthy()
    expect(shell.error_desc).toBeTruthy()
    expect(shell.retry).toBeTruthy()
  })
})
