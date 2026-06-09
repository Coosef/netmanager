/**
 * Audit Log v2 PR 2 — auditFormatters testleri.
 *
 * Kapsam:
 *   - 12 yaygın action için doğru i18nKey + values
 *   - Bilinmeyen action → kategori bazlı fallback
 *   - Sensitive field detection + masking
 *   - record null/undefined defansif
 *   - failure status → danger tone override
 */
import { describe, it, expect } from 'vitest'
import type { AuditLog } from '@/types'
import {
  formatAuditAction,
  isSensitiveField,
  maskedDisplayValue,
} from '../auditFormatters'

function mkRecord(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 1,
    username: 'admin',
    action: 'login',
    status: 'success',
    created_at: '2026-06-09T15:00:00Z',
    ...overrides,
  } as AuditLog
}

// ─── 12 spesifik formatter ─────────────────────────────────────────────────

describe('formatAuditAction — 12 yaygın action', () => {
  it.each<[string, string]>([
    ['login',                  'audit.summary.login'],
    ['login_failed',           'audit.summary.login_failed'],
    ['logout',                 'audit.summary.logout'],
    ['mfa_enabled',            'audit.summary.mfa_enabled'],
    ['mfa_disabled',           'audit.summary.mfa_disabled'],
    ['password_changed',       'audit.summary.password_changed'],
    ['user_created',           'audit.summary.user_created'],
    ['user_updated',           'audit.summary.user_updated'],
    ['device_created',         'audit.summary.device_created'],
    ['device_updated',         'audit.summary.device_updated'],
    ['device_deleted',         'audit.summary.device_deleted'],
    ['config_template_pushed', 'audit.summary.config_template_pushed'],
  ])('%s → i18nKey "%s"', (action, expectedKey) => {
    const r = mkRecord({ action })
    expect(formatAuditAction(r).i18nKey).toBe(expectedKey)
  })

  it('login → values.user mevcut', () => {
    const r = mkRecord({ action: 'login', username: 'me***et' })
    expect(formatAuditAction(r).values.user).toBe('me***et')
  })

  it('device_updated → values.changes hesaplanır (before/after diff)', () => {
    const r = mkRecord({
      action: 'device_updated',
      resource_name: 'switch-01',
      before_state: { status: 'active', vlan: 100 },
      after_state: { status: 'inactive', vlan: 100 },
    })
    const summary = formatAuditAction(r)
    expect(summary.values.changes).toBe(1)
    expect(summary.values.device).toBe('switch-01')
  })

  it('login_failed → tone "danger"', () => {
    expect(formatAuditAction(mkRecord({ action: 'login_failed', status: 'failure' })).tone).toBe('danger')
  })

  it('device_deleted → tone "warning"', () => {
    expect(formatAuditAction(mkRecord({ action: 'device_deleted' })).tone).toBe('warning')
  })
})

// ─── Kategori bazlı fallback ───────────────────────────────────────────────

