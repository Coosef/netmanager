// @vitest-environment jsdom
/**
 * LocationGate — DOM render senaryoları (LOGIN-DIRECT-NAVIGATE-FIX, 2026-06-10).
 *
 * Davranış matrisi (kullanıcı talebi):
 *   1. sitesLoading=true                                 → görünür Spin
 *   2. ctx mevcut                                        → children render
 *   3. sitesError=true && !ctx                           → görünür Result + Yenile
 *   4. !sitesLoading && !ctx (idle stuck)                → görünür Result + Yenile
 *   5. Retry butonu click → refetchSite() tam 1 kez çağrılır
 *   6. Hiçbir senaryoda boş/null DOM dönmez
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

// react-i18next mock'lu — jsdom env'da i18n/index.ts modülünün localStorage
// erişimini bypass eder. Test'ler key string'leri ile çalışır.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import LocationGate from '../LocationGate'

// SiteContext'in tüm hook'unu mock'la — testler context state'i serbestçe
// kontrol eder.
const mockSite = {
  sitesLoading: false,
  sitesError: false,
  hasContextFailure: false,
  refetchSite: vi.fn(),
  hasLocationAccess: true,
  activeLocationId: null,
  setLocation: vi.fn(),
  locations: [],
  allowedLocationIds: [],
  isOrgWide: false,
  features: {},
  activeSite: null,
  setSite: vi.fn(),
  sites: [],
}

vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => mockSite,
}))

// Auth store (NoLocationAccess logout butonu için)
vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    () => ({ logout: vi.fn() }),
    { getState: () => ({ logout: vi.fn() }) },
  ),
}))


function setSite(partial: Partial<typeof mockSite>) {
  Object.assign(mockSite, partial)
}

function reset() {
  Object.assign(mockSite, {
    sitesLoading: false,
    sitesError: false,
    hasContextFailure: false,
    refetchSite: vi.fn(),
    hasLocationAccess: true,
  })
}


function renderGate(children: React.ReactNode = <div data-testid="child">CHILD</div>) {
  // P0.1 — LocationGate now reads useLocation() to bypass pure-redirect
  // pathnames. Tests must wrap in MemoryRouter so the hook resolves.
  // Use a non-bypass pathname here so the rest of the gate's branches
  // still get exercised (the bypass cases live in
  // LocationGate.redirectBypass.test.tsx).
  return render(
    <MemoryRouter initialEntries={['/topology']}>
      <LocationGate>{children}</LocationGate>
    </MemoryRouter>,
  )
}


describe('LocationGate — render davranış matrisi', () => {
  beforeEach(() => {
    reset()
  })

  afterEach(() => {
    cleanup()
  })

  it('1) sitesLoading=true → görünür Spin (blank YOK)', () => {
    setSite({ sitesLoading: true })
    const { container } = renderGate()
    // AntD Spin — sınıfla yakala
    expect(container.querySelector('.ant-spin')).toBeTruthy()
    expect(screen.queryByTestId('child')).toBeNull()
    expect(screen.queryByTestId('location-gate-error')).toBeNull()
    // DOM boş değil — minimum bir element render edildi
    expect(container.firstChild).toBeTruthy()
  })

  it('2) ctx mevcut (default state) → children render', () => {
    setSite({ sitesLoading: false, hasContextFailure: false })
    renderGate()
    expect(screen.getByTestId('child')).toBeTruthy()
    expect(screen.queryByTestId('location-gate-error')).toBeNull()
  })

  it('3) sitesError=true && !ctx (hasContextFailure=true) → görünür Result + Yenile', () => {
    setSite({ sitesError: true, hasContextFailure: true })
    renderGate()
    expect(screen.getByTestId('location-gate-error')).toBeTruthy()
    // Result content render edildi (i18n key resolve oldu)
    const errorEl = screen.getByTestId('location-gate-error')
    expect(errorEl.textContent).toBeTruthy()
    expect(errorEl.textContent!.length).toBeGreaterThan(0)
    // children render YAPMAZ
    expect(screen.queryByTestId('child')).toBeNull()
  })

  it('4) !sitesLoading && !ctx (idle stuck, hasContextFailure=true) → görünür Result + Yenile', () => {
    // sitesError false AMA hasContextFailure true (idle + ctx undefined)
    setSite({ sitesLoading: false, sitesError: false, hasContextFailure: true })
    renderGate()
    expect(screen.getByTestId('location-gate-error')).toBeTruthy()
    expect(screen.queryByTestId('child')).toBeNull()
  })

  it('5) Yenile butonu click → refetchSite() tam 1 kez çağrılır', () => {
    const refetchMock = vi.fn()
    setSite({ hasContextFailure: true, refetchSite: refetchMock })
    renderGate()
    const errorEl = screen.getByTestId('location-gate-error')
    // Yenile butonu i18n resolve edildi → role=button
    const button = errorEl.querySelector('button')
    expect(button).toBeTruthy()
    fireEvent.click(button!)
    expect(refetchMock).toHaveBeenCalledTimes(1)
  })

  it('6) Hiçbir senaryoda null/empty DOM dönmez', () => {
    const scenarios = [
      { sitesLoading: true },
      { hasContextFailure: false }, // children render
      { hasContextFailure: true },
      { hasLocationAccess: false }, // NoLocationAccess
    ]
    for (const s of scenarios) {
      reset()
      setSite(s)
      const { container, unmount } = renderGate()
      expect(container.firstChild).toBeTruthy()
      expect(container.innerHTML.length).toBeGreaterThan(0)
      unmount()
    }
  })
})
