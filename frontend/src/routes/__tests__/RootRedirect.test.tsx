/**
 * RootRedirect — auth + hidrasyon + ROLE temelli güvenli `/` route handler.
 *
 * P0 LOGIN-AUTH-LOOP-FIX sözleşmesini sabitler. PR-A (2026-06-22):
 * rolü gözeten matrise dönüştürüldü:
 *   super_admin  → /platform/overview
 *   normal user  → /app/org/<orgId>/dashboard (URL-authoritative)
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

  it('useAuthStore üzerinden token + user okuması yapılır', () => {
    expect(SRC).toContain("from '@/store/auth'")
    expect(SRC).toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.token\)/)
    expect(SRC).toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.user\)/)
  })

  it('useSite üzerinden ctxResolved + activeOrgId + isPlatformSuperAdmin okunur', () => {
    expect(SRC).toContain("from '@/contexts/SiteContext'")
    expect(SRC).toContain('ctxResolved')
    expect(SRC).toContain('activeOrgId')
    expect(SRC).toContain('isPlatformSuperAdmin')
  })

  it('token YOK + !hydrated → görünür Spin (blank YOK)', () => {
    expect(SRC).toMatch(/if\s*\(!hydrated\)/)
    expect(SRC).toContain('Spin')
    expect(SRC).toContain("data-testid=\"root-redirect-loading\"")
  })

  it('token YOK + hydrated → /login', () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/login"\s+replace\s*\/>/)
  })

  it('super_admin (ROLE) → /platform/overview', () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/platform\/overview"\s+replace\s*\/>/)
    expect(SRC).toMatch(/user\.system_role\s*===\s*'super_admin'/)
  })

  it('normal kullanıcı + org_id → /app/org/<id>/dashboard', () => {
    expect(SRC).toMatch(
      /<Navigate\s+to=\{`\/app\/org\/\$\{resolvedOrgId\}\/dashboard`\}\s+replace\s*\/>/,
    )
  })

  it('resolution order: user.org_id → activeOrgId (JWT öncelik)', () => {
    expect(SRC).toMatch(/user\.org_id\s*\?\?\s*activeOrgId\s*\?\?\s*null/)
  })

  it("`/` rotasına ASLA navigate YAPMAZ (infinite loop guard)", () => {
    // Salt `to="/"` regex'i ile match olmayacak — `to="/login"`,
    // `to="/platform/overview"`, vb. izin verilir.
    expect(SRC).not.toMatch(/<Navigate\s+to="\/"[\s/]/)
  })

  it("`replace` her Navigate'te kullanılır (history pollution yok)", () => {
    const navigateMatches = SRC.match(/<Navigate\s[^>]*?\/>/g) || []
    expect(navigateMatches.length).toBeGreaterThanOrEqual(3)
    for (const m of navigateMatches) {
      expect(m).toContain('replace')
    }
  })
})
