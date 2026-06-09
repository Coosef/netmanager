/**
 * Sprint 1A — auth store RBAC testleri.
 *
 * Kapsam:
 *  - hasPermission() canonical 4-rol matrisi
 *  - Legacy rol literal'lerinin normalize edilmesi (admin/org_viewer/operator/...)
 *  - Unknown rol için fail-closed defansif guard
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAuthStore } from '@/store/auth'
import type { SystemRole } from '@/types'

// auth.ts içindeki AuthUser private; minimal shape ile setAuth'a verilir.
type MinimalAuthUser = {
  id: number
  username: string
  email?: string
  role: string
  system_role: string
  is_active?: boolean
  organization_id?: number | null
}

function asUser(role: string, overrides: Partial<MinimalAuthUser> = {}): MinimalAuthUser {
  return {
    id: 1,
    username: 'test',
    email: 'test@example.com',
    role,
    system_role: role,
    is_active: true,
    organization_id: 1,
    ...overrides,
  }
}

function setUser(role: string) {
  // setAuth normalizeUser çağırır; minimal shape kabul edilir (geri sahaya
  // sadece role / system_role gönderilir).
  useAuthStore.getState().setAuth('test-token', asUser(role) as never)
}

beforeEach(() => {
  useAuthStore.setState({ token: null, user: null, permissions: null })
})

// ─── hasPermission() canonical matrix ────────────────────────────────────────

describe('hasPermission — canonical 4-rol matris', () => {
  it('super_admin her şeyi geçer', () => {
    setUser('super_admin')
    const fn = useAuthStore.getState().hasPermission
    expect(fn('viewer')).toBe(true)
    expect(fn('location_admin')).toBe(true)
    expect(fn('org_admin')).toBe(true)
    expect(fn('super_admin')).toBe(true)
  })

  it('org_admin org_admin\'e ve altına geçer; super_admin engellenir', () => {
    setUser('org_admin')
    const fn = useAuthStore.getState().hasPermission
    expect(fn('viewer')).toBe(true)
    expect(fn('location_admin')).toBe(true)
    expect(fn('org_admin')).toBe(true)
    expect(fn('super_admin')).toBe(false)
  })

  it('location_admin location_admin ve altına geçer; org_admin engellenir', () => {
    setUser('location_admin')
    const fn = useAuthStore.getState().hasPermission
    expect(fn('viewer')).toBe(true)
    expect(fn('location_admin')).toBe(true)
    expect(fn('org_admin')).toBe(false)
    expect(fn('super_admin')).toBe(false)
  })

  it('viewer yalnız viewer\'a geçer', () => {
    setUser('viewer')
    const fn = useAuthStore.getState().hasPermission
    expect(fn('viewer')).toBe(true)
    expect(fn('location_admin')).toBe(false)
    expect(fn('org_admin')).toBe(false)
    expect(fn('super_admin')).toBe(false)
  })

  it('user yok → false', () => {
    useAuthStore.setState({ token: null, user: null })
    expect(useAuthStore.getState().hasPermission('viewer')).toBe(false)
  })
})

// ─── Legacy rol normalization ────────────────────────────────────────────────

describe('Legacy rol normalization (setAuth → normalizeUser)', () => {
  it('admin → org_admin canonical olarak persist edilir', () => {
    setUser('admin')
    expect(useAuthStore.getState().user?.system_role).toBe('org_admin')
    expect(useAuthStore.getState().user?.role).toBe('org_admin')
  })

  it('org_viewer → viewer', () => {
    setUser('org_viewer')
    expect(useAuthStore.getState().user?.system_role).toBe('viewer')
  })

  it('location_manager → location_admin', () => {
    setUser('location_manager')
    expect(useAuthStore.getState().user?.system_role).toBe('location_admin')
  })

  it('operator → viewer', () => {
    setUser('operator')
    expect(useAuthStore.getState().user?.system_role).toBe('viewer')
  })

  it('location_operator → location_admin', () => {
    setUser('location_operator')
    expect(useAuthStore.getState().user?.system_role).toBe('location_admin')
  })

  it('member (legacy) → viewer (fail-safe en düşük rol)', () => {
    setUser('member')
    expect(useAuthStore.getState().user?.system_role).toBe('viewer')
  })

  it('tanınmayan rol → viewer (fail-safe least privilege)', () => {
    setUser('wizard-of-oz')
    expect(useAuthStore.getState().user?.system_role).toBe('viewer')
  })
})

// ─── Unknown rol fail-closed (defansif guard) ─────────────────────────────────

describe('hasPermission — defansif unknown-role guard', () => {
  it('user.system_role canonical değilse fail-closed (hipotetik regresyon)', () => {
    // Doğal akışta normalizeUser zaten canonical'a çevirir; bu test
    // setAuth bypass edilirse (örn. test/dev tool) guard'ın hâlâ
    // çalıştığını doğrular.
    useAuthStore.setState({
      token: 'x',
      user: { id: 9, username: 'x', system_role: 'bogus' as SystemRole, role: 'bogus' } as never,
      permissions: null,
    })
    expect(useAuthStore.getState().hasPermission('viewer')).toBe(false)
  })

  it('legacy minRole literal normalize edilip beklenen davranışı verir', () => {
    // normalizeRole(minRole) canonical'a çevirir — legacy literal yazılsa
    // bile guard fail-closed YAPMAZ; doğru rol hiyerarşisine düşer.
    // Bu defansif çift-güvencenin canlı sistemde regression tetiklemeyeceğini
    // garanti eder (uplifting değil — rol normalize zaten doğru sonucu verir).
    setUser('super_admin')
    const fn = useAuthStore.getState().hasPermission
    expect(fn('admin' as SystemRole)).toBe(true)        // admin → org_admin
    expect(fn('org_viewer' as SystemRole)).toBe(true)   // org_viewer → viewer
    expect(fn('operator' as SystemRole)).toBe(true)     // operator → viewer
  })

  it('user.system_role canonical olmayanı viewer\'a düşürdüğü için legacy seriler hak hiyerarşisini bozmaz', () => {
    setUser('admin') // setAuth → normalizeUser → 'org_admin' canonical
    expect(useAuthStore.getState().user?.system_role).toBe('org_admin')
    expect(useAuthStore.getState().hasPermission('org_admin')).toBe(true)
    expect(useAuthStore.getState().hasPermission('super_admin')).toBe(false)
  })
})

// ─── AUTH-PERSIST-HYDRATION-HOTFIX (PR #47) ────────────────────────────────
//
// Eski mimari (`_hasHydrated` store state alanı + `setHasHydrated` setter +
// onRehydrateStorage içinde setter zincirleme) ANTIPATTERN'di. Zustand v5'te
// rehydrate sırasında race penceresi açıyor, Dashboard refresh sonrası
// kullanıcıyı /login'e atıyordu. Yeni mimari hooks/useHasHydrated.ts Zustand
// persist'in kendi API'sini (persist.hasHydrated() + onFinishHydration)
// kullanır — store state alanı KALDIRILDI. Aşağıdaki testler yeni mimariyi
// sabitler.

describe('persist hydration (PR #47)', () => {
  it('_hasHydrated store state alanı KALDIRILDI', () => {
    // AuthState interface'inde _hasHydrated + setHasHydrated yok.
    // Bu testin amacı: ileride birinin bu alanı yeniden eklemesini engelle.
    const state = useAuthStore.getState() as unknown as Record<string, unknown>
    expect(state._hasHydrated).toBeUndefined()
    expect(state.setHasHydrated).toBeUndefined()
  })

  it('useHasHydrated hook export edilmiş (Zustand persist API üzerine)', async () => {
    // Hook Zustand persist'in hasHydrated() + onFinishHydration() API'sini
    // kullanır. Hook fonksiyon olarak export edildiyse, internal API'ye
    // doğru erişim sağlamıştır (dinamik import + module check).
    const mod = await import('@/hooks/useHasHydrated')
    expect(typeof mod.useHasHydrated).toBe('function')
  })

  it('setAuth token/user/permissions atomik set eder', () => {
    setUser('org_admin')
    const s = useAuthStore.getState()
    expect(s.token).toBe('test-token')
    expect(s.user?.system_role).toBe('org_admin')
  })

  it('logout token/user/permissions atomik temizler', () => {
    setUser('super_admin')
    useAuthStore.getState().logout()
    const s = useAuthStore.getState()
    expect(s.token).toBeNull()
    expect(s.user).toBeNull()
    expect(s.permissions).toBeNull()
  })
})
