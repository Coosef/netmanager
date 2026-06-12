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

function installFailingFetch(opts: { ok?: boolean; throwOnText?: boolean } = {}) {
  const text = vi.fn(async () => 'should-not-be-read')
  const mock = vi.fn(async () => ({
    ok: opts.ok ?? false,
    status: 500,
    text,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as any
  // @ts-ignore
  globalThis.fetch = mock as any
  return { mock, text }
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
})


describe('CreatedModal — Windows path', () => {
  it('shows ONLY the download button, no copy command block', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))

    // Download button visible
    const btn = await screen.findByTestId('installer-download-button')
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('agents.download_windows')

    // No copy block, no copy button, no command code
    expect(screen.queryByTestId('linux-oneliner-block')).toBeNull()
    expect(screen.queryByText('agents.copy')).toBeNull()
    expect(screen.queryByText('agents.oneliner_label')).toBeNull()
  })

  it('shows a single authoritative Windows hint (Alert) and no secondary copy', async () => {
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    // The Alert with `agents.windows_hint` is the only Windows hint.
    expect(await screen.findByText('agents.windows_hint')).toBeTruthy()
    // The previously duplicated button-bottom hint key is gone.
    expect(screen.queryByText('agents.windows_download_primary_hint')).toBeNull()
  })

  it('clicking download issues exactly one fetch with the X-Agent-Key header', async () => {
    const { calls, mock } = installFetchMock()
    installURLMock()
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mock).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/v1/agents/agent-abc-123/download/windows')
    // Agent key NEVER in the URL
    expect(calls[0].url).not.toContain(FAKE_AGENT.agent_key)
    // Header present
    const headers = (calls[0].init as any)?.headers
    expect(headers['X-Agent-Key']).toBe(FAKE_AGENT.agent_key)
  })

  it('rapid double-click produces exactly one request (concurrent guard)', async () => {
    const { mock } = installFetchMock()
    installURLMock()
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      // fire two clicks back to back without awaiting individually
      const a = Promise.resolve(fireEvent.click(btn))
      const b = Promise.resolve(fireEvent.click(btn))
      await Promise.all([a, b])
    })

    expect(mock.mock.calls.length).toBe(1)
  })

  it('byte-for-byte: Blob built from original ArrayBuffer + anchor click occurs', async () => {
    installFetchMock()
    const url = installURLMock()
    // Spy on anchor click via createElement
    const realCreate = document.createElement.bind(document)
    const clicks: any[] = []
    vi.spyOn(document, 'createElement').mockImplementation((tag: any) => {
      const el = realCreate(tag)
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: vi.fn(() => clicks.push(el)),
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

    expect(url.created.length).toBe(1)
    expect(url.revoked.length).toBe(1)
    expect(clicks.length).toBe(1)
    const anchor = clicks[0]
    expect(anchor.download).toBe(
      'netmanager-agent-agent-abc-123-installer.ps1',
    )
    expect(anchor.download).not.toContain(FAKE_AGENT.agent_key)
  })

  it('HTTP failure: no Object URL, response body NOT read, generic alert', async () => {
    const { mock, text } = installFailingFetch()
    const url = installURLMock()
    const alertSpy = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => {})
    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mock).toHaveBeenCalledTimes(1)
    expect(text).not.toHaveBeenCalled()
    expect(url.created.length).toBe(0)
    expect(alertSpy).toHaveBeenCalledTimes(1)
    const msg = alertSpy.mock.calls[0][0] as string
    expect(msg).toBe('agents.windows_download_failed')
    // Crucially: key NOT in alert
    expect(msg).not.toContain(FAKE_AGENT.agent_key)
  })

  it('validation failure (no BOM): no Object URL, generic validation alert', async () => {
    // Fetch returns body WITHOUT a BOM -> validation must reject
    const mock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('no bom here').buffer,
    })) as any
    // @ts-ignore
    globalThis.fetch = mock as any
    const url = installURLMock()
    const alertSpy = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => {})

    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })

    expect(url.created.length).toBe(0)
    expect(alertSpy).toHaveBeenCalledTimes(1)
    expect(alertSpy.mock.calls[0][0]).toBe(
      'agents.windows_validation_failed',
    )
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
// Loading state (deferred Promise)
// ────────────────────────────────────────────────────────────────


describe('CreatedModal -- loading state (deferred resolve / reject)', () => {
  // tiny deferred helper -- reuse across success and error cases
  function deferred<T = void>() {
    let resolve!: (v: T) => void
    let reject!: (e: any) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('Windows: button shows loading until fetch resolves; second click during loading is ignored', async () => {
    const d = deferred<any>()
    const url = installURLMock()
    const mock = vi.fn(() => d.promise as any) as any
    // @ts-ignore
    globalThis.fetch = mock as any

    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })
    expect(mock).toHaveBeenCalledTimes(1)
    // AntD adds `ant-btn-loading` to the button class while loading.
    // Second click should be swallowed by the concurrent guard.
    expect(btn.className).toMatch(/ant-btn-loading/)

    await act(async () => {
      fireEvent.click(btn)
    })
    expect(mock).toHaveBeenCalledTimes(1)

    // Resolve the deferred -> loading clears + Object URL workflow runs
    const bytes = buildValidInstaller()
    await act(async () => {
      d.resolve({
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      })
      // drain microtasks
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(btn.className).not.toMatch(/ant-btn-loading/)
    expect(url.created.length).toBe(1)

    // A subsequent independent click must start a new request.
    const d2 = deferred<any>()
    mock.mockImplementationOnce(() => d2.promise)
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(mock).toHaveBeenCalledTimes(2)
    await act(async () => {
      d2.resolve({
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(btn.className).not.toMatch(/ant-btn-loading/)
  })

  it('Windows: button clears loading after deferred REJECT and allows retry', async () => {
    const d = deferred<any>()
    const mock = vi.fn(() => d.promise as any) as any
    // @ts-ignore
    globalThis.fetch = mock as any
    installURLMock()
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    renderModal()
    fireEvent.click(screen.getByText('agents.windows_label'))
    const btn = await screen.findByTestId('installer-download-button')

    await act(async () => {
      fireEvent.click(btn)
    })
    expect(btn.className).toMatch(/ant-btn-loading/)

    // Reject the deferred -> alert fires, loading clears, retry OK.
    await act(async () => {
      d.reject(new Error('network'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(btn.className).not.toMatch(/ant-btn-loading/)
    expect(alertSpy).toHaveBeenCalledTimes(1)
    expect(alertSpy.mock.calls[0][0]).toBe('agents.windows_download_failed')

    // Retry after failure
    const d2 = deferred<any>()
    mock.mockImplementationOnce(() => d2.promise)
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(mock).toHaveBeenCalledTimes(2)
  })
})
