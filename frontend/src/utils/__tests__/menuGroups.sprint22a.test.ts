// @vitest-environment jsdom
/**
 * RBAC-SPRINT-2.2A — 5 route + menu gate alignment tests.
 *
 * Pre-Sprint-2.2A the five affected menu tabs used a mix of
 * RoleRoute(minRole="org_admin") and PermRoute with RECYCLED modules
 * (monitoring:view for Security Audit + Asset Lifecycle + MAC/ARP;
 *  audit_logs:view for Terminal Sessions). Sprint 2.2A wires each
 * surface to its own dedicated module + view verb, matching the
 * backend gate:
 *
 *   /config-drift       → PermRoute(config_drift, view)
 *   /security-audit     → PermRoute(security_audit, view)
 *   /asset-lifecycle    → PermRoute(asset_lifecycle, view)
 *   /terminal-sessions  → PermRoute(terminal_sessions, view)
 *   /mac-arp            → PermRoute(mac_arp, view)
 *
 * The Alembic migration f9aj_rbac_authorization_hardening backfills
 * every existing operator's view access via carry-over rules so
 * nobody loses access on deploy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  GROUP_BY_KEY,
  canSeeTab,
  type VisibilityContext,
  type TabDef,
} from '@/utils/menuGroups'
import type { SystemRole } from '@/types'

// ─── Test context builder ───────────────────────────────────────────────

function ctxFor(
  role: SystemRole,
  opts: {
    grants?: Record<string, Record<string, boolean>>
    features?: Record<string, boolean>
  } = {},
): VisibilityContext {
  const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']
  const myIdx = ROLE_ORDER.indexOf(role)
  const grants = opts.grants ?? {}
  return {
    isSuperAdmin: () => role === 'super_admin',
    hasPermission: (minRole) => myIdx >= ROLE_ORDER.indexOf(minRole),
    can: (mod, action) => {
      if (role === 'super_admin' || role === 'org_admin') return true
      return !!grants[mod]?.[action]
    },
    features: opts.features ?? {},
  }
}

// ─── Lookups ────────────────────────────────────────────────────────────

const MAC_ARP_TAB       = GROUP_BY_KEY.monitoring.tabs.find((t) => t.key === 'port_intelligence')!
const CONFIG_DRIFT_TAB  = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'drift')!
const SEC_AUDIT_TAB     = GROUP_BY_KEY.security.tabs.find((t) => t.key === 'audit')!
const ASSET_LC_TAB      = GROUP_BY_KEY.security.tabs.find((t) => t.key === 'lifecycle')!
const TERMINAL_SESS_TAB = GROUP_BY_KEY.admin_audit.tabs.find((t) => t.key === 'ssh')!

// ═════════════════════════════════════════════════════════════════════════
// Tab gate definition
// ═════════════════════════════════════════════════════════════════════════

describe('Sprint 2.2A — tab gate modules', () => {
  it('mac-arp uses [mac_arp, view]', () => {
    expect(MAC_ARP_TAB.module).toEqual(['mac_arp', 'view'])
    expect(MAC_ARP_TAB.minRole).toBeUndefined()
  })
  it('config-drift uses [config_drift, view]', () => {
    expect(CONFIG_DRIFT_TAB.module).toEqual(['config_drift', 'view'])
    expect(CONFIG_DRIFT_TAB.minRole).toBeUndefined()
  })
  it('security-audit uses [security_audit, view]', () => {
    expect(SEC_AUDIT_TAB.module).toEqual(['security_audit', 'view'])
    expect(SEC_AUDIT_TAB.minRole).toBeUndefined()
  })
  it('asset-lifecycle uses [asset_lifecycle, view]', () => {
    expect(ASSET_LC_TAB.module).toEqual(['asset_lifecycle', 'view'])
    expect(ASSET_LC_TAB.minRole).toBeUndefined()
  })
  it('terminal-sessions uses [terminal_sessions, view]', () => {
    expect(TERMINAL_SESS_TAB.module).toEqual(['terminal_sessions', 'view'])
    expect(TERMINAL_SESS_TAB.minRole).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Visibility scenarios — permission grants drive the tab
// ═════════════════════════════════════════════════════════════════════════

const TABS: Array<{ label: string; tab: TabDef; module: string }> = [
  { label: 'mac-arp',          tab: MAC_ARP_TAB,       module: 'mac_arp' },
  { label: 'config-drift',     tab: CONFIG_DRIFT_TAB,  module: 'config_drift' },
  { label: 'security-audit',   tab: SEC_AUDIT_TAB,     module: 'security_audit' },
  { label: 'asset-lifecycle',  tab: ASSET_LC_TAB,      module: 'asset_lifecycle' },
  { label: 'terminal-sessions', tab: TERMINAL_SESS_TAB, module: 'terminal_sessions' },
]

describe.each(TABS)('Sprint 2.2A visibility — $label', ({ tab, module }) => {
  it('location_admin with :view = true → visible', () => {
    const ctx = ctxFor('location_admin', { grants: { [module]: { view: true } } })
    expect(canSeeTab(tab, ctx)).toBe(true)
  })
  it('location_admin without :view → hidden', () => {
    const ctx = ctxFor('location_admin')
    expect(canSeeTab(tab, ctx)).toBe(false)
  })
  it('viewer with :view = true → visible', () => {
    const ctx = ctxFor('viewer', { grants: { [module]: { view: true } } })
    expect(canSeeTab(tab, ctx)).toBe(true)
  })
  it('viewer without :view → hidden', () => {
    const ctx = ctxFor('viewer')
    expect(canSeeTab(tab, ctx)).toBe(false)
  })
  it('org_admin → visible (bypass mirror)', () => {
    expect(canSeeTab(tab, ctxFor('org_admin'))).toBe(true)
  })
  it('super_admin → visible (bypass mirror)', () => {
    expect(canSeeTab(tab, ctxFor('super_admin'))).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// App.tsx source-grep regression pins
// ═════════════════════════════════════════════════════════════════════════

describe('App.tsx route gate alignment', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  const routes: Array<{ path: string; module: string }> = [
    { path: 'config-drift',       module: 'config_drift' },
    { path: 'security-audit',     module: 'security_audit' },
    { path: 'asset-lifecycle',    module: 'asset_lifecycle' },
    { path: 'terminal-sessions',  module: 'terminal_sessions' },
    { path: 'mac-arp',            module: 'mac_arp' },
  ]

  it.each(routes)('/$path uses PermRoute($module, view) on BOTH mounts', ({ path: p, module }) => {
    const pattern = new RegExp(
      `path="${p}"[^>]*<PermRoute module="${module}" action="view">`,
      'g',
    )
    const matches = appSrc.match(pattern)
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('no RoleRoute(minRole="org_admin") survives on /config-drift', () => {
    expect(appSrc).not.toMatch(/path="config-drift"[^>]*<RoleRoute minRole="org_admin">/)
  })

  it.each([
    { path: 'security-audit',    old: 'monitoring' },
    { path: 'asset-lifecycle',   old: 'monitoring' },
    { path: 'mac-arp',           old: 'monitoring' },
    { path: 'terminal-sessions', old: 'audit_logs' },
  ])('/$path no longer uses recycled module=$old', ({ path: p, old }) => {
    const pattern = new RegExp(
      `path="${p}"[^>]*<PermRoute module="${old}" action="view">`,
    )
    expect(appSrc).not.toMatch(pattern)
  })
})
