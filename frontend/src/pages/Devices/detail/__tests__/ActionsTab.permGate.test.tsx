// @vitest-environment jsdom
/**
 * P2-F1 REVISED (2026-06-23) — ActionsTab effective-permission gates.
 *
 * Every action is gated on `useAuthStore.can(module, action)`. A
 * location_admin whose PermissionSet grants the verb (e.g. emre with
 * Tam Yetki perm_set 3 → devices.delete=true) sees the button active;
 * a user without the grant sees it disabled. Role is NOT used as an
 * artificial ceiling — PermissionSet is the source of truth.
 *
 *   Bilgi Çek       → can('devices', 'connect')
 *   Lifecycle Apply → can('devices', 'edit')
 *   Lokasyon Taşı   → can('devices', 'move')
 *   Sil             → can('devices', 'delete')
 *   Arşivle         → can('devices', 'edit')   (lifecycle = 'archived' is a lifecycle write)
 *
 * Banner: shown only when NONE of the five gated verbs is granted.
 */
import { render, cleanup, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useOperationsNavigate', () => ({
  useOperationsNavigate: () => vi.fn(),
}))

vi.mock('@/api/devices', () => ({
  devicesApi: {
    testConnection: vi.fn(),
    fetchInfo: vi.fn(),
    updateLifecycle: vi.fn(),
    delete: vi.fn(),
  },
}))

const permState: Record<string, boolean> = {}
let roleState: { systemRole: 'super_admin' | 'org_admin' | 'location_admin' | 'viewer' } = {
  systemRole: 'location_admin',
}

function resetState() {
  for (const k of Object.keys(permState)) delete permState[k]
  roleState = { systemRole: 'location_admin' }
}

function setPerm(module: string, action: string, val: boolean) {
  permState[`${module}:${action}`] = val
}

function setRole(sr: typeof roleState.systemRole) {
  roleState.systemRole = sr
}

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: (s: any) => unknown) => {
    const sr = roleState.systemRole
    const fake = {
      user: { id: 10, username: 'mock', system_role: sr },
      // can() honors the explicit permState, otherwise emulates the
      // production org/super-admin short-circuit (always true) so the
      // org_admin / super_admin test cases mirror real behavior even
      // when the per-verb permState is left empty by the test.
      can: (m: string, a: string) => {
        if (sr === 'super_admin' || sr === 'org_admin') return true
        return permState[`${m}:${a}`] ?? false
      },
      isOrgAdmin: () => sr === 'super_admin' || sr === 'org_admin',
      isSuperAdmin: () => sr === 'super_admin',
      isLocationAdmin: () => sr === 'super_admin' || sr === 'org_admin' || sr === 'location_admin',
    }
    return selector ? selector(fake) : fake
  },
}))

import ActionsTab from '../ActionsTab'

function makeDevice(overrides: Partial<{ lifecycle_status: string }> = {}) {
  return {
    id: 95,
    hostname: 'Omurga',
    ip_address: '10.255.0.1',
    organization_id: 6,
    location_id: 12,
    // Default 'passive' so the lifecycle Apply button is not auto-disabled
    // by the "nextLifecycle === device.lifecycle_status" condition.
    lifecycle_status: 'passive',
    ...overrides,
  } as any
}

