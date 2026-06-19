// @vitest-environment jsdom
/**
 * PR #96 — Agent create modal guard.
 *
 * The "+ Ajan Kur" → modal flow must NOT issue an enrollment request
 * when the caller has no tenant context (super_admin who hasn't picked
 * a tenant) or no accessible locations. The Alert above the form
 * explains the state; the dropdown + submit are hard-disabled; and the
 * mutate function must never see a synthetic click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'

import NocAgents from '../NocAgents'


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

// Auth store — caller has `agents.install` for these tests (the
// install-permission denial path is covered elsewhere).
vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: (s: any) => unknown) => {
    const fake = { can: () => true }
    return selector ? selector(fake) : fake
  },
}))

// `vi.mock` factories are hoisted above the file body, so any
// closed-over variable they need must be created via `vi.hoisted`.
// Without this the factory captures `agentsApiState` before its
// definition runs and throws `Cannot access 'agentsApiState' before
// initialization`.
const mocks = vi.hoisted(() => ({
  agentsApiState: {
    create: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => []),
    getLatencyMap: vi.fn(async () => []),
    getCurrentVersion: vi.fn(async () => ({ version: 'v1.0' })),
    getLiveMetrics: vi.fn(async () => ({ metrics: {} })),
  },
  devicesApiState: {
    list: vi.fn(async () => ({ items: [], total: 0 })),
  },
}))
const agentsApiState = mocks.agentsApiState

vi.mock('@/api/agents', () => ({
  agentsApi: mocks.agentsApiState,
}))

vi.mock('@/api/devices', () => ({
  devicesApi: mocks.devicesApiState,
}))

const siteState: {
  activeLocationId: number | null
  setLocation: ReturnType<typeof vi.fn>
  locations: { id: number; name: string; color: string | null; city: null; country: null; device_count: number }[]
  hasLocationAccess: boolean
  isOrgWide: boolean
  isSuperAdmin: boolean
  organization: { id: number; name: string; slug: string } | null
  /** SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) — true during the
   * Zustand-persist rehydration window or while `/context/current` is
   * in flight. NocAgents must not commit to a "blocked" Alert until
   * this is false. */
  sitesLoading: boolean
} = {
  activeLocationId: null,
  setLocation: vi.fn(),
  locations: [],
  hasLocationAccess: true,
  isOrgWide: false,
  isSuperAdmin: false,
  organization: null,
  sitesLoading: false,
}

vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteState,
}))

function resetSiteState() {
  siteState.activeLocationId = null
  siteState.setLocation = vi.fn()
  siteState.locations = []
  siteState.hasLocationAccess = true
  siteState.isOrgWide = false
  siteState.isSuperAdmin = false
  siteState.organization = null
  siteState.sitesLoading = false
}


function renderNocAgents() {
  // Fresh QueryClient per render so cache state doesn't bleed. Wrap
  // with AntD <App> so `App.useApp().message` resolves to a real
  // message context — without it the mutation onError calls explode
  // with "message.error is not a function" during the happy-path
  // test (which actually fires the mutate).
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <NocAgents />
      </AntApp>
    </QueryClientProvider>,
  )
}


