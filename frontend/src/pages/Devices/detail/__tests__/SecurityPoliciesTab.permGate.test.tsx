// @vitest-environment jsdom
/**
 * P2-F1 HOTFIX (2026-06-23) — SecurityPoliciesTab Save gate.
 *
 * Önceki implementation Save'i `isOrgAdmin()` ile kilitliyordu.
 * Backend kayıt yolu `PATCH /devices/{id}` zaten `device:edit` gate'i
 * uyguluyor; UI artık aynı kontratı kullanır.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect } from 'vitest'

describe('SecurityPoliciesTab — P2-F1 source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../SecurityPoliciesTab.tsx'),
    'utf-8',
  )

  it('isOrgAdmin tabanlı canWrite ARTIK YOK', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/const\s+canWrite\s*=\s*isOrgAdmin\(\)/)
    expect(codeOnly).not.toMatch(/const\s*\{\s*isOrgAdmin\s*\}\s*=\s*useAuthStore\(\)/)
  })

  it('canWrite artık can(devices, edit) ile bağlı', () => {
    expect(SRC).toMatch(/canWrite\s*=\s*useAuthStore\(\(s\)\s*=>\s*s\.can\('devices',\s*'edit'\)\)/)
  })

  it('canWrite gate yazma kontrollerinde hâlâ kullanılıyor (3 kullanım korundu)', () => {
    // Disabled/visible kullanımlarının var olduğu doğrula — minimal diff garantisi.
    const usages = SRC.match(/canWrite/g) ?? []
    // 1 atama + 4 referans (disabled x2, readonly_tag conditional, save section)
    expect(usages.length).toBeGreaterThanOrEqual(4)
  })
})

import { render, cleanup, screen } from '@testing-library/react'
import { vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/devices', () => ({
  devicesApi: {
    update: vi.fn(),
  },
}))

vi.mock('@/api/securityPolicies', () => ({
  securityPoliciesApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/api/portPolicyAssignments', () => ({
  portPolicyAssignmentsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
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
    }
    return selector ? selector(fake) : fake
  },
}))

import SecurityPoliciesTab from '../SecurityPoliciesTab'

function makeDevice() {
  return {
    id: 95, hostname: 'Omurga',
    security_policy_id: null, port_security_policy_id: null,
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
          <SecurityPoliciesTab device={makeDevice()} />
        </AntApp>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  resetPerms()
})

afterEach(() => {
  cleanup()
})

describe('SecurityPoliciesTab — P2-F1 behavioral', () => {
  it('devices.edit=false → read-only tag görünür', async () => {
    renderTab()
    expect(await screen.findByText('devices.detail.security.readonly_tag')).toBeTruthy()
  })

  it('devices.edit=true (granted location_admin) → read-only tag YOK', () => {
    setPerm('devices', 'edit', true)
    renderTab()
    expect(screen.queryByText('devices.detail.security.readonly_tag')).toBeNull()
  })
})