function renderTab(deviceOverrides?: Partial<{ lifecycle_status: string }>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AntApp>
          <ActionsTab device={makeDevice(deviceOverrides)} />
        </AntApp>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function findButtonByText(text: string): HTMLButtonElement | null {
  const all = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
  return all.find((b) => b.textContent?.includes(text)) ?? null
}

beforeEach(() => {
  resetState()
})

afterEach(() => {
  cleanup()
})

// ─── Operator's required test matrix (5 scenarios) ────────────────────────

describe('ActionsTab — P2-F1 REVISED behavioral matrix', () => {
  it('Case 1: emre / location_admin + Tam Yetki perm_set (all four verbs granted) — every action ACTIVE', () => {
    setRole('location_admin')
    setPerm('devices', 'connect', true)
    setPerm('devices', 'edit', true)
    setPerm('devices', 'move', true)
    setPerm('devices', 'delete', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    // Lifecycle Select etkin (canEdit=true)
    expect(document.querySelector('.ant-select-disabled')).toBeNull()
    // Banner görünmüyor
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })

  it('Case 2: location_admin + limited perm_set (connect+edit only) — Bilgi Çek + Lifecycle + Arşivle aktif, Move + Sil pasif', () => {
    setRole('location_admin')
    setPerm('devices', 'connect', true)
    setPerm('devices', 'edit', true)
    setPerm('devices', 'move', false)
    setPerm('devices', 'delete', false)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(true)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
    // Arşivle paylaşılan canEdit gate'ine bağlı — aktif
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    // Lifecycle Select etkin (canEdit=true)
    expect(document.querySelector('.ant-select-disabled')).toBeNull()
    // Banner görünmüyor (en az bir aksiyon var)
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })

  it('Case 3: viewer (no grants) — tüm aksiyonlar pasif + permission banner görünür', () => {
    setRole('viewer')
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(true)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(true)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(true)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
    // Lifecycle Select pasif
    expect(document.querySelector('.ant-select-disabled')).toBeTruthy()
    // Permission banner görünür (i18n key resolved to literal key by mock)
    expect(screen.getByText('devices.detail.actions_tab.readonly_alert')).toBeTruthy()
  })

  it('Case 4a: org_admin — Tam Yetki davranışı korunur (her şey aktif)', () => {
    setRole('org_admin')
    // org_admin için can() short-circuit'i her zaman true (auth store mevcut davranış).
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    expect(document.querySelector('.ant-select-disabled')).toBeNull()
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })

  it('Case 4b: super_admin — Tam Yetki davranışı korunur (her şey aktif)', () => {
    setRole('super_admin')
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    expect(document.querySelector('.ant-select-disabled')).toBeNull()
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })

  it('Banner şartı: yalnız Bilgi Çek granted ise banner görünMEz', () => {
    setRole('location_admin')
    setPerm('devices', 'connect', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })

  it('Banner şartı: yalnız delete granted bile olsa (edge) banner görünMEz', () => {
    setRole('location_admin')
    setPerm('devices', 'delete', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    expect(screen.queryByText('devices.detail.actions_tab.readonly_alert')).toBeNull()
  })
})

// ─── Source-level pins ────────────────────────────────────────────────────

describe('ActionsTab — P2-F1 REVISED source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../ActionsTab.tsx'),
    'utf-8',
  )
  const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

  it('No `isOrgAdmin()` selector and no `canDestructive` variable — role-bound gate removed', () => {
    expect(codeOnly).not.toMatch(/useAuthStore\(\(s\)\s*=>\s*s\.isOrgAdmin\(\)\)/)
    expect(codeOnly).not.toMatch(/canDestructive/)
    expect(codeOnly).not.toMatch(/const\s*\{\s*isOrgAdmin\s*\}\s*=\s*useAuthStore\(\)/)
    expect(codeOnly).not.toMatch(/const\s+canWrite\s*=\s*isOrgAdmin\(\)/)
  })

  it('Four can() gate hooks defined', () => {
    expect(SRC).toMatch(/canFetchInfo\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'connect'\)\)/)
    expect(SRC).toMatch(/canEdit\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'edit'\)\)/)
    expect(SRC).toMatch(/canMove\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'move'\)\)/)
    expect(SRC).toMatch(/canDelete\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'delete'\)\)/)
  })

  it('Bilgi Çek gated on canFetchInfo', () => {
    expect(SRC).toMatch(/disabled=\{!canFetchInfo\}[^>]*loading=\{infoMut\.isPending\}/)
  })

  it('Lifecycle gated on canEdit (no canDestructive/canLifecycle)', () => {
    expect(SRC).toMatch(/disabled=\{!canEdit\s*\|\|/)
  })

  it('Lokasyon Taşı gated on canMove', () => {
    const moveIdx = codeOnly.indexOf('tooltip_move_location')
    expect(moveIdx).toBeGreaterThan(0)
    const slice = codeOnly.slice(moveIdx, moveIdx + 400)
    expect(slice).toMatch(/!canMove/)
  })

  it('Sil gated on canDelete', () => {
    expect(SRC).toMatch(/disabled=\{!canDelete\}[^>]*loading=\{deleteMut\.isPending\}/)
  })

  it('Arşivle gated on canEdit (lifecycle write, NOT canDelete)', () => {
    const archiveIdx = codeOnly.indexOf('archive_confirm_suffix')
    expect(archiveIdx).toBeGreaterThan(0)
    const slice = codeOnly.slice(archiveIdx, archiveIdx + 400)
    expect(slice).toMatch(/!canEdit/)
    expect(slice).not.toMatch(/!canDelete/)
  })

  it('isReadOnly formula: !canFetchInfo && !canEdit && !canMove && !canDelete', () => {
    expect(SRC).toMatch(
      /isReadOnly\s*=\s*!canFetchInfo\s*&&\s*!canEdit\s*&&\s*!canMove\s*&&\s*!canDelete/,
    )
    expect(SRC).toMatch(/\{isReadOnly\s*&&[\s\S]{0,200}readonly_alert/)
  })
})

// ─── Banner i18n string contract ───────────────────────────────────────────

describe('ActionsTab — banner i18n permission-focused text', () => {
  it('TR locale: org_admin+ ifadesi YOK, permission odaklı metin var', () => {
    const tr = readFileSync(resolve(__dirname, '../../../../i18n/locales/tr.json'), 'utf-8')
    const trObj = JSON.parse(tr)
    const msg = trObj.devices.detail.actions_tab.readonly_alert as string
    expect(msg).not.toMatch(/org_admin/i)
    expect(msg).toMatch(/yetki/i)
  })

  it('EN locale: org_admin+ ifadesi YOK', () => {
    const en = readFileSync(resolve(__dirname, '../../../../i18n/locales/en.json'), 'utf-8')
    const enObj = JSON.parse(en)
    const msg = enObj.devices.detail.actions_tab.readonly_alert as string
    expect(msg).not.toMatch(/org_admin/i)
    expect(msg).toMatch(/permission/i)
  })

  it('DE locale: org_admin+ ifadesi YOK', () => {
    const de = readFileSync(resolve(__dirname, '../../../../i18n/locales/de.json'), 'utf-8')
    const deObj = JSON.parse(de)
    const msg = deObj.devices.detail.actions_tab.readonly_alert as string
    expect(msg).not.toMatch(/org_admin/i)
    expect(msg).toMatch(/Berechtigung/i)
  })

  it('RU locale: org_admin+ ifadesi YOK', () => {
    const ru = readFileSync(resolve(__dirname, '../../../../i18n/locales/ru.json'), 'utf-8')
    const ruObj = JSON.parse(ru)
    const msg = ruObj.devices.detail.actions_tab.readonly_alert as string
    expect(msg).not.toMatch(/org_admin/i)
    expect(msg).toMatch(/прав/i)
  })
})
