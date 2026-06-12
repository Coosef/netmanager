/**
 * NocAgents handleDownload — wiring + security contract (source-match).
 *
 * The byte-perfect download mechanics live in
 * `windowsInstallerDownload.ts` and have their own unit tests
 * (`windowsInstallerDownload.test.ts`). This file confirms that
 * NocAgents wires the helper in correctly and the legacy
 * `res.text()` + `Blob(text)` pattern is gone.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../NocAgents.tsx'),
  'utf-8',
)

describe('NocAgents handleDownload — wiring + security', () => {
  it('imports the byte-perfect helper, not the legacy res.text() flow', () => {
    expect(SRC).toMatch(/from\s+['"]\.\/windowsInstallerDownload['"]/)
    expect(SRC).toContain('downloadWindowsInstaller')
  })

  it('keeps the existing command-builder helpers', () => {
    expect(SRC).toMatch(/from\s+['"]\.\/installCmd['"]/)
    expect(SRC).toContain('buildLinuxInstallCmd')
    expect(SRC).toContain('buildWindowsInstallCmd')
  })

  it('does NOT round-trip the response through res.text()', () => {
    expect(SRC).not.toContain('res.text()')
    expect(SRC).not.toContain('await res.text()')
  })

  it('does NOT construct a Blob from a decoded string', () => {
    // Legacy: `new Blob([text], ...)` -- text was a decoded string.
    // The new helper builds the Blob from the original ArrayBuffer
    // so byte parity is preserved.
    expect(SRC).not.toMatch(/new\s+Blob\(\s*\[\s*text\s*\]/)
  })

  it('keeps the concurrent download guard', () => {
    expect(SRC).toMatch(/if\s*\(\s*downloading\s*\)\s*return/)
  })

  it('passes the agent key as the X-Agent-Key header argument (not in the URL)', () => {
    // Helper call shape: downloadWindowsInstaller({ ..., agentKey: agent.agent_key, ... })
    expect(SRC).toMatch(/downloadWindowsInstaller\(/)
    expect(SRC).toMatch(/agentKey:\s*agent\.agent_key/)
    // Forbid agent_key in the URL.
    expect(SRC).not.toMatch(/[?&]agent_key=/)
    expect(SRC).not.toMatch(/[?&]X-Agent-Key=/)
  })

  it('uses generic, secret-free user-facing error messages via i18n', () => {
    expect(SRC).toContain("t('agents.windows_download_failed')")
    expect(SRC).toContain("t('agents.windows_validation_failed')")
    // Legacy SAFE_*_TR constants are gone (moved to i18n)
    expect(SRC).not.toContain('SAFE_DOWNLOAD_ERROR_MESSAGE_TR')
    expect(SRC).not.toContain('SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR')
  })

  it('does not log or alert anything containing the agent key', () => {
    expect(SRC).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*agent\.agent_key/)
    expect(SRC).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*agentKey/)
    expect(SRC).not.toMatch(/alert\(\s*agent\.agent_key/)
    expect(SRC).not.toMatch(/alert\(\s*e\?.message\s*\)/)
    expect(SRC).not.toMatch(/alert\([^)]*\+\s*e\.message/)
  })

  it('preserves the existing /api/v1/agents/{id}/download/windows endpoint shape', () => {
    expect(SRC).toMatch(/\/api\/v1\/agents\/\$\{agent\.id\}\/download\/windows/)
    expect(SRC).toMatch(/encodeURIComponent\(base\)/)
  })

  it('preserves the Linux downloadInstallerFile call site verbatim', () => {
    expect(SRC).toContain(
      'agentsApi.downloadInstallerFile(agent.id, agent.agent_key, platform, base)',
    )
  })

  it('keeps exactly one DownloadOutlined Button (single primary download)', () => {
    const matches = SRC.match(/<Button[^>]*icon=\{<DownloadOutlined[^>]*\/>\}/g) || []
    expect(matches.length).toBe(1)
  })

  it('does not contain iwr | iex or Invoke-Expression patterns', () => {
    expect(SRC).not.toMatch(/\|\s*iex\b/)
    expect(SRC).not.toContain('Invoke-Expression')
  })

  it('renders the primary-download hint via i18n', () => {
    expect(SRC).toContain("t('agents.windows_download_primary_hint')")
  })
})
