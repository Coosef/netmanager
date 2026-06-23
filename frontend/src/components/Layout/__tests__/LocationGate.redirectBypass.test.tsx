// @vitest-environment jsdom
/**
 * P0.1 HOTFIX (2026-06-23) — LocationGate must NOT wrap pure
 * redirect pathnames in the sitesLoading spinner.
 *
 * Before this hotfix, `/dashboard` / `/devices` / `/agents` were
 * legitimately routed to `<LegacyRedirect>` which renders only a
 * `<Navigate>` component. But LocationGate sits OUTSIDE the route's
 * Outlet and unconditionally shows the
 * "Lokasyon bağlamı çözümleniyor…" spinner whenever `sitesLoading`
 * is true. With a 401-looping auth token (the production
 * incident), `sitesLoading` never goes false → LegacyRedirect never
 * mounts → Navigate never fires → operator pinned to the spinner.
 *
 * The fix is structural: LocationGate exits early for these three
 * pathnames so the Outlet (and hence LegacyRedirect's Navigate)
 * always mounts. Real content pages still go through the gate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}))

const siteState: {
  sitesLoading: boolean
  refetchSite: () => void
  hasLocationAccess: boolean
  hasContextFailure: boolean
} = {
  sitesLoading: false,
  refetchSite: vi.fn(),
  hasLocationAccess: true,
  hasContextFailure: false,
}

vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteState,
}))

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: any) => {
    const fake = { user: { id: 1, username: 'admin' } }
    return selector ? selector(fake) : fake
  },
}))

import LocationGate from '../LocationGate'

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route
          path="*"
          element={
            <LocationGate>
              <div data-testid="outlet-child">REAL CONTENT</div>
            </LocationGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  siteState.sitesLoading = false
  siteState.hasContextFailure = false
  siteState.hasLocationAccess = true
  cleanup()
})

describe('LocationGate — P0.1 pure-redirect pathname bypass', () => {
  it.each(['/dashboard', '/devices', '/agents'])(
    'sitesLoading=true + %s → spinner is BYPASSED, children render',
    (pathname) => {
      siteState.sitesLoading = true
      const { getByTestId, queryByTestId } = renderAt(pathname)
      expect(getByTestId('outlet-child')).toBeTruthy()
      expect(queryByTestId('location-gate-error')).toBeNull()
    },
  )

  it.each(['/dashboard', '/devices', '/agents'])(
    'sitesLoading=false + %s → children render (no regression)',
    (pathname) => {
      siteState.sitesLoading = false
      const { getByTestId } = renderAt(pathname)
      expect(getByTestId('outlet-child')).toBeTruthy()
    },
  )

  it('sitesLoading=true + /topology (real content page) → spinner WINS (gate still active)', () => {
    siteState.sitesLoading = true
    const { queryByTestId, container } = renderAt('/topology')
    // Spinner branch — no outlet-child
    expect(queryByTestId('outlet-child')).toBeNull()
    // AntD Spin renders inside the gate; just check the workspace
    // wrapper rendered the spin block, not the bypass children.
    expect(container.querySelector('[role="status"], .ant-spin')).toBeTruthy()
  })

  it('sitesLoading=true + /app/org/6/devices (operations panel page) → spinner WINS', () => {
    siteState.sitesLoading = true
    const { queryByTestId, container } = renderAt('/app/org/6/devices')
    expect(queryByTestId('outlet-child')).toBeNull()
    expect(container.querySelector('[role="status"], .ant-spin')).toBeTruthy()
  })

  it('hasContextFailure=true + /dashboard → bypass still wins (redirect priority over error UI)', () => {
    // The redirect to /app/org/<id>/dashboard is short-lived and the
    // real error UI lives at the destination. The bypass short-circuits
    // BEFORE any error branch.
    siteState.sitesLoading = false
    siteState.hasContextFailure = true
    const { getByTestId, queryByTestId } = renderAt('/dashboard')
    expect(getByTestId('outlet-child')).toBeTruthy()
    expect(queryByTestId('location-gate-error')).toBeNull()
  })
})


describe('LocationGate — source-level pins', () => {
  it('LEGACY_PURE_REDIRECT_PATHS includes the 3 routes', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../LocationGate.tsx'), 'utf-8')
    expect(src).toMatch(/'\/dashboard'/)
    expect(src).toMatch(/'\/devices'/)
    expect(src).toMatch(/'\/agents'/)
    expect(src).toContain('LEGACY_PURE_REDIRECT_PATHS')
  })

  it('bypass branch fires BEFORE sitesLoading check (early-return order)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../LocationGate.tsx'), 'utf-8')
    const codeOnly = src.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const bypassIdx = codeOnly.indexOf('LEGACY_PURE_REDIRECT_PATHS.has(')
    const loadingIdx = codeOnly.indexOf('if (sitesLoading)')
    expect(bypassIdx).toBeGreaterThan(0)
    expect(loadingIdx).toBeGreaterThan(0)
    expect(bypassIdx).toBeLessThan(loadingIdx)
  })
})
