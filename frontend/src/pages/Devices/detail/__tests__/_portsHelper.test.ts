/**
 * T10 C7.C — _portsHelper birim testleri.
 *
 * effectivePortPolicy zinciri ve macCountByPort group/cap testleri.
 */
import { describe, it, expect } from 'vitest'
import {
  effectivePortPolicy, macCountByPort, FALLBACK_NAME, MAC_COUNT_CAP,
} from '../_portsHelper'
import type { PortPolicyAssignment } from '@/api/portPolicyAssignments'

const ppa = (port: string, policyId: number): PortPolicyAssignment => ({
  id: Math.random(), device_id: 1, port_name: port,
  port_security_policy_id: policyId, organization_id: 1,
})

const POLICIES = [
  { id: 10, name: 'default', is_default: true },
  { id: 20, name: 'kamera' },
  { id: 30, name: 'uplink' },
]

describe('effectivePortPolicy', () => {
  it('override > cihaz-default > org-default > fallback', () => {
    expect(effectivePortPolicy('Gi1/0/1', [ppa('Gi1/0/1', 20)], 30, POLICIES))
      .toEqual({ policy_id: 20, name: 'kamera', source: 'override' })
  })

  it('override yoksa cihaz-default kazanır', () => {
    expect(effectivePortPolicy('Gi1/0/2', [], 30, POLICIES))
      .toEqual({ policy_id: 30, name: 'uplink', source: 'cihaz-default' })
  })

  it('cihaz-default da yoksa org default (is_default=true)', () => {
    expect(effectivePortPolicy('Gi1/0/3', [], null, POLICIES))
      .toEqual({ policy_id: 10, name: 'default', source: 'org-default' })
  })

  it('hiçbiri yoksa hardcoded fallback', () => {
    expect(effectivePortPolicy('Gi1/0/4', [], null, []))
      .toEqual({ policy_id: null, name: FALLBACK_NAME, source: 'fallback' })
  })

  it('başka port\'un override\'ı sızmaz', () => {
    const r = effectivePortPolicy('Gi1/0/99', [ppa('Gi1/0/1', 20)], 30, POLICIES)
    expect(r.source).toBe('cihaz-default')
  })

  it('override\'ın policy_id\'si listede yoksa name="#id" placeholder', () => {
    const r = effectivePortPolicy('Gi1/0/1', [ppa('Gi1/0/1', 999)], 30, POLICIES)
    expect(r).toEqual({ policy_id: 999, name: '#999', source: 'override' })
  })
})

describe('macCountByPort', () => {
  it('boş liste → boş map', () => {
    expect(macCountByPort([]).size).toBe(0)
  })

  it('port_name başına sayım; port=null/undefined yok sayılır', () => {
    const m = macCountByPort([
      { port: 'Gi1/0/1' }, { port: 'Gi1/0/1' }, { port: 'Gi1/0/2' },
      { port: null }, { port: undefined as any },
    ])
    expect(m.get('Gi1/0/1')?.count).toBe(2)
    expect(m.get('Gi1/0/2')?.count).toBe(1)
    expect(m.size).toBe(2)
  })

  it('toplam cap altında → isCapped=false', () => {
    const items = Array.from({ length: 10 }, () => ({ port: 'Gi1/0/1' }))
    const m = macCountByPort(items, 100)
    expect(m.get('Gi1/0/1')).toEqual({ count: 10, isCapped: false })
  })

  it('toplam cap\'a değiyorsa tüm portlar isCapped=true', () => {
    const items = Array.from({ length: 5 }, () => ({ port: 'Gi1/0/1' }))
    const m = macCountByPort(items, 5)
    expect(m.get('Gi1/0/1')?.isCapped).toBe(true)
  })

  it('default cap = MAC_COUNT_CAP', () => {
    expect(MAC_COUNT_CAP).toBe(500)
  })
})
