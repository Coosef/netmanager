// @vitest-environment jsdom
/**
 * PR #96 — LocationSelector role-aware UX states.
 *
 * The selector must render seven distinct visual states and must NEVER
 * render the retired `location_selector.none_defined` ("No location
 * defined") string. The `useSite()` consumer is mocked per-test so each
 * state is exercised in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import LocationSelector from '../LocationSelector'

// ─── Mocks ─────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}))

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDark: false }),
}))

const siteState: {
  activeLocationId: number | null
  setLocation: ReturnType<typeof vi.fn>
  locations: { id: number; name: string; color: string | null; city: null; country: null; device_count: number }[]
  sitesLoading: boolean
  hasContextFailure: boolean
  hasLocationAccess: boolean
  isOrgWide: boolean
  isSuperAdmin: boolean
  organization: { id: number; name: string; slug: string } | null
} = {
  activeLocationId: null,
  setLocation: vi.fn(),
  locations: [],
  sitesLoading: false,
  hasContextFailure: false,
  hasLocationAccess: true,
  isOrgWide: false,
  isSuperAdmin: false,
  organization: null,
}

vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteState,
}))

function resetSiteState() {
  siteState.activeLocationId = null
  siteState.setLocation = vi.fn()
  siteState.locations = []
  siteState.sitesLoading = false
  siteState.hasContextFailure = false
  siteState.hasLocationAccess = true
  siteState.isOrgWide = false
  siteState.isSuperAdmin = false
  siteState.organization = null
}

beforeEach(() => {
  resetSiteState()
  // @ts-ignore
  if (!window.matchMedia) {
    // @ts-ignore
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => {
  cleanup()
})


// ─── State priority ─────────────────────────────────────────────────────


describe('LocationSelector — seven states', () => {
  it('(1) loading → spinner + loading text', () => {
    siteState.sitesLoading = true
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-loading')).toBeTruthy()
    expect(screen.getByText('location_selector.loading')).toBeTruthy()
  })

  it('(2) hasContextFailure → error tag', () => {
    siteState.hasContextFailure = true
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-error')).toBeTruthy()
    expect(screen.getByText('location_selector.error_tag')).toBeTruthy()
  })

  it('(3) super-admin + no organization → tenant-required tag', () => {
    siteState.isSuperAdmin = true
    siteState.organization = null
    siteState.isOrgWide = true
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-tenant-required')).toBeTruthy()
    expect(screen.getByText('location_selector.tenant_required_tag')).toBeTruthy()
  })

  it('(4) hasLocationAccess=false → no-access tag', () => {
    siteState.hasLocationAccess = false
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-no-access')).toBeTruthy()
    expect(screen.getByText('location_selector.no_access_tag')).toBeTruthy()
  })

  it('(5) tenant set but locations empty → no-assigned tag', () => {
    siteState.isSuperAdmin = true
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.locations = []
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-no-assigned')).toBeTruthy()
    expect(screen.getByText('location_selector.no_assigned_tag')).toBeTruthy()
  })

  it('(6) exactly one location for a scoped user → static text', () => {
    siteState.locations = [{ id: 7, name: 'Istanbul', color: '#22c55e', city: null, country: null, device_count: 4 }]
    siteState.activeLocationId = 7
    siteState.isOrgWide = false
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-single')).toBeTruthy()
    expect(screen.getByText('Istanbul')).toBeTruthy()
  })

  it('(7) multiple locations → switcher', () => {
    siteState.locations = [
      { id: 1, name: 'Istanbul', color: '#22c55e', city: null, country: null, device_count: 4 },
      { id: 2, name: 'Ankara',  color: '#3b82f6', city: null, country: null, device_count: 2 },
    ]
    siteState.activeLocationId = 1
    siteState.isOrgWide = true
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-multi')).toBeTruthy()
  })

  it('priority — loading wins over every later state', () => {
    siteState.sitesLoading = true
    siteState.hasContextFailure = true
    siteState.isSuperAdmin = true
    siteState.organization = null
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-loading')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-error')).toBeNull()
    expect(screen.queryByTestId('location-selector-tenant-required')).toBeNull()
  })

  it('priority — error wins over tenant-required and no-assigned', () => {
    siteState.hasContextFailure = true
    siteState.isSuperAdmin = true
    siteState.organization = null
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-error')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-tenant-required')).toBeNull()
  })
})


// ─── Retired string must not appear ──────────────────────────────────────


describe('LocationSelector — retired `none_defined` string is no longer surfaced', () => {
  const states: { name: string; setup: () => void }[] = [
    {
      name: 'super-admin + no org',
      setup: () => {
        siteState.isSuperAdmin = true
        siteState.organization = null
      },
    },
    {
      name: 'super-admin + org + no locations',
      setup: () => {
        siteState.isSuperAdmin = true
        siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
        siteState.locations = []
      },
    },
    {
      name: 'scoped user + hasLocationAccess=false',
      setup: () => {
        siteState.hasLocationAccess = false
      },
    },
    {
      name: 'org_admin + tenant + no locations',
      setup: () => {
        siteState.isOrgWide = true
        siteState.locations = []
      },
    },
  ]

  for (const s of states) {
    it(`[${s.name}] does NOT render location_selector.none_defined`, () => {
      s.setup()
      render(<LocationSelector />)
      expect(screen.queryByText('location_selector.none_defined')).toBeNull()
    })
  }
})


// ─── i18n keys present in all four locales ──────────────────────────────


describe('LocationSelector — new i18n keys exist in every locale', () => {
  const REQUIRED_KEYS = [
    'loading',
    'error_tag',
    'error_tooltip',
    'tenant_required_tag',
    'tenant_required_tooltip',
    'no_assigned_tag',
  ] as const
  const LOCALES = ['tr', 'en', 'de', 'ru'] as const

  for (const lang of LOCALES) {
    for (const key of REQUIRED_KEYS) {
      it(`[${lang}] location_selector.${key} is a non-empty string`, async () => {
        const raw = await import(`@/i18n/locales/${lang}.json`)
        const sel = (raw.default as Record<string, Record<string, string>>).location_selector
        expect(typeof sel?.[key]).toBe('string')
        expect((sel?.[key] ?? '').length).toBeGreaterThan(0)
      })
    }
  }
})
