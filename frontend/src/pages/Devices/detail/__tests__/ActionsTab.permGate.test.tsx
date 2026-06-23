// @vitest-environment jsdom
/**
 * P2-F1 REVISED (2026-06-23) — ActionsTab two-class action policy.
 *
 *   Class 1 (permission-driven, can(module, action)):
 *     Bilgi Çek      → can('devices', 'connect')
 *
 *   Class 2 (role-bound, isOrgAdmin() ONLY — perm_set overrides NOT honored):
 *     Lifecycle Apply / Lokasyon Taşı / Sil / Arşivle
 *
 * The policy: a location_admin with Tam Yetki perm_set (devices.delete
 * granted by backend) MUST NOT be able to trigger destructive /
 * ownership-class actions from the device-detail UI. Backend
 * enforcement is independent and intentionally unchanged — this gate
 * only restricts what the UI exposes.
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

// Mock store state: `permState` controls `can()`, `roleState` controls `isOrgAdmin()`.
const permState: Record<string, boolean> = {}
let roleState: {
  systemRole: 'super_admin' | 'org_admin' | 'location_admin' | 'viewer'
  isOrgAdminResult: boolean
} = { systemRole: 'location_admin', isOrgAdminResult: false }

function resetState() {
  for (const k of Object.keys(permState)) delete permState[k]
  roleState = { systemRole: 'location_admin', isOrgAdminResult: false }
}

function setPerm(module: string, action: string, val: boolean) {
  permState[`${module}:${action}`] = val
}

function setRole(sr: typeof roleState.systemRole) {
  roleState.systemRole = sr
  roleState.isOrgAdminResult = sr === 'super_admin' || sr === 'org_admin'
}

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: (s: any) => unknown) => {
    const fake = {
      user: { id: 10, username: 'mock', system_role: roleState.systemRole },
      can: (m: string, a: string) => permState[`${m}:${a}`] ?? false,
      isOrgAdmin: () => roleState.isOrgAdminResult,
      isSuperAdmin: () => roleState.systemRole === 'super_admin',
      isLocationAdmin: () => roleState.isOrgAdminResult || roleState.systemRole === 'location_admin',
    }
    return selector ? selector(fake) : fake
  },
}))

import ActionsTab from '../ActionsTab'

function makeDevice() {
  return {
    id: 95,
    hostname: 'Omurga',
    ip_address: '10.255.0.1',
    organization_id: 6,
    location_id: 12,
    lifecycle_status: 'production',
  } as any
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AntApp>
          <ActionsTab device={makeDevice()} />
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

// ─── Behavioral matrix per operator brief ─────────────────────────────────

describe('ActionsTab — P2-F1 REVISED (destructive role gate)', () => {
  it('Case 1: emre / location_admin + Tam Yetki perm_set (devices.delete=true) — Bilgi Çek aktif, destructive PASIF', () => {
    setRole('location_admin')
    // Backend perm_set 3 ("Tam Yetki") grants devices.* fully. UI must
    // still NOT surface destructive actions; only the operational one.
    setPerm('devices', 'connect', true)
    setPerm('devices', 'edit', true)
    setPerm('devices', 'move', true)
    setPerm('devices', 'delete', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    // Lifecycle Apply hâlâ disabled olmalı çünkü destructive gate role-bound.
    // (default lifecycle === device.lifecycle_status, ama bunun ÖTESINDE
    //  isOrgAdmin=false olduğu için button zaten disabled olmalı.)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(true)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(true)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
    // Lifecycle Select disabled (no .ant-select-disabled because of role gate).
    expect(document.querySelector('.ant-select-disabled')).toBeTruthy()
  })

  it('Case 2: org_admin + devices.delete=true — tüm aksiyonlar aktif', () => {
    setRole('org_admin')
    setPerm('devices', 'connect', true) // org_admin için can() doğrudan true zaten
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    // Lifecycle Select etkin
    expect(document.querySelector('.ant-select-disabled')).toBeNull()
    // Banner görünmüyor
    expect(document.querySelector('.ant-alert-info')).toBeNull()
  })

  it('Case 3: super_admin — tüm aksiyonlar aktif', () => {
    setRole('super_admin')
    setPerm('devices', 'connect', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
  })

  it('Case 4: viewer — Bilgi Çek dahil tüm yazma/aksiyon butonları pasif + read-only banner', () => {
    setRole('viewer')
    // viewer için can('devices', 'connect') => false (DEFAULT_ROLE_GRANTS.viewer)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(true)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(true)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(true)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
    expect(screen.getByText('devices.detail.actions_tab.readonly_alert')).toBeTruthy()
  })

  it('location_admin without perm_set + can connect=false — banner görünür', () => {
    setRole('location_admin')
    // can('devices', 'connect') false (no perm_set match, no DEFAULT_ROLE_GRANTS).
    // In production location_admin gets connect via DEFAULT_ROLE_GRANTS but
    // here our mock returns false for any key not explicitly set — that's
    // the "pre-permissions loaded" case.
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(true)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
    expect(screen.getByText('devices.detail.actions_tab.readonly_alert')).toBeTruthy()
  })

  it('location_admin can(connect)=true ama isOrgAdmin=false — Bilgi Çek aktif, banner görünMEz', () => {
    setRole('location_admin')
    setPerm('devices', 'connect', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    // En az bir yazma aktif olduğu için banner görünmez.
    expect(document.querySelector('.ant-alert-info')).toBeNull()
    // Destructive hâlâ pasif.
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(true)
  })
})

// ─── Source-level pins ────────────────────────────────────────────────────

describe('ActionsTab — P2-F1 REVISED source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../ActionsTab.tsx'),
    'utf-8',
  )
  const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

  it('Eski isOrgAdmin destructure paterni YOK (eski blanket lock)', () => {
    expect(codeOnly).not.toMatch(/const\s*\{\s*isOrgAdmin\s*\}\s*=\s*useAuthStore\(\)/)
    expect(codeOnly).not.toMatch(/const\s+canWrite\s*=\s*isOrgAdmin\(\)/)
  })

  it('Operational gate: canFetchInfo = can(devices, connect)', () => {
    expect(SRC).toMatch(/canFetchInfo\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'connect'\)\)/)
  })

  it('Role-bound gate: isOrgAdmin selector-bağlı + canDestructive türevi', () => {
    expect(SRC).toMatch(/isOrgAdmin\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.isOrgAdmin\(\)\)/)
    expect(SRC).toMatch(/canDestructive\s*=\s*isOrgAdmin/)
  })

  it('Lifecycle gate: !canDestructive (NOT can(devices,edit))', () => {
    // Code-only check (strip comments) — comments may reference can('devices','edit').
    expect(codeOnly).not.toMatch(/disabled=\{!canLifecycle\b/)
    expect(codeOnly).not.toMatch(/s\.can\('devices',\s*'edit'\)/)
    expect(SRC).toMatch(/disabled=\{!canDestructive\s*\|\|/)
  })

  it('Lokasyon Taşı gate: canDestructive (NOT can(devices,move))', () => {
    expect(codeOnly).not.toMatch(/s\.can\('devices',\s*'move'\)/)
    const moveSection = codeOnly.indexOf('tooltip_move_location')
    expect(moveSection).toBeGreaterThan(0)
    const slice = codeOnly.slice(moveSection, moveSection + 400)
    expect(slice).toMatch(/!canDestructive/)
  })

  it('Sil + Arşivle gate: canDestructive (NOT can(devices,delete))', () => {
    expect(codeOnly).not.toMatch(/s\.can\('devices',\s*'delete'\)/)
    // Delete button
    expect(SRC).toMatch(/disabled=\{!canDestructive\}[^>]*loading=\{deleteMut\.isPending\}/)
    // Archive Popconfirm
    const archiveIdx = codeOnly.indexOf('archive_confirm_suffix')
    expect(archiveIdx).toBeGreaterThan(0)
    const archiveSlice = codeOnly.slice(archiveIdx, archiveIdx + 600)
    expect(archiveSlice).toMatch(/!canDestructive/)
  })

  it('Bilgi Çek hâlâ canFetchInfo ile gate (operational gate korundu)', () => {
    expect(SRC).toMatch(/disabled=\{!canFetchInfo\}[^>]*loading=\{infoMut\.isPending\}/)
  })

  it('Read-only banner: !canFetchInfo && !canDestructive', () => {
    expect(SRC).toMatch(/isReadOnly\s*=\s*!canFetchInfo\s*&&\s*!canDestructive/)
    expect(SRC).toMatch(/\{isReadOnly\s*&&[\s\S]{0,200}readonly_alert/)
  })
})
