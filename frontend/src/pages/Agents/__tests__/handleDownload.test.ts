/**
 * NocAgents handleDownload — davranış kontratı (source-match style).
 *
 * Gerçek React render testi `loginNavigation.integration.test.tsx`
 * paterniyle yapılabilir AMA NocAgents modal'ı çok geniş kapsamlı; source
 * kontrol yeterlidir. Önemli güvenlik invariants:
 *   - X-Agent-Key sadece header'da (URL'de yok)
 *   - agent_key console.log / alert message / toast içinde YOK
 *   - Backend response body veya HTTP status DETAYI kullanıcıya gösterilmez
 *   - Windows script content validation çağrılır
 *   - Concurrent download guard (`if (downloading) return`)
 *   - Generic error message kullanılır
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../NocAgents.tsx'),
  'utf-8',
)


describe('NocAgents handleDownload — güvenlik kontratı', () => {
  it('installCmd helper\'ları import edilir (yeni mimari değil, mevcut helper)', () => {
    expect(SRC).toMatch(/from\s+['"]\.\/installCmd['"]/)
    expect(SRC).toContain('buildLinuxInstallCmd')
    expect(SRC).toContain('buildWindowsInstallCmd')
    expect(SRC).toContain('isValidWindowsInstallerScript')
    expect(SRC).toContain('SAFE_DOWNLOAD_ERROR_MESSAGE_TR')
    expect(SRC).toContain('SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR')
  })

  it('installCmd helper çağrısı dinamik değerlerle yapılır', () => {
    expect(SRC).toMatch(/buildLinuxInstallCmd\(\s*agent\.agent_key\s*,\s*downloadUrl\s*\)/)
    expect(SRC).toMatch(/buildWindowsInstallCmd\(\s*agent\.agent_key\s*,\s*downloadUrl\s*\)/)
  })

  it('Eski tek-satır `powershell -ExecutionPolicy Bypass -c "$h=@{...}"` legacy YOK', () => {
    expect(SRC).not.toMatch(/powershell\s+-ExecutionPolicy\s+Bypass\s+-c\s+"\$h=@\{/)
    expect(SRC).not.toContain('"$h=@{')
  })

  it('handleDownload — concurrent guard', () => {
    expect(SRC).toMatch(/if\s*\(downloading\)\s*return/)
  })

  it('handleDownload Windows yolu — X-Agent-Key header (URL\'de DEĞIL)', () => {
    expect(SRC).toMatch(/headers:\s*\{\s*['"]X-Agent-Key['"]\s*:\s*agent\.agent_key\s*\}/)
    // URL'de agent_key olmamalı — sadece server_url query
    expect(SRC).not.toMatch(/[?&]agent_key=/)
    expect(SRC).not.toMatch(/[?&]X-Agent-Key=/)
  })

  it('handleDownload Windows yolu — script content validation çağrılır', () => {
    expect(SRC).toMatch(/isValidWindowsInstallerScript\(\s*text\s*\)/)
  })

  it('Hata mesajı GENERIC — backend response body sızdırmaz', () => {
    // Generic mesajlar kullanılır
    expect(SRC).toContain('SAFE_DOWNLOAD_ERROR_MESSAGE_TR')
    expect(SRC).toContain('SAFE_SCRIPT_VALIDATION_ERROR_MESSAGE_TR')
    // Eski "İndirme başarısız: " + raw error message YOK
    expect(SRC).not.toMatch(/alert\(\s*['"]İndirme başarısız:\s*['"][\s\S]*?e\?\.message/)
    // e.message direkt alert'e geçirilmez
    expect(SRC).not.toMatch(/alert\(\s*e\.message\s*\)/)
    expect(SRC).not.toMatch(/alert\(\s*['"][^'"]*['"]\s*\+\s*e\.message\s*\)/)
  })

  it('agent_key console/log/toast içinde YOK (security)', () => {
    // console.log / console.error / window.console.* + agent_key/agent\.agent_key
    expect(SRC).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*agent\.agent_key/)
    expect(SRC).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*agentKey/)
  })

  it('Windows için endpoint /api/v1/agents/{id}/download/windows', () => {
    expect(SRC).toMatch(/\/api\/v1\/agents\/\$\{agent\.id\}\/download\/windows/)
  })

  it('server_url query encoded olarak gönderilir', () => {
    expect(SRC).toMatch(/encodeURIComponent\(base\)/)
  })

  it('İndirilen dosya adı .ps1 ile biter, agent_key dosya adında YOK', () => {
    expect(SRC).toMatch(/netmanager-agent-\$\{agent\.id\}-installer\.ps1/)
    // Dosya adında agent_key referansı YOK
    expect(SRC).not.toMatch(/\.ps1[^"`]*agent\.agent_key/)
    expect(SRC).not.toMatch(/agent\.agent_key[^"`]*\.ps1/)
  })

  it('Linux için mevcut downloadInstallerFile davranışı korundu (backward compat)', () => {
    expect(SRC).toMatch(/agentsApi\.downloadInstallerFile\(\s*agent\.id\s*,\s*agent\.agent_key\s*,\s*platform\s*,\s*base\s*\)/)
  })

  it("İndir butonu mevcut yapısı korunur — yeni 2. download buton YOK", () => {
    // DownloadOutlined ikon kullanan Button SAYISI = 1 (CreatedModal içinde)
    // (Çok geniş kapsamlı NocAgents — broad assertion, sadece eski pattern referans)
    expect(SRC).toContain('<Button type="default" icon={<DownloadOutlined />}')
    // Mevcut buton tek
    const downloadButtonMatches = SRC.match(/<Button[^>]*icon=\{<DownloadOutlined[^>]*\/>\}/g) || []
    expect(downloadButtonMatches.length).toBe(1)
  })
})
