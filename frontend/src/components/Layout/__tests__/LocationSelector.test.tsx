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
  /** SITE-CONTEXT-HYDRATION-GUARD v2 (2026-06-19) — `!!ctx`. Tests
   * that exercise branches 3+ MUST set this to `true` so the new
   * transient guard in branch 1 lets them through. Branches 1 (loading)
   * and 2 (error) win regardless of `ctxResolved`. */
  ctxResolved: boolean
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
  ctxResolved: true,
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
  siteState.ctxResolved = true
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

  it('(5a) super_admin + tenant set + locations empty → neutral "All locations" (NOT no-assigned)', () => {
    // Post-deploy hotfix — super_admin must never see the alarming
    // "No assigned location" warning, since their reach is the
    // platform, not a `user_locations` row. The neutral
    // `all_locations` tag is the correct surface here.
    siteState.isSuperAdmin = true
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.locations = []
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-super-admin-empty')).toBeTruthy()
    expect(screen.getByText('location_selector.all_locations')).toBeTruthy()
    // The alarming no-assigned tag MUST NOT render for a super-admin.
    expect(screen.queryByTestId('location-selector-no-assigned')).toBeNull()
  })

  it('(5b) NON super_admin + tenant set + locations empty → no-assigned tag', () => {
    siteState.isSuperAdmin = false
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


// ─── SITE-CONTEXT-HYDRATION-GUARD v2 transient cases ───────────────────


describe('LocationSelector — transient ctx-undefined guard (v2)', () => {
  // Operator-observed (2026-06-19) console fragment during a location
  // switch:
  //   [SiteContext] {ctx_present: false, tokenPresent: false,
  //                  sitesLoading: false, hydrated: true, ...}
  // Without the v2 guard, branch 5 would fire ("no_assigned_tag" /
  // orange warning) for a single render before the next state lands.
  // The v2 patch widens branch 1 to ALSO fire when `!ctxResolved &&
  // !hasContextFailure`.

  it('(1+) ctxResolved=false + sitesLoading=false + no failure → spinner (transient guard)', () => {
    siteState.sitesLoading = false
    siteState.ctxResolved = false
    siteState.hasContextFailure = false
    siteState.locations = []
    siteState.isSuperAdmin = false
    render(<LocationSelector />)
    // Spinner wins; the alarming no_assigned warning MUST NOT render.
    expect(screen.getByTestId('location-selector-loading')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-no-assigned')).toBeNull()
  })

  it('(1+) ctxResolved=false + super_admin shape + no failure → spinner (NOT tenant-required)', () => {
    // The super_admin transient is the operator-confirmed scenario:
    // ctx is briefly undefined → isSuperAdmin defaults to false →
    // tenantMissing also defaults to false → previously fell through
    // to branch 5. v2 guard fires branch 1 spinner instead.
    siteState.sitesLoading = false
    siteState.ctxResolved = false
    siteState.hasContextFailure = false
    siteState.locations = []
    siteState.isSuperAdmin = false   // transient default
    siteState.organization = null    // transient default
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-loading')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-no-assigned')).toBeNull()
    expect(screen.queryByTestId('location-selector-tenant-required')).toBeNull()
  })

  it('(2 over 1+) hasContextFailure=true + ctxResolved=false → error tag wins (v2 guard yields)', () => {
    // The transient guard MUST NOT mask a real fetch failure as
    // "still loading" — `hasContextFailure` short-circuits the new
    // branch-1 clause so users actually see the retryable error.
    siteState.sitesLoading = false
    siteState.ctxResolved = false
    siteState.hasContextFailure = true
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-error')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-loading')).toBeNull()
  })

  it('(7 over 1+) ctxResolved=true → guard releases → multi switcher fires normally', () => {
    // Sanity: once ctx is resolved the transient guard is OFF and the
    // existing branches resume — no regression on the happy path.
    siteState.sitesLoading = false
    siteState.ctxResolved = true
    siteState.locations = [
      { id: 1, name: 'Istanbul', color: '#22c55e', city: null, country: null, device_count: 4 },
      { id: 2, name: 'Ankara',  color: '#3b82f6', city: null, country: null, device_count: 2 },
    ]
    siteState.activeLocationId = 1
    siteState.isOrgWide = true
    siteState.isSuperAdmin = true
    siteState.organization = { id: 1, name: 'Varsayılan Organizasyon', slug: 'default' }
    render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-multi')).toBeTruthy()
    expect(screen.queryByTestId('location-selector-loading')).toBeNull()
  })

  it('transient → resolved transition: spinner first, multi switcher after', () => {
    // Stand-in for the React render-cycle transition the operator saw.
    siteState.sitesLoading = false
    siteState.ctxResolved = false
    siteState.locations = []
    const { rerender } = render(<LocationSelector />)
    expect(screen.getByTestId('location-selector-loading')).toBeTruthy()

    // After the next backend tick, ctx lands.
    siteState.ctxResolved = true
    siteState.locations = [
      { id: 1, name: 'Istanbul', color: null, city: null, country: null, device_count: 0 },
      { id: 2, name: 'Ankara',  color: null, city: null, country: null, device_count: 0 },
    ]
    siteState.isOrgWide = true
    siteState.isSuperAdmin = true
    siteState.organization = { id: 1, name: 'Varsayılan Organizasyon', slug: 'default' }
    rerender(<LocationSelector />)
    expect(screen.queryByTestId('location-selector-loading')).toBeNull()
    expect(screen.getByTestId('location-selector-multi')).toBeTruthy()
    // The brief transient never committed to the warning state.
    expect(screen.queryByTestId('location-selector-no-assigned')).toBeNull()
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
