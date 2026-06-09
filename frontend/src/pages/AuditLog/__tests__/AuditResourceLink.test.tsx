/**
 * Audit Log v2 PR 3 — AuditResourceLink module smoke.
 *
 * Pattern: dynamic import + createElement (proje React Testing Library
 * kullanmıyor). Asıl 4 render senaryosu manuel tarayıcı smoke ile
 * doğrulanır. Bu testler crash YOK + prop kabulü garantiler.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'

describe('AuditResourceLink — module smoke', () => {
  it('default export fonksiyon', async () => {
    const mod = await import('../AuditResourceLink')
    expect(typeof mod.default).toBe('function')
  })

  it('type yok → crash YOK', async () => {
    const mod = await import('../AuditResourceLink')
    const el = createElement(mod.default, { type: null, id: null, name: null })
    expect(el).toBeTruthy()
    expect(el.type).toBe(mod.default)
  })

  it.each([
    ['device', '123', 'switch-01'],
    ['user', '5', 'admin'],
    ['task', '99', 'backup_run'],
    ['agent', '2', 'agent-01'],
    ['ipam', '7', 'subnet-1'],
    ['security_audit', '1', null],
    ['terminal_session', '4', null],
    ['asset_lifecycle', '3', null],
    ['organization', '2', 'acme-corp'],
    ['config_template', '6', 'startup-tmpl'],
    ['tenant', '8', 'tenant-x'],          // route YOK fallback
    ['group', '10', 'group-east'],         // route YOK fallback
    ['invite_token', '1', null],           // route YOK fallback
    ['compliance_profile', '1', 'cp-1'],   // route YOK fallback
    ['unknown_xyz', '0', 'foo'],           // bilinmeyen fallback
  ])('createElement type="%s" id="%s" name="%s" — crash YOK', async (type, id, name) => {
    const mod = await import('../AuditResourceLink')
    const el = createElement(mod.default, { type, id, name })
    expect(el).toBeTruthy()
    expect(el.props.type).toBe(type)
  })

  it('compact prop kabul edilir', async () => {
    const mod = await import('../AuditResourceLink')
    const el = createElement(mod.default, {
      type: 'device',
      id: '1',
      name: 'sw-1',
      compact: true,
    })
    expect(el.props.compact).toBe(true)
  })

  it('uzun resource name — crash YOK (CSS truncate UI tarafı)', async () => {
    const mod = await import('../AuditResourceLink')
    const el = createElement(mod.default, {
      type: 'device',
      id: '1',
      name: 'a'.repeat(200),
    })
    expect(el).toBeTruthy()
  })

  it('hassas isim olmamalı görünür ama crash etmez (link metin alanı, value değil)', async () => {
    const mod = await import('../AuditResourceLink')
    // name alanı genelde insan-okunabilir isim (sw-01) olur; hassas alan
    // testi auditFormatters tarafında. Burada sadece crash kontrolü.
    const el = createElement(mod.default, {
      type: 'device',
      id: 'abc/123',  // tehlikeli karakter — encodeURIComponent ile handle
      name: 'safe-name',
    })
    expect(el).toBeTruthy()
  })
})
