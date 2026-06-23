// @vitest-environment jsdom
/**
 * P2-F1 HOTFIX (2026-06-23) — ActionsTab per-action permission gates.
 *
 * Önceki implementation tüm yazma butonlarını `isOrgAdmin()` ile
 * kilitliyordu. `location_admin` (örn. emre + Tam Yetki permission_set)
 * backend tarafı `device:connect`/`device:edit`/`device:move` granted
 * olduğu halde "Bilgi Çek" butonu pasif kalıyordu.
 *
 * Bu test dosyası ActionsTab'ın her yazma butonunun doğru `can(module,
 * action)` çağrısıyla bağlandığını ve buton durumunun mock auth state
 * ile beklenen şekilde değiştiğini pinler.
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

// useAuthStore.can() davranışını test başına kontrol etmek için stub.
// `permState[`${module}:${action}`]` = true/false matrisinden bir lookup.
const permState: Record<string, boolean> = {}
function resetPerms() {
  for (const k of Object.keys(permState)) delete permState[k]
}
function setPerm(module: string, action: string, val: boolean) {
  permState[`${module}:${action}`] = val
}

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector?: (s: any) => unknown) => {
    const fake = {
      user: { id: 10, username: 'emre', system_role: 'location_admin' },
      can: (m: string, a: string) => permState[`${m}:${a}`] ?? false,
      isOrgAdmin: () => false,
      isSuperAdmin: () => false,
      isLocationAdmin: () => true,
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

// AntD Button + Popconfirm DOM elementlerinde label içinden butona ulaşmak için.
function findButtonByText(text: string): HTMLButtonElement | null {
  const all = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
  return all.find((b) => b.textContent?.includes(text)) ?? null
}

beforeEach(() => {
  resetPerms()
})

afterEach(() => {
  cleanup()
})

describe('ActionsTab — P2-F1 per-action gates (behavioral)', () => {
  it('Case 1 — location_admin + devices.connect=true → Bilgi Çek aktif', () => {
    setPerm('devices', 'connect', true)
    setPerm('devices', 'edit', false)
    setPerm('devices', 'move', false)
    setPerm('devices', 'delete', false)
    renderTab()
    const btn = findButtonByText('devices.detail.actions_tab.btn_fetch_info')
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(false)
  })

  it('Case 1b — location_admin + devices.connect=false → Bilgi Çek pasif', () => {
    setPerm('devices', 'connect', false)
    renderTab()
    const btn = findButtonByText('devices.detail.actions_tab.btn_fetch_info')
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(true)
  })

  it('Case 2 — devices.delete=false → Sil + Arşivle pasif', () => {
    setPerm('devices', 'connect', true) // Bilgi Çek aktif olsa bile silme pasif
    setPerm('devices', 'delete', false)
    renderTab()
    const deleteBtn = findButtonByText('devices.detail.actions_tab.btn_delete_device')
    expect(deleteBtn).toBeTruthy()
    expect(deleteBtn!.disabled).toBe(true)
    const archiveBtn = findButtonByText('devices.card.archive_ok')
    expect(archiveBtn).toBeTruthy()
    expect(archiveBtn!.disabled).toBe(true)
  })

  it('Case 2b — devices.delete=true → Sil + Arşivle aktif (granted location_admin / Tam Yetki perm_set)', () => {
    setPerm('devices', 'delete', true)
    renderTab()
    const deleteBtn = findButtonByText('devices.detail.actions_tab.btn_delete_device')
    expect(deleteBtn!.disabled).toBe(false)
    const archiveBtn = findButtonByText('devices.card.archive_ok')
    expect(archiveBtn!.disabled).toBe(false)
  })

  it('Case 3 — devices.move bağımsız: edit=true, move=false → Lifecycle aktif, Lokasyon taşı pasif', () => {
    setPerm('devices', 'edit', true)
    setPerm('devices', 'move', false)
    renderTab()
    const moveBtn = findButtonByText('devices.row.move_location')
    expect(moveBtn).toBeTruthy()
    expect(moveBtn!.disabled).toBe(true)
    // Lifecycle Apply butonu: edit=true VE nextLifecycle eşit değil (default
    // 'production' = device.lifecycle_status), bu yüzden hâlâ disabled.
    // O nedenle Lifecycle gate'i için sadece select dropdown'ı kontrol et:
    const selects = document.querySelectorAll('.ant-select-selector')
    // Disabled select'in parent'ında 'ant-select-disabled' sınıfı olur.
    const lifecycleSelectDisabled = !!document.querySelector('.ant-select-disabled')
    expect(lifecycleSelectDisabled).toBe(false) // edit=true → enabled
    expect(selects.length).toBeGreaterThan(0)
  })

  it('Case 5 — yetkisiz kullanıcı (her şey false) → tüm yazma butonları pasif + read-only banner', () => {
    // hiçbir gate set edilmedi → hepsi false (default)
    renderTab()
    const fetchBtn = findButtonByText('devices.detail.actions_tab.btn_fetch_info')
    const moveBtn = findButtonByText('devices.row.move_location')
    const archiveBtn = findButtonByText('devices.card.archive_ok')
    const deleteBtn = findButtonByText('devices.detail.actions_tab.btn_delete_device')
    expect(fetchBtn!.disabled).toBe(true)
    expect(moveBtn!.disabled).toBe(true)
    expect(archiveBtn!.disabled).toBe(true)
    expect(deleteBtn!.disabled).toBe(true)
    // Read-only banner (devices.detail.actions_tab.readonly_alert) görünür.
    expect(screen.getByText('devices.detail.actions_tab.readonly_alert')).toBeTruthy()
  })

  it('Case 6 — org_admin gibi tam yetki: 4 gate de true → tüm butonlar aktif, banner yok', () => {
    setPerm('devices', 'connect', true)
    setPerm('devices', 'edit', true)
    setPerm('devices', 'move', true)
    setPerm('devices', 'delete', true)
    renderTab()
    expect(findButtonByText('devices.detail.actions_tab.btn_fetch_info')!.disabled).toBe(false)
    expect(findButtonByText('devices.row.move_location')!.disabled).toBe(false)
    expect(findButtonByText('devices.card.archive_ok')!.disabled).toBe(false)
    expect(findButtonByText('devices.detail.actions_tab.btn_delete_device')!.disabled).toBe(false)
    // Read-only banner görünMEmeli
    expect(document.querySelector('.ant-alert-info')).toBeNull()
  })
})

// ─── Source-level pins ────────────────────────────────────────────────────

describe('ActionsTab — P2-F1 source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../ActionsTab.tsx'),
    'utf-8',
  )

  it('isOrgAdmin tabanlı toplu canWrite ARTIK YOK', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/const\s+canWrite\s*=\s*isOrgAdmin\(\)/)
    expect(codeOnly).not.toMatch(/const\s*\{\s*isOrgAdmin\s*\}\s*=\s*useAuthStore\(\)/)
  })

  it('4 granular gate hook tanımlı', () => {
    expect(SRC).toMatch(/canFetchInfo\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'connect'\)\)/)
    expect(SRC).toMatch(/canLifecycle\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'edit'\)\)/)
    expect(SRC).toMatch(/canMove\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'move'\)\)/)
    expect(SRC).toMatch(/canDelete\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'delete'\)\)/)
  })

  it('Bilgi Çek butonu canFetchInfo ile gate', () => {
    expect(SRC).toMatch(/disabled=\{!canFetchInfo\}[^>]*loading=\{infoMut\.isPending\}/)
  })

  it('Lifecycle apply canLifecycle ile gate', () => {
    expect(SRC).toMatch(/disabled=\{!canLifecycle\s*\|\|/)
  })

  it('Lokasyon taşı canMove ile gate', () => {
    expect(SRC).toMatch(/disabled=\{!canMove\}/)
  })

  it('Sil + Arşivle canDelete ile gate (per operator brief)', () => {
    expect(SRC).toMatch(/disabled=\{!canDelete\}[^>]*loading=\{deleteMut\.isPending\}/)
    // Archive Popconfirm + button disabled={!canDelete}
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const archiveSection = codeOnly.indexOf('archive_confirm_suffix')
    const deleteSection = codeOnly.indexOf('btn_delete_device')
    expect(archiveSection).toBeGreaterThan(0)
    expect(deleteSection).toBeGreaterThan(0)
    // Archive popconfirm + button parçaları canDelete'e bağlı
    const archiveSlice = codeOnly.slice(archiveSection, archiveSection + 600)
    expect(archiveSlice).toMatch(/!canDelete/)
  })

  it('Read-only banner ALL gates false durumunda', () => {
    expect(SRC).toMatch(/isReadOnly\s*=\s*!canFetchInfo\s*&&\s*!canLifecycle\s*&&\s*!canMove\s*&&\s*!canDelete/)
    expect(SRC).toMatch(/\{isReadOnly\s*&&[\s\S]{0,200}readonly_alert/)
  })
})
