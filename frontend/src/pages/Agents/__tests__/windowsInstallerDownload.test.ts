/**
 * Byte-perfect Windows installer download — unit tests.
 *
 * The byte parity invariants are the whole point of this module;
 * each test compares Blob output to ORIGINAL input bytes, byte for
 * byte, using a synthetic .ps1 fixture that carries the production
 * shape (BOM + ASCII PowerShell + CRLF + Restore-PreviousAgentService
 * marker).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateWindowsInstallerBytes,
  buildSafeInstallerFilename,
  downloadWindowsInstaller,
} from '../windowsInstallerDownload'


// ────────────────────────────────────────────────────────────────
// Fixture builder
// ────────────────────────────────────────────────────────────────

function buildInstallerBytes(opts: {
  bom?: 'single' | 'double' | 'none'
  body?: string
} = {}): Uint8Array {
  const bom = opts.bom ?? 'single'
  const body =
    opts.body ??
    [
      '# NetManager installer',
      '$AgentId    = "abc"',
      '$AgentKey   = "k"',
      '$BackendUrl = "https://x"',
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
      '# charon-agent-host',
      'Invoke-WebRequest -Uri "$BackendUrl/api/v1/agents/$AgentId/download/host/windows-amd64"',
      'function Restore-PreviousAgentService {}',
    ].join('\r\n')

  const bomBytes =
    bom === 'none'
      ? new Uint8Array(0)
      : bom === 'double'
      ? new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf])
      : new Uint8Array([0xef, 0xbb, 0xbf])
  const bodyBytes = new TextEncoder().encode(body)
  const out = new Uint8Array(bomBytes.length + bodyBytes.length)
  out.set(bomBytes, 0)
  out.set(bodyBytes, bomBytes.length)
  return out
}


// ────────────────────────────────────────────────────────────────
// validateWindowsInstallerBytes
// ────────────────────────────────────────────────────────────────


describe('validateWindowsInstallerBytes', () => {
  it('accepts a single-BOM, CRLF, marker-bearing installer', () => {
    const v = validateWindowsInstallerBytes(buildInstallerBytes())
    expect(v.valid).toBe(true)
  })

  it('rejects an empty buffer', () => {
    expect(validateWindowsInstallerBytes(new Uint8Array(0))).toEqual({
      valid: false,
      reason: 'empty',
    })
  })

  it('rejects a missing BOM', () => {
    expect(
      validateWindowsInstallerBytes(buildInstallerBytes({ bom: 'none' })),
    ).toEqual({ valid: false, reason: 'missing-bom' })
  })

  it('rejects a double BOM', () => {
    expect(
      validateWindowsInstallerBytes(buildInstallerBytes({ bom: 'double' })),
    ).toEqual({ valid: false, reason: 'double-bom' })
  })

  it('rejects invalid UTF-8 in the body', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    // bare 0xFF / 0xFE are illegal in UTF-8 sequences
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0x41])
    const merged = new Uint8Array(bom.length + body.length)
    merged.set(bom, 0)
    merged.set(body, bom.length)
    expect(validateWindowsInstallerBytes(merged)).toEqual({
      valid: false,
      reason: 'not-utf8',
    })
  })

  it('rejects a payload missing a required marker', () => {
    const body =
      '$AgentId="x"\r\n$AgentKey="y"\r\nTls12\r\n' +
      'charon-agent-host\r\ndownload/host/windows-amd64\r\n' +
      'function Restore-PreviousAgentService {}'
    // ^ missing $BackendUrl
    const fixture = buildInstallerBytes({ body })
    const v = validateWindowsInstallerBytes(fixture)
    expect(v.valid).toBe(false)
    expect(v.reason).toBe('missing-marker')
  })

  it('rejects PS 7-only ?.Source', () => {
    const v = validateWindowsInstallerBytes(
      buildInstallerBytes({
        body:
          '$AgentId="x"\r\n$AgentKey="y"\r\n$BackendUrl="z"\r\nTls12\r\n' +
          'charon-agent-host\r\ndownload/host/windows-amd64\r\n' +
          'function Restore-PreviousAgentService {}\r\n' +
          '$cmd = (Get-Command python)?.Source',
      }),
    )
    expect(v).toEqual({ valid: false, reason: 'forbidden-pattern' })
  })

  it('rejects sc.exe create / sc.exe start', () => {
    for (const bad of ['sc.exe create svc', 'sc.exe start svc']) {
      const v = validateWindowsInstallerBytes(
        buildInstallerBytes({
          body:
            '$AgentId="x"\r\n$AgentKey="y"\r\n$BackendUrl="z"\r\nTls12\r\n' +
            'charon-agent-host\r\ndownload/host/windows-amd64\r\n' +
            'function Restore-PreviousAgentService {}\r\n' +
            bad,
        }),
      )
      expect(v).toEqual({ valid: false, reason: 'forbidden-pattern' })
    }
  })

  it('rejects | iex / | Invoke-Expression', () => {
    for (const bad of [
      'iwr "x" | iex',
      'Invoke-WebRequest "x" | Invoke-Expression',
    ]) {
      const v = validateWindowsInstallerBytes(
        buildInstallerBytes({
          body:
            '$AgentId="x"\r\n$AgentKey="y"\r\n$BackendUrl="z"\r\nTls12\r\n' +
            'charon-agent-host\r\ndownload/host/windows-amd64\r\n' +
            'function Restore-PreviousAgentService {}\r\n' +
            bad,
        }),
      )
      expect(v).toEqual({ valid: false, reason: 'forbidden-pattern' })
    }
  })

  it('does NOT mutate input bytes (validation reads only)', () => {
    const fixture = buildInstallerBytes()
    const before = Array.from(fixture)
    validateWindowsInstallerBytes(fixture)
    const after = Array.from(fixture)
    expect(after).toEqual(before)
  })
})


// ────────────────────────────────────────────────────────────────
// buildSafeInstallerFilename
// ────────────────────────────────────────────────────────────────


describe('buildSafeInstallerFilename', () => {
  it('keeps the [A-Za-z0-9_-] character class', () => {
    expect(buildSafeInstallerFilename('abc_123-XYZ')).toBe(
      'netmanager-agent-abc_123-XYZ-installer.ps1',
    )
  })

  it('strips `.` (defends against ..\\ traversal tokens)', () => {
    expect(buildSafeInstallerFilename('agent.with.dots')).toBe(
      'netmanager-agent-agentwithdots-installer.ps1',
    )
  })

  it.each([
    ['../etc/passwd', 'netmanager-agent-etcpasswd-installer.ps1'],
    ['..\\..\\windows\\system32', 'netmanager-agent-windowssystem32-installer.ps1'],
    ['/abs/path', 'netmanager-agent-abspath-installer.ps1'],
    ['some:colon', 'netmanager-agent-somecolon-installer.ps1'],
    ['wild*card?', 'netmanager-agent-wildcard-installer.ps1'],
    ['"<bad>|name', 'netmanager-agent-badname-installer.ps1'],
    ['', 'netmanager-agent-agent-installer.ps1'],
  ])('sanitises traversal/special chars (%s)', (input, expected) => {
    expect(buildSafeInstallerFilename(input)).toBe(expected)
  })

  it('falls back to "agent" when input has no allowed chars', () => {
    expect(buildSafeInstallerFilename('???')).toBe(
      'netmanager-agent-agent-installer.ps1',
    )
  })

  it('does not include the agent key under any branch', () => {
    const out = buildSafeInstallerFilename('SOMEAGENT')
    expect(out).not.toContain('key')
    expect(out).not.toContain('Key')
  })
})


// ────────────────────────────────────────────────────────────────
// downloadWindowsInstaller (byte-perfect + security)
// ────────────────────────────────────────────────────────────────


function mockDocument() {
  const anchors: HTMLAnchorElement[] = []
  const body: any = {
    appendChild: vi.fn((el: any) => {
      el.parentNode = body
      anchors.push(el)
    }),
    removeChild: vi.fn((el: any) => {
      el.parentNode = null
    }),
  }
  const doc = {
    createElement: vi.fn((tag: string) => {
      const a: any = {
        tag,
        href: '',
        download: '',
        click: vi.fn(),
        parentNode: null,
      }
      return a
    }),
    body,
    _anchors: anchors,
  }
  return doc as unknown as Document & { _anchors: HTMLAnchorElement[] }
}


function withObjectURL() {
  const objectUrls: string[] = []
  // `_blob` is intentionally unused — the helper only needs to
  // observe Blob constructor calls separately via Blob's prototype.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const create = vi.fn((_blob: Blob) => {
    const url = `blob://test/${objectUrls.length}`
    objectUrls.push(url)
    return url
  })
  const revoke = vi.fn()
  // @ts-ignore -- node test environment
  globalThis.URL.createObjectURL = create as any
  // @ts-ignore
  globalThis.URL.revokeObjectURL = revoke as any
  return { create, revoke, objectUrls }
}


describe('downloadWindowsInstaller — byte-perfect + security', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the Blob from the ORIGINAL ArrayBuffer (byte-for-byte parity)', async () => {
    const original = buildInstallerBytes()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => original.buffer.slice(
        original.byteOffset,
        original.byteOffset + original.byteLength,
      ),
    })) as any
    const doc = mockDocument()
    const { create } = withObjectURL()

    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: 'SUPERSECRETKEY',
      url: 'https://example.app/dl',
      fetchImpl,
      documentImpl: doc as any,
    })

    expect(create).toHaveBeenCalledTimes(1)
    const blob = create.mock.calls[0][0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBe(original.byteLength)
    const blobBytes = new Uint8Array(await blob.arrayBuffer())
    // byte-for-byte parity
    expect(Array.from(blobBytes)).toEqual(Array.from(original))
    // first three bytes still BOM
    expect(blobBytes[0]).toBe(0xef)
    expect(blobBytes[1]).toBe(0xbb)
    expect(blobBytes[2]).toBe(0xbf)
    // double-BOM negative
    expect(blobBytes[3]).not.toBe(0xef)
    // Blob MIME type
    expect(blob.type).toBe('application/x-powershell')
  })

  it('passes agent key only as the X-Agent-Key header (never in URL)', async () => {
    const KEY = 'SUPERSECRETKEY-must-never-leak'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => {
        const b = buildInstallerBytes()
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      },
    })) as any
    const doc = mockDocument()
    withObjectURL()

    const url = 'https://netmanager.example.app/api/v1/agents/abc/download/windows'
    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: KEY,
      url,
      fetchImpl,
      documentImpl: doc as any,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchImpl.mock.calls[0]
    // URL: no key
    expect(calledUrl).toBe(url)
    expect(String(calledUrl)).not.toContain(KEY)
    // Header has the key
    expect((init as any).headers['X-Agent-Key']).toBe(KEY)
  })

  it('filename excludes the agent key', async () => {
    const KEY = 'KEY-SHOULD-NOT-LAND-IN-FILENAME'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => {
        const b = buildInstallerBytes()
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      },
    })) as any
    const doc = mockDocument()
    withObjectURL()

    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: KEY,
      url: '/dl',
      fetchImpl,
      documentImpl: doc as any,
    })

    const anchor = (doc as any)._anchors[0]
    expect(anchor.download).toBe('netmanager-agent-abc-installer.ps1')
    expect(anchor.download).not.toContain(KEY)
  })

  it('does NOT call res.text()', async () => {
    const text = vi.fn(async () => 'leak')
    const original = buildInstallerBytes()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text,
      arrayBuffer: async () =>
        original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ),
    })) as any
    const doc = mockDocument()
    withObjectURL()

    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: 'k',
      url: '/dl',
      fetchImpl,
      documentImpl: doc as any,
    })

    expect(text).not.toHaveBeenCalled()
  })

  it('does NOT read response body on HTTP failure (no leak)', async () => {
    const text = vi.fn(async () => 'leak-body')
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as any
    const doc = mockDocument()
    const { create } = withObjectURL()

    await expect(
      downloadWindowsInstaller({
        agentId: 'abc',
        agentKey: 'k',
        url: '/dl',
        fetchImpl,
        documentImpl: doc as any,
      }),
    ).rejects.toMatchObject({ kind: 'http' })

    expect(text).not.toHaveBeenCalled()
    // no Blob / Object URL when HTTP fails
    expect(create).not.toHaveBeenCalled()
    expect(doc.createElement).not.toHaveBeenCalled()
  })

  it('does NOT create an Object URL when validation fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => {
        const bad = buildInstallerBytes({ bom: 'none' })
        return bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)
      },
    })) as any
    const doc = mockDocument()
    const { create, revoke } = withObjectURL()

    await expect(
      downloadWindowsInstaller({
        agentId: 'abc',
        agentKey: 'k',
        url: '/dl',
        fetchImpl,
        documentImpl: doc as any,
      }),
    ).rejects.toMatchObject({ kind: 'validation' })

    expect(create).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(doc.createElement).not.toHaveBeenCalled()
  })

  it('removes the anchor and revokes the URL even when click() throws', async () => {
    const original = buildInstallerBytes()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () =>
        original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ),
    })) as any

    // mockDocument's anchors throw when click() is called.
    const anchors: any[] = []
    const removeCalls = vi.fn()
    const doc: any = {
      createElement: vi.fn((tag: string) => {
        const a: any = {
          tag,
          href: '',
          download: '',
          click: vi.fn(() => {
            throw new Error('boom')
          }),
          parentNode: null,
        }
        anchors.push(a)
        return a
      }),
      body: {
        appendChild: vi.fn((el: any) => {
          el.parentNode = doc.body
          return el
        }),
        removeChild: vi.fn((el: any) => {
          removeCalls(el)
          el.parentNode = null
        }),
      },
    }
    const { create, revoke } = withObjectURL()

    await expect(
      downloadWindowsInstaller({
        agentId: 'abc',
        agentKey: 'k',
        url: '/dl',
        fetchImpl,
        documentImpl: doc as any,
      }),
    ).rejects.toThrow('boom')

    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledTimes(1)
    // anchor cleanup must still have happened
    expect(removeCalls).toHaveBeenCalledTimes(1)
    expect(anchors[0].parentNode).toBeNull()
  })

  it('revokes the Object URL after success', async () => {
    const original = buildInstallerBytes()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () =>
        original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ),
    })) as any
    const doc = mockDocument()
    const { create, revoke } = withObjectURL()

    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: 'k',
      url: '/dl',
      fetchImpl,
      documentImpl: doc as any,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('preserves CRLF bytes verbatim (no LF normalisation)', async () => {
    const original = buildInstallerBytes()
    // count CRLF in the original input
    let crlf = 0
    for (let i = 0; i < original.length - 1; i++) {
      if (original[i] === 0x0d && original[i + 1] === 0x0a) crlf++
    }
    expect(crlf).toBeGreaterThan(0)

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () =>
        original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ),
    })) as any
    const doc = mockDocument()
    const { create } = withObjectURL()

    await downloadWindowsInstaller({
      agentId: 'abc',
      agentKey: 'k',
      url: '/dl',
      fetchImpl,
      documentImpl: doc as any,
    })

    const blob = create.mock.calls[0][0] as Blob
    const out = new Uint8Array(await blob.arrayBuffer())
    let crlfOut = 0
    let bareLf = 0
    for (let i = 0; i < out.length; i++) {
      if (
        out[i] === 0x0a &&
        (i === 0 || out[i - 1] !== 0x0d)
      ) {
        bareLf++
      }
      if (out[i] === 0x0d && out[i + 1] === 0x0a) crlfOut++
    }
    expect(crlfOut).toBe(crlf)
    expect(bareLf).toBe(0)
  })
})
