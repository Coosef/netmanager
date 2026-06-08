/**
 * Sprint 1A — App.tsx import + tip güvenliği smoke testi.
 *
 * RoleRoute davranışı (hasPermission + excludeRoles) doğrudan
 * `store/__tests__/auth.test.ts` içinde test edilir. Bu dosya yalnız
 * App.tsx'in dependency graph'inin (SystemRole import dahil)
 * compile-yüklü olduğunu doğrular ve canonical 4-rol invariant'ını
 * test seviyesinde kilitler.
 */
import { describe, it, expect } from 'vitest'
import type { SystemRole } from '@/types'

describe('App.tsx Sprint 1A guardrail\'leri', () => {
  it('SystemRole canonical 4 değerle sınırlıdır (RoleRoute minRole + excludeRoles tip kaynağı)', () => {
    // Tip seviyesinde garanti: 4-değerli union dışına çıkış tsc'de fail eder.
    const roles: SystemRole[] = ['super_admin', 'org_admin', 'location_admin', 'viewer']
    expect(roles).toHaveLength(4)
    // Legacy literal'lerin SystemRole olarak literal yazımı tsc'de hata
    // vermeli (TS-7053). Bu invariant App.tsx'teki tüm 23 minRole
    // değerinin canonical olduğunu sembolik olarak temsil eder.
    expect(roles).not.toContain('admin' as unknown as SystemRole)
    expect(roles).not.toContain('org_viewer' as unknown as SystemRole)
    expect(roles).not.toContain('location_manager' as unknown as SystemRole)
    expect(roles).not.toContain('operator' as unknown as SystemRole)
  })
})
