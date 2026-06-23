// @vitest-environment jsdom
/**
 * P2-F1 HOTFIX (2026-06-23) — BackupTab per-action permission gates.
 *
 * Önceki implementation Yedek Al + Golden işaretle butonlarını
 * `isOrgAdmin()` ile kilitliyordu. `location_admin` (örn. emre + Tam
 * Yetki perm_set) backend tarafı `config:backup` granted olduğu halde
 * yedek alamıyordu. Bu test artık doğru per-action gate'i pinler.
 *
 *   Yedek Al           → can('config_backups', 'backup')
 *   Golden işaretle    → can('config_backups', 'edit')
 *   Geri Yükle         → can('config_backups', 'restore')   (UI surface yok; hook hazır)
 *
 * Read-only hint: hiçbir yazma aksiyonu kullanılabilir değilse.
 */
import { render, cleanup, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/devices', () => ({
  devicesApi: {
    getBackups: vi.fn().mockResolvedValue([]),
    getConfigDrift: vi.fn().mockResolvedValue({ drift_detected: false }),
    getBackupContent: vi.fn(),
    takeBackup: vi.fn(),
    setGoldenBackup: vi.fn(),
    downloadBackup: vi.fn(),
    checkConfigPolicy: vi.fn(),
  },
}))

vi.mock('./LiveConfigTab', () => ({
  default: () => <div data-testid="live-config-tab" />,
}))

vi.mock('./DiffViewerDrawer', () => ({
  default: () => <div data-testid="diff-drawer" />,
}))

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
      isLocationAdmin: () => true,
    }
    return selector ? selector(fake) : fake
  },
}))

import BackupTab from '../BackupTab'

function makeDevice() {
  return { id: 95, hostname: 'Omurga', ip_address: '10.255.0.1' } as any
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <BackupTab device={makeDevice()} />
      </AntApp>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  resetPerms()
  // @ts-ignore — AntD Tabs polyfills matchMedia; jsdom omits it.
  if (!window.matchMedia) {
    // @ts-ignore
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    })
  }
})

afterEach(() => {
  cleanup()
})

describe('BackupTab — P2-F1 per-action gates (behavioral)', () => {
  it('Case 3 — location_admin + config_backups.backup=true → Yedek Al butonu görünür', async () => {
    setPerm('config_backups', 'backup', true)
    renderTab()
    // BackupTab default sub-tab "backups" → Yedek Al butonu sub-tab içinde
    // canBackup=true ise render edilir.
    const takeBtn = await screen.findByText('devices.detail.backup.take_btn')
    expect(takeBtn).toBeTruthy()
  })

  it('Case 3b — location_admin + config_backups.backup=false → Yedek Al butonu HİÇ render edilmez', () => {
    setPerm('config_backups', 'backup', false)
    renderTab()
    expect(screen.queryByText('devices.detail.backup.take_btn')).toBeNull()
  })

  it('Case 5 — yetkisiz kullanıcı (her şey false) → Yedek Al yok + read-only hint görünür', async () => {
    renderTab()
    expect(screen.queryByText('devices.detail.backup.take_btn')).toBeNull()
    // Read-only hint görünür (i18n key)
    const hint = await screen.findByText('devices.detail.backup.readonly_hint')
    expect(hint).toBeTruthy()
  })

  it('Case 6 — full grant: canBackup + canEdit + canRestore → read-only hint YOK + Yedek Al görünür', async () => {
    setPerm('config_backups', 'backup', true)
    setPerm('config_backups', 'edit', true)
    setPerm('config_backups', 'restore', true)
    renderTab()
    expect(await screen.findByText('devices.detail.backup.take_btn')).toBeTruthy()
    expect(screen.queryByText('devices.detail.backup.readonly_hint')).toBeNull()
  })
})

// ─── Source-level pins ────────────────────────────────────────────────────

describe('BackupTab — P2-F1 source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../BackupTab.tsx'),
    'utf-8',
  )

  it('isOrgAdmin tabanlı canWrite ARTIK YOK', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/const\s+canWrite\s*=\s*isOrgAdmin\(\)/)
    expect(codeOnly).not.toMatch(/const\s*\{\s*isOrgAdmin\s*\}\s*=\s*useAuthStore\(\)/)
  })

  it('3 granular gate tanımlı: canBackup + canRestore + canEditBackup', () => {
    expect(SRC).toMatch(/canBackup\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('config_backups',\s*'backup'\)\)/)
    expect(SRC).toMatch(/canRestore\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('config_backups',\s*'restore'\)\)/)
    expect(SRC).toMatch(/canEditBackup\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('config_backups',\s*'edit'\)\)/)
  })

  it('Yedek Al butonu canBackup ile gate', () => {
    expect(SRC).toMatch(/\{canBackup\s*&&[\s\S]{0,800}take_btn/)
  })

  it('Golden işaretle canEditBackup ile gate', () => {
    expect(SRC).toMatch(/\{canEditBackup\s*&&\s*!r\.is_golden[\s\S]{0,400}action_make_golden/)
  })

  it('Read-only hint hesabı: !canBackup && !canRestore && !canEditBackup', () => {
    expect(SRC).toMatch(/isReadOnly\s*=\s*!canBackup\s*&&\s*!canRestore\s*&&\s*!canEditBackup/)
    expect(SRC).toMatch(/\{isReadOnly\s*&&[\s\S]{0,200}readonly_hint/)
  })
})
