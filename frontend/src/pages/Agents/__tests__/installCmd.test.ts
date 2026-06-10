/**
 * Agent installer komut üreticileri — Linux + Windows.
 *
 * Bu testler ÇIKTI KONTRAT'ını sabitler. Mevcut PR #67 davranışına ek olarak
 * 2026-06-11 minimal güvenlik sıkılaştırmaları:
 *   - Multiline backtick line-continuation
 *   - Script validation helper
 *   - Hata mesajları generic (response body / agent key sızdırmaz)
 */
import { describe, it, expect } from 'vitest'
import {
  buildLinuxInstallCmd,
  buildWindowsInstallCmd,
  isValidWindowsInstallerScript,
  SAFE_DOWNLOAD_ERROR_MESSAGE_TR,
  SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR,
} from '../installCmd'


const FAKE_KEY = 'abcdef-1234-fake-agent-key'
const FAKE_URL =
  'https://netmanager.example.app/api/v1/agents/test-agent-007/download/windows?server_url=https%3A%2F%2Fnetmanager.example.app'


// ── Windows komut testleri ─────────────────────────────────────────────────


describe('buildWindowsInstallCmd — PS 5.1 multiline + TLS 1.2', () => {
  it('placeholder ASLA çıkmamalı', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    for (const p of ['<AGENT_ID>', '<AGENT_KEY>', 'REAL_AGENT_ID', 'REAL_AGENT_KEY', 'YOUR_KEY']) {
      expect(out).not.toContain(p)
    }
  })

  it('gerçek agent key çıktıda X-Agent-Key header value olarak', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toContain(FAKE_KEY)
    expect(out).toMatch(/"X-Agent-Key"\s*=\s*"abcdef-1234-fake-agent-key"/)
  })

  it('gerçek downloadUrl çıktıda', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toContain(FAKE_URL)
    expect(out).toMatch(/api\/v1\/agents\/test-agent-007\/download\/windows/)
    expect(out).toContain('server_url=https%3A%2F%2F')
  })

  it('TLS 1.2 satırı ilk 3 satır içinde', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    const lines = out.split('\n')
    const tlsLine = lines.findIndex((l) =>
      l.includes('SecurityProtocol') && l.includes('Tls12'),
    )
    expect(tlsLine).toBeGreaterThan(-1)
    expect(tlsLine).toBeLessThan(3)
  })

  it('PS 7-only `?.`, `??`, `-Parallel` YOK', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/[\w\)\]]\?\./)
    expect(out).not.toContain('??')
    expect(out).not.toContain('-Parallel')
  })

  it('pwsh executable çağrısı YOK', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/\bpwsh\b/)
  })

  it('eski tek-satır `powershell -c "$h=..."` legacy YOK', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toMatch(/powershell\s+-ExecutionPolicy\s+Bypass\s+-c\s+"\$h=@\{/)
    expect(out).not.toContain('"$h=@{')
  })

  it('multiline + backtick line-continuation pattern', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(8)
    // backtick (`) line-continuation iwr çağrısının sonunda
    expect(out).toMatch(/iwr\s+`/)
    // $hdr = @{ multiline yapısı
    expect(out).toMatch(/\$hdr\s*=\s*@\{/)
  })

  it('Set-ExecutionPolicy Bypass -Scope Process satırı', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toContain('Set-ExecutionPolicy Bypass -Scope Process -Force')
  })

  it('Yönetici hint yorum satırı (ASCII güvenli)', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    const firstLine = out.split('\n')[0]
    expect(firstLine.startsWith('#')).toBe(true)
    expect(firstLine.toLowerCase()).toContain('yonetici')
    expect(firstLine.toLowerCase()).toContain('ps 5.1')
  })

  it('-UseBasicParsing kullanır', () => {
    const out = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toContain('-UseBasicParsing')
    expect(out).toMatch(/\|\s*\n\s*iex/)
  })

  it('Server URL değişince komut yeniden üretilir (idempotent)', () => {
    const a = buildWindowsInstallCmd(FAKE_KEY, FAKE_URL)
    const b = buildWindowsInstallCmd(
      FAKE_KEY,
      'https://other.example.app/api/v1/agents/other-agent/download/windows?server_url=https%3A%2F%2Fother.example.app',
    )
    expect(a).not.toBe(b)
    expect(b).toContain('other.example.app')
    expect(b).not.toContain('test-agent-007')
  })

  it('Defansif: key özel karakter içerse bile placeholder YOK', () => {
    const tricky = 'tricky\'key"with-special'
    const out = buildWindowsInstallCmd(tricky, FAKE_URL)
    expect(out).toContain(tricky)
    expect(out).not.toContain('<AGENT_KEY>')
  })
})


// ── Linux komut testleri (mevcut davranış korundu) ─────────────────────────


describe('buildLinuxInstallCmd — değişmedi', () => {
  it('placeholder YOK', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toContain('<AGENT_ID>')
    expect(out).not.toContain('<AGENT_KEY>')
  })

  it('curl -fsSL pattern korundu', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).toContain('curl -fsSL')
    expect(out).toContain(`-H 'X-Agent-Key: ${FAKE_KEY}'`)
    expect(out).toContain(`'${FAKE_URL}'`)
    expect(out).toMatch(/\|\s*sudo\s+bash$/)
  })

  it('tek satır — multiline değil', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out.split('\n').length).toBe(1)
  })

  it('Windows-specific TLS / PowerShell pattern YOK', () => {
    const out = buildLinuxInstallCmd(FAKE_KEY, FAKE_URL)
    expect(out).not.toContain('SecurityProtocol')
    expect(out).not.toContain('iwr')
    expect(out).not.toContain('Set-ExecutionPolicy')
  })
})


// ── Windows script validation testleri ─────────────────────────────────────


describe('isValidWindowsInstallerScript — backend response sanity check', () => {
  const valid = `
# NetManager Proxy Agent — Windows Kurulum Betiği
$AgentId = 'test-agent'
$AgentKey = 'test-key'
$BackendUrl = 'https://example.app'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "OK"
`

  it('geçerli script → true', () => {
    expect(isValidWindowsInstallerScript(valid)).toBe(true)
  })

  it('boş string → false', () => {
    expect(isValidWindowsInstallerScript('')).toBe(false)
  })

  it('null/undefined → false', () => {
    expect(isValidWindowsInstallerScript(null as any)).toBe(false)
    expect(isValidWindowsInstallerScript(undefined as any)).toBe(false)
  })

  it('$AgentKey eksik → false', () => {
    const broken = valid.replace('$AgentKey', '$Other')
    expect(isValidWindowsInstallerScript(broken)).toBe(false)
  })

  it('Tls12 satırı eksik → false', () => {
    const broken = valid.replace('Tls12', 'Tls10')
    expect(isValidWindowsInstallerScript(broken)).toBe(false)
  })

  it('`?.Source` (PS 7-only) varsa → false', () => {
    const broken =
      valid + `\n$cmd = (Get-Command python -ErrorAction SilentlyContinue)?.Source`
    expect(isValidWindowsInstallerScript(broken)).toBe(false)
  })

  it('$BackendUrl eksik → false', () => {
    const broken = valid.replace('$BackendUrl', '$Other')
    expect(isValidWindowsInstallerScript(broken)).toBe(false)
  })
})


// ── Güvenli hata mesajları (sızıntı koruması) ──────────────────────────────


describe('SAFE error messages — backend response body sızdırmaz', () => {
  it('Generic download error', () => {
    expect(SAFE_DOWNLOAD_ERROR_MESSAGE_TR).toContain('Windows kurulum betiği indirilemedi')
    // HTTP status / response body referansı YOK
    expect(SAFE_DOWNLOAD_ERROR_MESSAGE_TR).not.toMatch(/HTTP|401|403|500|Bearer|key/i)
  })

  it('Generic validation error', () => {
    expect(SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR).toContain('doğrulanamadı')
    expect(SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR).not.toMatch(/HTTP|status|body|response/i)
  })
})
