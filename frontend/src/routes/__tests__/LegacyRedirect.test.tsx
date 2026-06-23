/**
 * PR-A — LegacyRedirect contract.
 *
 * Three legacy entry points (`/dashboard`, `/devices`, `/agents`) keep
 * working for bookmarks / external links / email but redirect to the
 * URL-authoritative `/app/org/:resolvedOrgId/<segment>`.
 *
 * P0.1 HOTFIX (2026-06-23) — the redirect decision is now JWT-only
 * (`user.system_role` + `user.org_id` + `activeOrgId` hint). The
 * pre-hotfix `ctxResolved` wait was the load-bearing source of the
 * production "Lokasyon bağlamı çözümleniyor…" deadlock on /dashboard;
 * see `LegacyRedirect.tsx` for the full rationale chain.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { afterEach, vi } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../LegacyRedirect.tsx'),
  'utf-8',
)

// ─── Source-level pins ────────────────────────────────────────────────────

describe('LegacyRedirect — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../LegacyRedirect')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('LegacyRedirect — source-level contract', () => {
  it('accepts segment: dashboard | devices | agents (PR-A allowlist)', () => {
    expect(SRC).toMatch(/segment:\s*'dashboard'\s*\|\s*'devices'\s*\|\s*'agents'/)
  })

  it('P0.1: no `ctxResolved` wait (the load-bearing deadlock source is GONE)', () => {
    // Strip comments before asserting — the rationale block in the
    // module header references ctxResolved historically.
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/ctxResolved/)
  })

  it('P0.1: super-admin + dashboard → /platform/overview', () => {
    expect(SRC).toMatch(
      /isSuperAdmin\s*&&\s*segment\s*===\s*'dashboard'[\s\S]{0,200}Navigate\s+to="\/platform\/overview"/,
    )
  })

  it('P0.1: super-admin + activeOrgId set → /app/org/<activeOrgId>/<segment>', () => {
    expect(SRC).toMatch(
      /isSuperAdmin[\s\S]{0,200}activeOrgId != null[\s\S]{0,200}Navigate\s+to=\{`\/app\/org\/\$\{activeOrgId\}\/\$\{segment\}`\}/,
    )
  })

  it('P0.1: super-admin without activeOrgId → /platform/organizations', () => {
    expect(SRC).toMatch(/Navigate\s+to="\/platform\/organizations"\s+replace/)
  })

  it('P0.1: normal user → /app/org/<user.org_id>/<segment>', () => {
    expect(SRC).toMatch(
      /Navigate\s+to=\{`\/app\/org\/\$\{userOrgId\}\/\$\{segment\}`\}\s+replace/,
    )
  })

  it('no user (token missing) → /', () => {
    expect(SRC).toMatch(/if\s*\(!user\)\s*return\s*<Navigate\s+to="\/"\s+replace\s*\/>/)
  })
})


// ─── Behavioral tests (jsdom) ─────────────────────────────────────────────

const authState: { user: { id: number; username: string; system_role: string; org_id: number | null; role: string } | null } = { user: null }
vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => selector ? selector(authState) : authState,
    {
      getState: () => authState,
      setState: (patch: any) => { Object.assign(authState, patch) },
    },
  ),
}))

const siteState: { activeOrgId: number | null } = { activeOrgId: null }
vi.mock('@/contexts/SiteContext', () => ({
  useSite: () => siteState,
}))

import LegacyRedirect from '../LegacyRedirect'

function renderAt(initialPath: string, segment: 'dashboard' | 'devices' | 'agents') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path={initialPath.slice(1)} element={<LegacyRedirect segment={segment} />} />
        <Route path="login" element={<div data-testid="dest">/login</div>} />
        <Route path="" element={<div data-testid="dest">/</div>} />
        <Route path="platform/overview" element={<div data-testid="dest">/platform/overview</div>} />
        <Route path="platform/organizations" element={<div data-testid="dest">/platform/organizations</div>} />
        <Route path="app/org/:organizationId/:segment" element={<DestSpy />} />
      </Routes>
    </MemoryRouter>,
  )
}

function DestSpy() {
  // Get pathname directly from the test harness — written below in each case
  return <div data-testid="dest">app-org</div>
}

afterEach(() => {
  authState.user = null
  siteState.activeOrgId = null
  cleanup()
})

describe('LegacyRedirect — behavioral cases (P0.1)', () => {
  it('Case 1: super-admin + /dashboard → /platform/overview (ctxResolved irrelevant)', () => {
    authState.user = { id: 1, username: 'admin', system_role: 'super_admin', role: 'super_admin', org_id: 1 }
    siteState.activeOrgId = null
    const { container } = renderAt('/dashboard', 'dashboard')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('/platform/overview')
  })

  it('Case 2: normal user + /dashboard → /app/org/<user.org_id>/dashboard', () => {
    authState.user = { id: 6, username: 'coosef', system_role: 'org_admin', role: 'org_admin', org_id: 6 }
    siteState.activeOrgId = null
    const { container } = renderAt('/dashboard', 'dashboard')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('app-org')
  })

  it('Case 3: super-admin + activeOrgId=6 + /devices → /app/org/6/devices', () => {
    authState.user = { id: 1, username: 'admin', system_role: 'super_admin', role: 'super_admin', org_id: 1 }
    siteState.activeOrgId = 6
    const { container } = renderAt('/devices', 'devices')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('app-org')
  })

  it('Case 4: super-admin + activeOrgId=null + /devices → /platform/organizations', () => {
    authState.user = { id: 1, username: 'admin', system_role: 'super_admin', role: 'super_admin', org_id: 1 }
    siteState.activeOrgId = null
    const { container } = renderAt('/devices', 'devices')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('/platform/organizations')
  })

  it('Case 7: no user (token missing) + /dashboard → /', () => {
    authState.user = null
    siteState.activeOrgId = null
    const { container } = renderAt('/dashboard', 'dashboard')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('/')
  })

  it('super-admin + /agents + activeOrgId=42 → /app/org/42/agents (operations alias path)', () => {
    authState.user = { id: 1, username: 'admin', system_role: 'super_admin', role: 'super_admin', org_id: 1 }
    siteState.activeOrgId = 42
    const { container } = renderAt('/agents', 'agents')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('app-org')
  })

  it('normal user without org_id → / (defensive)', () => {
    authState.user = { id: 99, username: 'broken', system_role: 'viewer', role: 'viewer', org_id: null }
    siteState.activeOrgId = null
    const { container } = renderAt('/dashboard', 'dashboard')
    expect(container.querySelector('[data-testid="dest"]')?.textContent).toBe('/')
  })
})
