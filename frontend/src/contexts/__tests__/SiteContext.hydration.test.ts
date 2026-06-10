/**
 * SiteContext — DASHBOARD-INIT-ROUTER-FIX sözleşmesi (2026-06-10).
 *
 * Browser-side bulgular:
 *   · Login sonrası URL /dashboard AMA Router internal state'te kalan
 *     race + SiteContext mid-fetch + token interceptor race üretiyor.
 *   · /api/v1/context/current ilk istek 401 dönebiliyor (token persist
 *     hidrasyon race).
 *   · stuck `ctx: undefined` LocationGate/Dashboard render hattını
 *     boş bırakıyor.
 *
 * Bu testler kaynak düzeyinde:
 *   · `useHasHydrated` import edilir + kullanılır
 *   · useQuery `enabled` koşulu `!!token && hydrated` (race guard)
 *   · `retry: 1` + `retryDelay: 500` (transient 401 recovery)
 *   · queryKey + activeLocationId pattern korundu (regresyon yok)
 *
 * Mevcut codebase pattern: kaynak string-match smoke (jsdom yok).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../SiteContext.tsx'),
  'utf-8',
)


describe('SiteContext — hidrasyon guard + retry sözleşmesi', () => {
  it('useHasHydrated import edilir', () => {
    expect(SRC).toContain("from '@/hooks/useHasHydrated'")
    expect(SRC).toMatch(/import.*useHasHydrated/)
  })

  it('hydrated hook çağrısı VAR', () => {
    expect(SRC).toMatch(/const hydrated = useHasHydrated\(\)/)
  })

  it('useQuery enabled: !!token && hydrated (race guard)', () => {
    expect(SRC).toMatch(/enabled:\s*!!token\s*&&\s*hydrated/)
    // Eski tek-token enabled REGRESYON guard
    expect(SRC).not.toMatch(/enabled:\s*!!token\s*,/)
  })

  it('retry: 1 + retryDelay: 500 (transient 401 recovery)', () => {
    expect(SRC).toMatch(/retry:\s*1/)
    expect(SRC).toMatch(/retryDelay:\s*500/)
  })

  it('queryKey activeLocationId taşıyor (regresyon: pattern korundu)', () => {
    expect(SRC).toMatch(/queryKey:\s*\['context',\s*'current',\s*activeLocationId\]/)
  })

  it('queryFn contextApi.current çağrısı korundu', () => {
    expect(SRC).toMatch(/queryFn:\s*\(\)\s*=>\s*contextApi\.current\(\)/)
  })

  it('staleTime: 60_000 korundu (refetch politikası değişmedi)', () => {
    expect(SRC).toMatch(/staleTime:\s*60_000/)
  })
})


describe('SiteContext — shouldReconcileLocation regresyon (Faz 8 davranışı korundu)', () => {
  it('shouldReconcileLocation function imzası korundu', () => {
    expect(SRC).toMatch(/export function shouldReconcileLocation/)
    expect(SRC).toContain('is_org_wide')
    expect(SRC).toContain('allowed_location_ids')
  })
})