describe('formatAuditAction — bilinmeyen action kategori fallback', () => {
  it('unknown_xyz → category.neutral fallback', () => {
    const r = mkRecord({ action: 'unknown_xyz' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.neutral')
  })

  it('device_archived (suffix → delete) → category.delete', () => {
    const r = mkRecord({ action: 'device_archived' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.delete')
  })

  it('something_created (suffix → create) → category.create', () => {
    const r = mkRecord({ action: 'organization_created' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.create')
  })

  it('something_updated (suffix → update) → category.update', () => {
    const r = mkRecord({ action: 'snmp_settings_saved' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.update')
  })

  it('security_audit_run → category.security', () => {
    const r = mkRecord({ action: 'security_audit_run' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.security')
  })
})

// ─── failure status override ──────────────────────────────────────────────

describe('formatAuditAction — failure status danger tone override', () => {
  it('login (success) → tone "success"', () => {
    expect(formatAuditAction(mkRecord({ action: 'login', status: 'success' })).tone).toBe('success')
  })

  it('login (failure) → tone "danger" (override)', () => {
    expect(formatAuditAction(mkRecord({ action: 'login', status: 'failure' })).tone).toBe('danger')
  })

  it('device_created (failure) → tone "danger"', () => {
    expect(formatAuditAction(mkRecord({ action: 'device_created', status: 'failure' })).tone).toBe('danger')
  })

  it('fallback category + failure → tone "danger"', () => {
    const r = mkRecord({ action: 'unknown_xyz', status: 'failure' })
    expect(formatAuditAction(r).tone).toBe('danger')
  })
})

// ─── Defensive ────────────────────────────────────────────────────────────

describe('formatAuditAction — defansif null/undefined', () => {
  it('record null → neutral fallback', () => {
    expect(formatAuditAction(null).i18nKey).toBe('audit.summary.category.neutral')
  })

  it('record undefined → neutral fallback', () => {
    expect(formatAuditAction(undefined).i18nKey).toBe('audit.summary.category.neutral')
  })

  it('action boş string → neutral fallback', () => {
    const r = mkRecord({ action: '' })
    expect(formatAuditAction(r).i18nKey).toBe('audit.summary.category.neutral')
  })
})

// ─── Sensitive field detection ────────────────────────────────────────────

describe('isSensitiveField — hassas alan tespiti', () => {
  it.each([
    ['password',            true],
    ['user_password',       true],
    ['ssh_password',        true],
    ['token',               true],
    ['access_token',        true],
    ['secret',              true],
    ['api_key',             true],
    ['snmp_community',      true],
    ['mfa_totp_secret',     true],
    ['recovery_codes',      true],
    ['credentials',         true],
    ['credential_profile',  true],

    ['username',            false],
    ['email',               false],
    ['device_id',           false],
    ['vlan',                false],
    ['status',              false],
  ])('"%s" → %s', (field, expected) => {
    expect(isSensitiveField(field)).toBe(expected)
  })

  it('null/undefined/non-string → false (defansif)', () => {
    expect(isSensitiveField(null)).toBe(false)
    expect(isSensitiveField(undefined)).toBe(false)
    expect(isSensitiveField('')).toBe(false)
  })

  // Case-insensitive
  it('UPPER CASE PASSWORD → true (case-insensitive)', () => {
    expect(isSensitiveField('PASSWORD')).toBe(true)
    expect(isSensitiveField('User_Token')).toBe(true)
  })
})

// ─── maskedDisplayValue ───────────────────────────────────────────────────

describe('maskedDisplayValue — display + maskeleme', () => {
  it('hassas field → ***', () => {
    expect(maskedDisplayValue('password', 'supersecret')).toBe('***')
    expect(maskedDisplayValue('token', 'jwt-xyz')).toBe('***')
    expect(maskedDisplayValue('api_key', 'sk_live_123')).toBe('***')
  })

  it('hassas field, deger objesi olsa bile → ***', () => {
    expect(maskedDisplayValue('credentials', { user: 'x', pass: 'y' })).toBe('***')
  })

  it('normal field, primitive → string cast', () => {
    expect(maskedDisplayValue('vlan', 100)).toBe('100')
    expect(maskedDisplayValue('enabled', true)).toBe('true')
    expect(maskedDisplayValue('name', 'switch-01')).toBe('switch-01')
  })

  it('null/undefined → —', () => {
    expect(maskedDisplayValue('name', null)).toBe('—')
    expect(maskedDisplayValue('name', undefined)).toBe('—')
    expect(maskedDisplayValue('name', '')).toBe('—')
  })

  it('object/array → kısa JSON', () => {
    expect(maskedDisplayValue('tags', ['a', 'b'])).toBe('["a","b"]')
    expect(maskedDisplayValue('meta', { x: 1 })).toBe('{"x":1}')
  })

  it('string değer raw döner (CSS word-break ile UI ele alır, kod truncate ETMEZ)', () => {
    const long = 'a'.repeat(150)
    const result = maskedDisplayValue('description', long)
    expect(result).toBe(long)
    expect(result.endsWith('…')).toBe(false)
  })

  it('uzun OBJECT/array → JSON stringify + truncate (…)', () => {
    const longObj = { tags: Array.from({ length: 50 }, (_, i) => `tag_${i}`) }
    const result = maskedDisplayValue('meta', longObj)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(100)
  })
})
