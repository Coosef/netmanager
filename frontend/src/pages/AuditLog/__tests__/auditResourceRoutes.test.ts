/**
 * Audit Log v2 PR 3 — auditResourceRoutes resolve testleri.
 *
 * 16 resource_type için route + null fallback + null/undefined input
 * + case-insensitive + encodeURIComponent davranışı.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveResourceRoute,
  isKnownResourceType,
} from '../auditResourceRoutes'

describe('resolveResourceRoute — known types with route', () => {
  it('device + id → /devices/{id} detail route', () => {
    const r = resolveResourceRoute('device', '123')
    expect(r).not.toBeNull()
    expect(r?.path).toBe('/devices/123')
    expect(r?.module).toBe('devices')
    expect(r?.action).toBe('view')
    expect(r?.icon).toBe('device')
    expect(r?.hasDetailRoute).toBe(true)
  })

  it('device without id → null (detay yapılamaz)', () => {
    expect(resolveResourceRoute('device', null)).toBeNull()
    expect(resolveResourceRoute('device', undefined)).toBeNull()
    expect(resolveResourceRoute('device', '')).toBeNull()
    expect(resolveResourceRoute('device', '   ')).toBeNull()
  })

  it('user → /users (liste route)', () => {
    const r = resolveResourceRoute('user', '5')
    expect(r?.path).toBe('/users')
    expect(r?.module).toBe('users')
    expect(r?.icon).toBe('user')
    expect(r?.hasDetailRoute).toBe(false)
  })

  it('user without id → liste route yine döner', () => {
    const r = resolveResourceRoute('user', null)
    expect(r?.path).toBe('/users')
  })

  it.each([
    ['task',             '/tasks',             'tasks',         'task'],
    ['agent',            '/agents',            'agents',        'agent'],
    ['ipam',             '/ipam',              'ipam',          'ipam'],
    ['ipam_subnet',      '/ipam',              'ipam',          'ipam'],
    ['ipam_zone',        '/ipam',              'ipam',          'ipam'],
    ['security_audit',   '/security-audit',    'monitoring',    'security'],
    ['terminal_session', '/terminal-sessions', 'audit_logs',    'terminal'],
    ['asset_lifecycle',  '/asset-lifecycle',   'monitoring',    'lifecycle'],
    ['organization',     '/org-admin',         'org',           'org'],
    ['config_template',  '/config-templates',  'driver_templates', 'template'],
  ])('%s → path=%s, module=%s, icon=%s', (type, path, module, icon) => {
    const r = resolveResourceRoute(type, '99')
    expect(r).not.toBeNull()
    expect(r?.path).toBe(path)
    expect(r?.module).toBe(module)
    expect(r?.icon).toBe(icon)
  })
})

describe('resolveResourceRoute — fallback null (route YOK)', () => {
  it.each([
    'tenant',
    'group',
    'invite_token',
    'compliance_profile',
  ])('%s → null (route YOK, AuditResourceLink düz text gösterir)', (type) => {
    expect(resolveResourceRoute(type, '5')).toBeNull()
    expect(resolveResourceRoute(type, null)).toBeNull()
  })
})

describe('resolveResourceRoute — bilinmeyen type → null fallback', () => {
  it('totally_unknown_type → null', () => {
    expect(resolveResourceRoute('totally_unknown_type', '1')).toBeNull()
  })

  it('null / undefined / empty → null', () => {
    expect(resolveResourceRoute(null, '1')).toBeNull()
    expect(resolveResourceRoute(undefined, '1')).toBeNull()
    expect(resolveResourceRoute('', '1')).toBeNull()
    expect(resolveResourceRoute('   ', '1')).toBeNull()
  })

  it('non-string type → null (defansif)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveResourceRoute(123 as any, '1')).toBeNull()
  })
})

describe('resolveResourceRoute — case-insensitive', () => {
  it('UPPER CASE DEVICE → device map', () => {
    const r = resolveResourceRoute('DEVICE', '7')
    expect(r?.path).toBe('/devices/7')
  })

  it('Mixed Case User → user map', () => {
    const r = resolveResourceRoute('User', null)
    expect(r?.path).toBe('/users')
  })

  it('whitespace trim', () => {
    const r = resolveResourceRoute('  device  ', '3')
    expect(r?.path).toBe('/devices/3')
  })
})

describe('resolveResourceRoute — id encoding (XSS guard)', () => {
  it('id ile path düzgün encode edilir', () => {
    const r = resolveResourceRoute('device', 'abc/123')
    expect(r?.path).toBe('/devices/abc%2F123')
  })

  it('id ile özel karakterler', () => {
    const r = resolveResourceRoute('device', 'a b')
    expect(r?.path).toBe('/devices/a%20b')
  })
})

describe('isKnownResourceType', () => {
  it.each([
    ['device',             true],
    ['user',               true],
    ['task',               true],
    ['agent',              true],
    ['ipam',               true],
    ['security_audit',     true],
    ['terminal_session',   true],
    ['asset_lifecycle',    true],
    ['organization',       true],
    ['config_template',    true],
    ['ipam_subnet',        true],
    ['ipam_zone',          true],

    ['tenant',             false],
    ['group',              false],
    ['invite_token',       false],
    ['compliance_profile', false],
    ['unknown_xyz',        false],
  ])('"%s" → %s', (type, expected) => {
    expect(isKnownResourceType(type)).toBe(expected)
  })

  it('null/undefined/empty → false', () => {
    expect(isKnownResourceType(null)).toBe(false)
    expect(isKnownResourceType(undefined)).toBe(false)
    expect(isKnownResourceType('')).toBe(false)
  })

  it('case-insensitive', () => {
    expect(isKnownResourceType('DEVICE')).toBe(true)
    expect(isKnownResourceType('User')).toBe(true)
  })
})
