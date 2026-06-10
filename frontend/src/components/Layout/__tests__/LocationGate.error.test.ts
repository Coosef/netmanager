/**
 * LocationGate — LOGIN-DIRECT-NAVIGATE-FIX (2026-06-10) error fallback.
 *
 * Bug #2: `/context/current` transient fail sonrası `ctx undefined` kaldığında
 * kullanıcı blank screen görüyordu (LocationGate defansif `?? true` ile
 * children render ediyordu AMA features:{} → widget'lar gizleniyordu).
 *
 * Bu testler kaynak düzeyinde:
 *   · sitesError state'i okunur
 *   · sitesError → görünür Result + Yenile butonu (blank YOK)
 *   · refetchSite çağrı bağlandı
 *   · mevcut sitesLoading + hasLocationAccess davranışları korundu
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../LocationGate.tsx'),
  'utf-8',
)


describe('LocationGate — error fallback sözleşmesi', () => {
  it('useSite\'tan refetchSite + hasContextFailure alıyor', () => {
    expect(SRC).toMatch(/refetchSite/)
    expect(SRC).toMatch(/hasContextFailure/)
    expect(SRC).toMatch(
      /const\s*\{[\s\S]*?hasContextFailure[\s\S]*?\}\s*=\s*useSite\(\)/,
    )
  })

  it('hasContextFailure true ise görünür Result render edilir (blank YOK)', () => {
    expect(SRC).toMatch(/if\s*\(hasContextFailure\)/)
    expect(SRC).toContain('<Result')
    expect(SRC).toContain('status="warning"')
    expect(SRC).toContain('data-testid="location-gate-error"')
  })

  it('error metin i18n key kullanır (locale dosyalarında 4 dilde mevcut)', () => {
    expect(SRC).toContain("t('location_gate.error_title')")
    expect(SRC).toContain("t('location_gate.error_desc')")
    expect(SRC).toContain("t('location_gate.retry')")
  })

  it('refetchSite Yenile butonuna bağlı', () => {
    expect(SRC).toMatch(/onClick=\{?\(?\)?\s*=>\s*refetchSite\(\)/)
    expect(SRC).toContain('ReloadOutlined')
  })

  it('sitesLoading davranışı korundu (mevcut Spin)', () => {
    expect(SRC).toMatch(/if\s*\(sitesLoading\)/)
    expect(SRC).toContain('<Spin')
    expect(SRC).toContain('location_gate.resolving')
  })

  it('hasLocationAccess false davranışı korundu', () => {
    expect(SRC).toMatch(/if\s*\(!hasLocationAccess\)/)
    expect(SRC).toContain('<NoLocationAccess')
  })

  it('children fallback hala mevcut', () => {
    expect(SRC).toMatch(/return\s*<>\{children\}<\/>/)
  })
})


// ── SiteContext sitesError + refetchSite expose etmeli ─────────────────────


const SITE_SRC = readFileSync(
  resolve(__dirname, '../../../contexts/SiteContext.tsx'),
  'utf-8',
)


describe('SiteContext — sitesError + refetchSite expose', () => {
  it('useQuery isError + refetch destructure ediliyor', () => {
    expect(SITE_SRC).toMatch(/isError/)
    expect(SITE_SRC).toMatch(/refetch[,\s\}]/)
  })

  it('sitesError: isError && !ctx (transient stale cache koruması)', () => {
    expect(SITE_SRC).toMatch(/sitesError[^=]*=\s*isError\s*&&\s*!ctx/)
  })

  it('refetchSite fonksiyonu refetch çağırır', () => {
    expect(SITE_SRC).toMatch(/refetchSite\s*=\s*\(\)\s*=>\s*\{\s*refetch\(\)\s*\}/)
  })

  it('SiteCtx type sitesError + refetchSite içeriyor', () => {
    expect(SITE_SRC).toMatch(/sitesError:\s*boolean/)
    expect(SITE_SRC).toMatch(/refetchSite:\s*\(\)\s*=>\s*void/)
  })

  it('Provider value sitesError + hasContextFailure + refetchSite expose ediyor', () => {
    expect(SITE_SRC).toMatch(/sitesError,/)
    expect(SITE_SRC).toMatch(/hasContextFailure,/)
    expect(SITE_SRC).toMatch(/refetchSite,/)
  })

  it('hasContextFailure birleşik flag: sitesError || (!sitesLoading && !ctx && ...)', () => {
    expect(SITE_SRC).toMatch(/hasContextFailure[^=]*=\s*sitesError\s*\|\|/)
    expect(SITE_SRC).toMatch(/!sitesLoading\s*&&\s*!ctx/)
  })
})
