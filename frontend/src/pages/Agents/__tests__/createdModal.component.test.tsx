// @vitest-environment jsdom
/**
 * CreatedModal — real jsdom + Testing Library component tests.
 *
 * These are the AUTHORITATIVE behavioural tests for the WIN-FRONTEND
 * post-CI review #2 contract. handleDownload.test.ts source-greps
 * are cheap regression guards only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
// fireEvent works without user-event

import { CreatedModal } from '../NocAgents'


// ────────────────────────────────────────────────────────────────
// Module mocks
// ────────────────────────────────────────────────────────────────

// react-i18next: identity translator
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}))

// theme hook
vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ isDark: false }),
}))

// agents API
vi.mock('@/api/agents', () => ({
  agentsApi: {
    downloadInstallerUrl: (id: string, platform: string) =>
      `/api/v1/agents/${id}/download/${platform}`,
    downloadInstallerFile: vi.fn(async () => undefined),
  },
}))


// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function bom(): Uint8Array {
  return new Uint8Array([0xef, 0xbb, 0xbf])
}

function buildValidInstaller(): Uint8Array {
  const body = [
    '# NetManager installer',
    '$AgentId    = "abc"',
    '$AgentKey   = "k"',
    '$BackendUrl = "https://x"',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '# charon-agent-host',
    'Invoke-WebRequest -Uri "$BackendUrl/api/v1/agents/$AgentId/download/host/windows-amd64"',
    'function Restore-PreviousAgentService {}',
  ].join('\r\n')
  const head = bom()
  const tail = new TextEncoder().encode(body)
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

interface FetchCall {
  url: string
  init?: RequestInit
}

function installFetchMock(): {
  calls: FetchCall[]
  mock: ReturnType<typeof vi.fn>
} {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init })
    const bytes = buildValidInstaller()
    return {
      ok: true,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    } as any
  })
  // @ts-ignore -- jsdom test environment
  globalThis.fetch = mock as any
  return { calls, mock }
}

function installURLMock() {
  const created: string[] = []
  const revoked: string[] = []
  // @ts-ignore
  globalThis.URL.createObjectURL = vi.fn((_b: any) => {
    const url = `blob://test/${created.length}`
    created.push(url)
    return url
  })
  // @ts-ignore
  globalThis.URL.revokeObjectURL = vi.fn((u: string) => revoked.push(u))
  return { created, revoked }
}


const FAKE_AGENT = {
  id: 'agent-abc-123',
  agent_key: 'KEY-SHOULD-NEVER-LEAK',
  name: 'agent',
  organization_id: 1,
  is_active: true,
  created_at: '2026-06-12T00:00:00Z',
  last_seen: null,
} as any


function renderModal() {
  return render(
    <CreatedModal agent={FAKE_AGENT} onClose={() => {}} />,
  )
}


beforeEach(() => {
  vi.restoreAllMocks()
  // AntD's responsive observer touches window.matchMedia; jsdom does
  // not provide it by default.
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


// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────


describe('CreatedModal — opens', () => {
  it('renders modal with both platform tiles', () => {
    renderModal()
    expect(screen.getByText('agents.linux_label')).toBeTruthy()
    expect(screen.getByText('agents.windows_label')).toBeTruthy()
  })

  it('Windows tile carries the Yakında / Coming soon badge', () => {
    // WINDOWS_AGENT_DEVELOPMENT_PAUSED: the Windows tile stays
    // visible so the user knows Windows support is planned, but
    // it carries a visual "coming soon" badge. Linux carries no
    // such badge.
    renderModal()
    expect(
      screen.getByTestId('platform-card-windows-coming-soon-badge'),
    ).toBeTruthy()
    expect(
      screen.queryByTestId('platform-card-linux-coming-soon-badge'),
    ).toBeNull()
  })

  it('Windows tile is data-marked coming-soon, Linux is not', () => {
    // Source-level mark that lets a future "WINDOWS AGENT RESUME GO"
    // flip the flag in one place. Tests cling to data-coming-soon
    // rather than the visual styling.
    renderModal()
    expect(
      screen.getByTestId('platform-card-windows').getAttribute('data-coming-soon'),
    ).toBe('true')
    expect(
      screen.getByTestId('platform-card-linux').getAttribute('data-coming-soon'),
    ).toBe('false')
  })
})


// ────────────────────────────────────────────────────────────────
// Windows path -- WINDOWS_AGENT_DEVELOPMENT_PAUSED
// The installer is under validation; the UI keeps Windows visible
// but the download button is hard-disabled and no Windows endpoint
// is contacted under any interaction model.
// ────────────────────────────────────────────────────────────────


describe('CreatedModal — Windows path (coming-soon, NO download)', () => {
  it('Windows tile selectable; coming-soon Alert shown (NOT the old windows_hint)', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    // The Alert message swaps to the explanatory "coming soon"
    // copy, NOT the old "download and run" hint.
    expect(
      await screen.findByText('agents.windows_coming_soon_message'),
    ).toBeTruthy()
    expect(screen.queryByText('agents.windows_hint')).toBeNull()
    expect(
      screen.queryByText('agents.windows_download_primary_hint'),
    ).toBeNull()
  })

  it('Windows download button is rendered, disabled, aria-disabled, with Coming-soon label', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')
    // The button stays in the DOM (operator can see what would be
    // available) but is disabled at the DOM + ARIA + AntD layers.
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('agents.download_windows')
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    // Mark for downstream guards that source-grep the DOM.
    expect(btn.getAttribute('data-platform')).toBe('windows')
    expect(btn.getAttribute('data-coming-soon')).toBe('true')
  })

  it('Windows: no oneliner copy block, no PowerShell snippet, no command preview', async () => {
    // Operator spec: "Installer script render etmemeli" — no
    // installer body of any kind on the Windows path.
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    expect(await screen.findByTestId('platform-hint-alert')).toBeTruthy()
    expect(screen.queryByTestId('linux-oneliner-block')).toBeNull()
    expect(screen.queryByText('agents.copy')).toBeNull()
    expect(screen.queryByText('agents.oneliner_label')).toBeNull()
    // No PowerShell or installer fragment leaks into the DOM.
    const html = document.body.innerHTML
    expect(html).not.toMatch(/Invoke-WebRequest/i)
    expect(html).not.toMatch(/iex\b/i)
    expect(html).not.toMatch(/charon-runtime-windows-amd64/i)
  })

  it('Windows: clicking the disabled button does NOT call fetch / endpoint', async () => {
    // Two gates layered: AntD/HTML disabled (browser-level) +
    // handleDownload early-return (programmatic-click defence).
    // We assert the combined behaviour: no fetch under any model.
    const { calls, mock } = installFetchMock()
    installURLMock()
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('Windows: programmatic .click() bypassing disabled still does NOT trigger fetch (handleDownload gate)', async () => {
    // Belt-and-braces: even if a future regression removes the
    // `disabled` attribute, handleDownload's `if (platform ===
    // "windows") return` must catch the synthetic click. We force
    // the click through `el.dispatchEvent(new MouseEvent('click'))`
    // which fires regardless of the disabled flag in jsdom.
    const { calls, mock } = installFetchMock()
    installURLMock()
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      btn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })

    expect(mock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('Windows: rapid double-click produces zero requests (still disabled)', async () => {
    const { mock } = installFetchMock()
    installURLMock()
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      const a = Promise.resolve(fireEvent.click(btn))
      const b = Promise.resolve(fireEvent.click(btn))
      await Promise.all([a, b])
    })

    expect(mock.mock.calls.length).toBe(0)
  })

  it('Windows: no Object URL created, no anchor click, no Blob (the helper never runs)', async () => {
    installFetchMock()
    const url = installURLMock()
    const realCreate = document.createElement.bind(document)
    const anchorClicks: any[] = []
    vi.spyOn(document, 'createElement').mockImplementation((tag: any) => {
      const el = realCreate(tag)
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: vi.fn(() => anchorClicks.push(el)),
          writable: true,
          configurable: true,
        })
      }
      return el as any
    })

    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(url.created.length).toBe(0)
    expect(url.revoked.length).toBe(0)
    expect(anchorClicks.length).toBe(0)
  })

  it('Windows: no alert fires (no error path reached — there is no download to fail)', async () => {
    installFetchMock()
    installURLMock()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('Windows: agent_key NEVER appears in the DOM (no enrollment-side render leak)', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    await screen.findByTestId('installer-download-button')
    // Modal renders the key in the descriptions section by design
    // (it's an enrollment ack). But the Windows installer surface
    // must not duplicate it into any installer-body element.
    const hintAlert = screen.getByTestId('platform-hint-alert')
    expect(hintAlert.innerHTML).not.toContain(FAKE_AGENT.agent_key)
    const btn = screen.getByTestId('installer-download-button')
    expect(btn.innerHTML).not.toContain(FAKE_AGENT.agent_key)
  })
})


describe('CreatedModal — Linux path UNCHANGED', () => {
  it('renders the copy/paste curl command block + copy button', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.linux_label'))

    // copy block visible
    expect(await screen.findByTestId('linux-oneliner-block')).toBeTruthy()
    expect(screen.getByText('agents.copy')).toBeTruthy()
    expect(screen.getByText('agents.oneliner_label')).toBeTruthy()
    // download button still present
    const btn = screen.getByTestId('installer-download-button')
    expect(btn.textContent).toContain('agents.download_linux')
    // Linux-specific Alert hint visible; Windows hint NOT shown
    expect(screen.getByText('agents.linux_hint')).toBeTruthy()
    expect(screen.queryByText('agents.windows_hint')).toBeNull()
  })

  it('Linux download uses agentsApi.downloadInstallerFile (not the byte helper)', async () => {
    const { agentsApi } = await import('@/api/agents')
    const dlSpy = agentsApi.downloadInstallerFile as any
    dlSpy.mockClear?.()

    renderModal()
    fireEvent.click(screen.getByText('agents.linux_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(dlSpy).toHaveBeenCalledTimes(1)
    const args = dlSpy.mock.calls[0]
    expect(args[0]).toBe(FAKE_AGENT.id)
    expect(args[1]).toBe(FAKE_AGENT.agent_key)
    expect(args[2]).toBe('linux')
  })

  it('Linux failure shows the LINUX i18n message (not the Windows key)', async () => {
    const { agentsApi } = await import('@/api/agents')
    const dlSpy = agentsApi.downloadInstallerFile as any
    dlSpy.mockClear?.()
    dlSpy.mockImplementationOnce(async () => {
      const err: any = new Error('boom')
      err.status = 500
      throw err
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderModal()
    fireEvent.click(screen.getByText('agents.linux_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(alertSpy).toHaveBeenCalledTimes(1)
    const msg = alertSpy.mock.calls[0][0] as string
    expect(msg).toBe('agents.linux_download_failed')
    // Crucially: the Windows i18n keys do NOT leak onto the
    // Linux path -- the original review #3 bug.
    expect(msg).not.toBe('agents.windows_download_failed')
    expect(msg).not.toBe('agents.windows_validation_failed')
    // No agent key, no URL, no raw exception
    expect(msg).not.toContain(FAKE_AGENT.agent_key)
    expect(msg).not.toContain('boom')
    expect(msg).not.toMatch(/api\/v1\/agents/)
  })

  it('Linux: retry after failure is allowed (guard resets, second click runs)', async () => {
    const { agentsApi } = await import('@/api/agents')
    const dlSpy = agentsApi.downloadInstallerFile as any
    dlSpy.mockClear?.()
    // first call fails, second succeeds
    dlSpy
      .mockImplementationOnce(async () => {
        throw new Error('boom')
      })
      .mockImplementationOnce(async () => undefined)
    vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderModal()
    fireEvent.click(screen.getByText('agents.linux_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })
    expect(dlSpy).toHaveBeenCalledTimes(1)

    // Second click must reach the API again -- the guard should be
    // released by the finally{} block.
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(dlSpy).toHaveBeenCalledTimes(2)
  })
})


// ────────────────────────────────────────────────────────────────
// Loading state (Windows-only suite was removed in the
// WINDOWS_AGENT_DEVELOPMENT_PAUSED change: there is no Windows
// download to drive a deferred Promise through. Linux loading
// behaviour is still covered indirectly by the Linux describe
// block's "retry after failure is allowed" test.
//
// The byte-helper itself (downloadWindowsInstaller) is unchanged
// and remains covered by windowsInstallerDownload.test.ts so the
// helper is ready for a future "WINDOWS AGENT RESUME GO".
// ────────────────────────────────────────────────────────────────
