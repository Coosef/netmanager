/**
 * buildLinuxInstallCmd + buildWindowsInstallCmd command builder
 * tests. Windows now uses a file-based path (Invoke-WebRequest
 * -OutFile + powershell.exe -File). iwr | iex is forbidden.
 */
import { describe, it, expect } from 'vitest'
import {
  buildLinuxInstallCmd,
  buildWindowsInstallCmd,
} from '../installCmd'


const FAKE_ID = 'test-agent-007'
const FAKE_KEY = 'abcdef-1234-fake-agent-key'
const FAKE_URL =
  'https://netmanager.example.app/api/v1/agents/test-agent-007/download/windows?server_url=https%3A%2F%2Fnetmanager.example.app'


// ── Windows file-based command ─────────────────────────────────────────────


describe('buildWindowsInstallCmd — file-based PS 5.1 command (no iex)', () => {
  it('placeholders never leak into output', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    for (const p of [
      '<AGENT_ID>',
      '<AGENT_KEY>',
      'REAL_AGENT_ID',
      'REAL_AGENT_KEY',
      'REAL_DYNAMIC_KEY',
      'REAL_DYNAMIC_URL',
      'YOUR_KEY',
    ]) {
      expect(out).not.toContain(p)
    }
  })

  it('real agent key appears only as X-Agent-Key header value', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).toContain(FAKE_KEY)
    expect(out).toMatch(/"X-Agent-Key"\s*=\s*"abcdef-1234-fake-agent-key"/)
  })

  it('real download URL appears as -Uri', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).toContain(FAKE_URL)
    expect(out).toMatch(/-Uri\s+"https:\/\/netmanager\.example\.app/)
  })

  it('TLS 1.2 line first', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out.split('\n')[0]).toContain('Tls12')
  })

  it('uses -OutFile to a $env:TEMP path', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).toContain('-OutFile $installer')
    expect(out).toMatch(/\$installer\s*=\s*Join-Path\s+\$env:TEMP/)
    expect(out).toContain('netmanager-agent-test-agent-007-installer.ps1')
  })

  it('runs the downloaded file via powershell.exe -File', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).toContain('powershell.exe')
    expect(out).toContain('-File $installer')
    expect(out).toContain('-NoProfile')
    expect(out).toContain('-ExecutionPolicy Bypass')
  })

  it('does NOT contain iwr | iex / Invoke-Expression', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/\|\s*iex\b/)
    expect(out).not.toContain('Invoke-Expression')
  })

  it('does NOT use backtick line-continuation (each statement own line)', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/`\s*$/m)
  })

  it('does NOT use PS 7-only syntax', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/[\w\)\]]\?\./)
    expect(out).not.toContain('??')
    expect(out).not.toContain('-Parallel')
  })

  it('does NOT call pwsh', () => {
    const out = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/\bpwsh\b/)
  })

  it('sanitises agent ID into the filename (no traversal chars)', () => {
    const out = buildWindowsInstallCmd(
      '../../../evil/agent\\name',
      FAKE_KEY,
      FAKE_URL,
    )
    expect(out).toContain('netmanager-agent-evilagentname-installer.ps1')
    // Forbidden characters never reach the filename literal
    expect(out).not.toContain('..')
    expect(out).not.toContain('/evil')
    expect(out).not.toContain('\\name')
  })

  it('idempotent: server URL change regenerates the command', () => {
    const a = buildWindowsInstallCmd(FAKE_ID, FAKE_KEY, FAKE_URL)
    const b = buildWindowsInstallCmd(
      'other-agent',
      FAKE_KEY,
      'https://other.example.app/api/v1/agents/other-agent/download/windows?server_url=https%3A%2F%2Fother.example.app',
    )
    expect(a).not.toBe(b)
    expect(b).toContain('other.example.app')
    expect(b).toContain('other-agent')
    expect(b).not.toContain('test-agent-007')
  })

  it('defensive: agent key with quotes still flows through (no placeholder)', () => {
    const tricky = 'tricky\'key"with-special'
    const out = buildWindowsInstallCmd(FAKE_ID, tricky, FAKE_URL)
    expect(out).toContain(tricky)
    expect(out).not.toContain('<AGENT_KEY>')
  })
})


// ── Linux command (UNCHANGED contract) ─────────────────────────────────────


describe('buildLinuxInstallCmd — UNCHANGED', () => {
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

  it('no Windows-specific pattern leaks in', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toContain('SecurityProtocol')
    expect(out).not.toContain('iwr')
    expect(out).not.toContain('Invoke-WebRequest')
    expect(out).not.toContain('Set-ExecutionPolicy')
    expect(out).not.toContain('powershell.exe')
    expect(out).not.toContain('-OutFile')
    expect(out).not.toContain('-File')
  })
})