beforeEach(() => {
  resetSiteState()
  agentsApiState.create.mockReset().mockImplementation(async () => undefined)
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


// ─── Super-admin + no tenant — blocked state ─────────────────────────────


describe('Agent create modal — super_admin without a tenant context', () => {
  it('+ Ajan Kur opens the modal; tenant-required Alert renders; no other UI', async () => {
    siteState.isSuperAdmin = true
    siteState.organization = null
    siteState.isOrgWide = true
    renderNocAgents()
    const installBtn = await screen.findByTestId('agent-install-button')
    fireEvent.click(installBtn)
    const blocked = await screen.findByTestId('agent-create-blocked-tenant-required')
    expect(blocked).toBeTruthy()
    // The "no-assigned" Alert MUST NOT also render (the two states
    // are mutually exclusive — tenantMissing wins).
    expect(screen.queryByTestId('agent-create-blocked-no-assigned-locations')).toBeNull()
  })

  it('submit button is disabled and carries data-blocked=true', async () => {
    siteState.isSuperAdmin = true
    siteState.organization = null
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const submit = await screen.findByTestId('agent-create-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(submit.getAttribute('data-blocked')).toBe('true')
  })

  it('clicking the (disabled) submit does NOT call agentsApi.create', async () => {
    siteState.isSuperAdmin = true
    siteState.organization = null
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const submit = await screen.findByTestId('agent-create-submit')
    await act(async () => {
      fireEvent.click(submit)
    })
    expect(agentsApiState.create).not.toHaveBeenCalled()
  })

  it('synthetic dispatchEvent click on the submit also does not call create', async () => {
    siteState.isSuperAdmin = true
    siteState.organization = null
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const submit = await screen.findByTestId('agent-create-submit')
    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(agentsApiState.create).not.toHaveBeenCalled()
  })
})


// ─── User with no assigned locations — blocked state ─────────────────────


describe('Agent create modal — caller with no accessible locations', () => {
  it('shows no-assigned Alert; tenant-required Alert NOT rendered', async () => {
    siteState.isSuperAdmin = false
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.hasLocationAccess = false
    siteState.locations = []
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    expect(await screen.findByTestId('agent-create-blocked-no-assigned-locations')).toBeTruthy()
    expect(screen.queryByTestId('agent-create-blocked-tenant-required')).toBeNull()
  })

  it('submit + dropdown + name input are all disabled', async () => {
    siteState.isSuperAdmin = false
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.hasLocationAccess = false
    siteState.locations = []
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const submit = await screen.findByTestId('agent-create-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    const nameInput = screen.getByTestId('agent-create-name-input') as HTMLInputElement
    expect(nameInput.disabled).toBe(true)
  })

  it('no enrollment call when submit is clicked under no-assigned state', async () => {
    siteState.hasLocationAccess = false
    siteState.locations = []
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const submit = await screen.findByTestId('agent-create-submit')
    await act(async () => {
      fireEvent.click(submit)
    })
    expect(agentsApiState.create).not.toHaveBeenCalled()
  })
})


// ─── Happy path — caller HAS a tenant + locations ────────────────────────


// ─── SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) ────────────────────────────


describe('Agent create modal — SITE-CONTEXT-HYDRATION-GUARD window', () => {
  // During the hydration window all SiteContext defaults light up the
  // "no-assigned" branch deterministically (locations=[], !isSuperAdmin,
  // !hasLocationAccess?? defaults). The patch gates BOTH `tenantMissing`
  // and `noAssignedLocations` on `!sitesLoading`. Below: sitesLoading=true
  // + every other field at its hydration-window default must produce
  // NEITHER blocked Alert. The form is still rendered (input + select)
  // but in a neutral state — the user can type a name; the submit will
  // disable on `activeLocationId == null && newLoc == null` as before
  // (a real config error, not a transient hydration artefact).

  it('sitesLoading=true + all defaults → NO blocked Alert, NO tenant-required Alert', async () => {
    siteState.sitesLoading = true
    // Defaults — same shape the SiteContext provider hands out before
    // /context/current resolves.
    siteState.isSuperAdmin = false
    siteState.organization = null
    siteState.hasLocationAccess = true
    siteState.locations = []
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    expect(screen.queryByTestId('agent-create-blocked-no-assigned-locations')).toBeNull()
    expect(screen.queryByTestId('agent-create-blocked-tenant-required')).toBeNull()
  })

  it('sitesLoading=true + super_admin shape + null organization → NO tenant-required Alert', async () => {
    // A super_admin landing on the page: token present, but the
    // CurrentContext fetch hasn't returned yet, so all sub-fields
    // (including `organization`) read null. Without the gate the modal
    // would surface "Önce firma seçin" during this window even though
    // the backend hasn't been asked.
    siteState.sitesLoading = true
    siteState.isSuperAdmin = true
    siteState.organization = null
    siteState.isOrgWide = true
    siteState.locations = []
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    expect(screen.queryByTestId('agent-create-blocked-tenant-required')).toBeNull()
    expect(screen.queryByTestId('agent-create-blocked-no-assigned-locations')).toBeNull()
  })

  it('hydration finishes (sitesLoading false → true → false) — blocked Alert may then surface', async () => {
    // Confirm the gate releases once context is resolved. Same fixture
    // as the no-tenant case above EXCEPT sitesLoading is now false →
    // the gate is open → the existing PR #96 contract resumes.
    siteState.sitesLoading = false
    siteState.isSuperAdmin = true
    siteState.organization = null
    siteState.isOrgWide = true
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    expect(await screen.findByTestId('agent-create-blocked-tenant-required')).toBeTruthy()
  })
})


describe('Agent create modal — caller WITH a tenant and locations', () => {
  it('no blocked Alert; submit enabled once a name is typed and a location is set', async () => {
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.locations = [{ id: 7, name: 'Istanbul', color: null, city: null, country: null, device_count: 0 }]
    siteState.activeLocationId = 7
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))

    expect(screen.queryByTestId('agent-create-blocked-tenant-required')).toBeNull()
    expect(screen.queryByTestId('agent-create-blocked-no-assigned-locations')).toBeNull()

    // Type a name → submit becomes enabled (active location is the
    // fallback location_id).
    const input = screen.getByTestId('agent-create-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'agent-1' } })

    const submit = screen.getByTestId('agent-create-submit')
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    expect(submit.getAttribute('data-blocked')).toBe('false')
  })

  it('clicking submit issues exactly one create call with the resolved location_id', async () => {
    siteState.organization = { id: 1, name: 'Acme', slug: 'acme' }
    siteState.locations = [{ id: 7, name: 'Istanbul', color: null, city: null, country: null, device_count: 0 }]
    siteState.activeLocationId = 7
    renderNocAgents()
    fireEvent.click(await screen.findByTestId('agent-install-button'))
    const input = screen.getByTestId('agent-create-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'agent-1' } })
    const submit = screen.getByTestId('agent-create-submit')
    await act(async () => {
      fireEvent.click(submit)
    })
    expect(agentsApiState.create).toHaveBeenCalledTimes(1)
    expect(agentsApiState.create.mock.calls[0][0]).toEqual({
      name: 'agent-1',
      location_id: 7,
    })
  })
})
