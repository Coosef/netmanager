/**
 * RootRedirect — auth + hidrasyon temelli güvenli `/` route handler.
 *
 * P0 LOGIN-AUTH-LOOP-FIX sözleşmesini sabitler.
 *
 * Test stratejisi: Mevcut codebase pattern'iyle uyumlu (import-smoke +
 * kaynak kod string-match — bkz. sw-killswitch.test.ts). React hook
 * dispatch'i jsdom olmadan render edilemez; component contract'ı kaynak
 * düzeyinde regression koruması altına alınır.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../RootRedirect.tsx'),
  'utf-8',
)


describe('RootRedirect — modül import smoke', () => {
  it('default export var', async () => {
    const mod = await import('../RootRedirect')
    expect(mod.default).toBeTypeOf('function')
  })
})


describe('RootRedirect — sözleşme kaynak düzeyinde sabit', () => {
  it('useHasHydrated hook\'u import edilir + kullanılır', () => {
    expect(SRC).toContain("from '@/hooks/useHasHydrated'")
    expect(SRC).toMatch(/const hydrated = useHasHydrated\(\)/)
  })

  it('useAuthStore üzerinden token okuması yapılır', () => {
    expect(SRC).toContain("from '@/store/auth'")
    expect(SRC).toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.token\)/)
  })

  it('token-first karar matrisi: token VAR ise hidrasyon kontrolünden ÖNCE /dashboard', () => {
    // AUTH-GUARD-TOKEN-FIRST-FIX (2026-06-10): token kontrolü ilk sırada
    expect(SRC).toMatch(
      /if\s*\(token\)\s*return\s*<Navigate\s+to="\/dashboard"\s+replace\s*\/>[\s\S]*?if\s*\(!hydrated\)/,
    )
  })

  it('token YOK + !hydrated → görünür Spin (blank YOK)', () => {
    expect(SRC).toMatch(/if\s*\(!hydrated\)/)
    expect(SRC).toContain('Spin')
    expect(SRC).toContain("data-testid=\"root-redirect-loading\"")
  })

  it("authenticated → <Navigate to=\"/dashboard\" replace />", () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/dashboard"\s+replace\s*\/>/)
  })

  it("unauthenticated → <Navigate to=\"/login\" replace />", () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/login"\s+replace\s*\/>/)
  })

  it("`/` rotasına ASLA navigate YAPMAZ (infinite loop guard)", () => {
    // Tüm <Navigate> kullanımları `/dashboard` veya `/login` — salt `'/'` YOK.
    // Regex sıkı: `to="/"` ardından whitespace veya `/>` gelecek
    // (`to="/dashboard"` match'lemesin).
    expect(SRC).not.toMatch(/<Navigate\s+to="\/"[\s/]/)
    // navigate('/') runtime çağrısı YOK. Yorum/dokümantasyon satırlarında
    // (`//` veya `*`) örnek olarak geçebilir — onları filter et.
    const code = SRC
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l.trim()))
      .join('\n')
    expect(code).not.toMatch(/\bnavigate\(['"]\/['"][,)]/)
  })

  it("`replace` her iki Navigate'te de kullanılır (history pollution yok)", () => {
    // <Navigate ... /> tag'ları yakala (kapanış `/>` öncesi içerikte `/`
    // olabilir — `to="/dashboard"`). Eksik açgözlü grupla.
    const navigateMatches = SRC.match(/<Navigate\s[^>]*?\/>/g) || []
    expect(navigateMatches.length).toBeGreaterThanOrEqual(2)
    for (const m of navigateMatches) {
      expect(m).toContain('replace')
    }
  })
})
