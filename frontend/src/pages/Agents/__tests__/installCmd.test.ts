/**
 * buildLinuxInstallCmd — Linux installer command builder tests.
 *
 * The Windows command builder was removed in the WIN-FRONTEND
 * post-CI review #2; the only safe UX for Windows is the .ps1 file
 * download (see windowsInstallerDownload.test.ts). Linux keeps the
 * historical, byte-identical curl + sudo bash one-liner.
 */
import { describe, it, expect } from 'vitest'
import { buildLinuxInstallCmd } from '../installCmd'


const FAKE_KEY = 'abcdef-1234-fake-agent-key'
const FAKE_URL =
  'https://netmanager.example.app/api/v1/agents/test-agent-007/download/linux?server_url=https%3A%2F%2Fnetmanager.example.app'


describe('buildLinuxInstallCmd — historical contract preserved', () => {
  it('placeholders absent', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toContain('<AGENT_ID>')
    expect(out).not.toContain('<AGENT_KEY>')
  })

  it('exact legacy shape preserved (single-line curl pipe sudo bash)', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toBe(
      `curl -fsSL -H 'X-Agent-Key: ${FAKE_KEY}' '${FAKE_URL}' | sudo bash`,
    )
  })

  it('single line', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out.split('\n').length).toBe(1)
  })

  it('no Windows-specific token leaks in', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toContain('SecurityProtocol')
    expect(out).not.toContain('iwr')
    expect(out).not.toContain('Invoke-WebRequest')
    expect(out).not.toContain('Set-ExecutionPolicy')
    expect(out).not.toContain('powershell.exe')
    expect(out).not.toContain('-OutFile')
    expect(out).not.toContain('-File')
  })

  it('does not contain | iex or Invoke-Expression', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/\|\s*iex\b/)
    expect(out).not.toContain('Invoke-Expression')
  })
})


describe('Windows command builder removed (review #2)', () => {
  it('no exported buildWindowsInstallCmd / SAFE_* / isValid* symbols', async () => {
    // Importing them must fail at type level. We assert by reading
    // the source for the absence of the symbols rather than relying
    // on TS to fail compilation, so this test is robust to refactors.
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../installCmd.ts'),
      'utf-8',
    )
    expect(src).not.toMatch(/\bbuildWindowsInstallCmd\b/)
    expect(src).not.toMatch(/\bSAFE_DOWNLOAD_ERROR_MESSAGE_TR\b/)
    expect(src).not.toMatch(/\bSAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR\b/)
    expect(src).not.toMatch(/\bisValidWindowsInstallerScript\b/)
  })
})
