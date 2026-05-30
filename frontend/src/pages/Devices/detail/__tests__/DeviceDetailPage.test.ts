/**
 * T10 C7.D — DeviceDetailPage import smoke.
 *
 * Tüm sekme bileşenlerinin import graph'ı temiz (compile + load); tab katalogu
 * 9 key içerir ve tümü artık live. Tarayıcı/DOM render'ı için tarayıcı smoke
 * (kullanıcı tarafı).
 */
import { describe, it, expect } from 'vitest'
import { DETAIL_TABS } from '../_tabs'

describe('DeviceDetailPage / sekme bileşenleri import graph', () => {
  it('9 sekme key var', () => {
    expect(DETAIL_TABS.map((t) => t.key)).toEqual([
      'overview', 'ports', 'security', 'vlan', 'mac', 'poe', 'events', 'backup', 'actions',
    ])
  })

  it('sekme bileşenleri import edilebilir (compile clean)', async () => {
    // Module load — herhangi biri patlarsa import promise reject olur.
    await import('../OverviewTab')
    await import('../PortsTab')
    await import('../SecurityPoliciesTab')
    await import('../VlanTab')
    await import('../MacTab')
    await import('../PoeTab')
    await import('../EventsTab')
    await import('../BackupTab')
    await import('../ActionsTab')
    expect(true).toBe(true)
  })

  it('DeviceDetailPage import edilebilir', async () => {
    const mod = await import('../../DeviceDetailPage')
    expect(typeof mod.default).toBe('function')
  })
})
