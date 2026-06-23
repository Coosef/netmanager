/**
 * PR-A2 — App.tsx route alias audit.
 *
 * Every legacy operations module the operator listed in the
 * restoration scope MUST also have an `/app/org/:organizationId/...`
 * alias inside `<Route element={<OrgRouteShell />}>`. A regression
 * that drops one alias silently re-introduces the "Yakında" stuck-on
 * UX OR a sidebar click that escapes to the legacy panel.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const APP_SRC = readFileSync(
  resolve(__dirname, './App.tsx'),
  'utf-8',
)

// Pull just the OrgRouteShell child-routes block out of App.tsx so the
// audit can never accidentally match a sibling route declaration.
function extractOrgShellBlock(): string {
  const start = APP_SRC.indexOf('path="app/org/:organizationId"')
  expect(start).toBeGreaterThan(0)
  // The block ends with the closing </Route> after the last child.
  const after = APP_SRC.slice(start)
  const closingIdx = after.indexOf('</Route>')
  expect(closingIdx).toBeGreaterThan(0)
  return after.slice(0, closingIdx)
}

const ORG_SHELL_BLOCK = extractOrgShellBlock()

describe('App.tsx — OrgRouteShell wraps every restored operations route', () => {
  it.each([
    // PR-A foundation (preserved)
    'dashboard',
    'devices',
    'agents',
    // Inventory (PR-A2)
    'topology',
    'topology-classic',
    'topology-next',
    'discovery',
    'ipam',
    'vlan',
    'racks',
    'floor-plan',
    // Monitoring
    'monitor',
    'live',
    'intelligence',
    'bandwidth',
    'mac-arp',
    'synthetic-probes',
    // Alerts
    'alert-rules',
    'escalation-rules',
    'incidents',
    'services',
    // Config
    'config-drift',
    'config-templates',
    'config-builder',
    'backups',
    'firmware',
    'driver-templates',
    // Automation
    'tasks',
    'playbooks',
    'change-management',
    'approvals',
    // Security
    'security-audit',
    'security-policies',
    'compliance',
    'asset-lifecycle',
    // Reports
    'sla',
    'poe',
    'reports',
    'topology-twin',
    // Tools
    'diagnostics',
    'ai-assistant',
    // admin_users
    'users',
    'permissions',
    'locations',
    // admin_audit
    'audit',
    'terminal-sessions',
  ])('route alias under OrgRouteShell: %s', (segment) => {
    const re = new RegExp(`<Route\\s+path="${segment.replace(/-/g, '\\-')}"`)
    expect(ORG_SHELL_BLOCK).toMatch(re)
  })

  it('OrgRouteShell index route redirects to dashboard', () => {
    expect(ORG_SHELL_BLOCK).toMatch(/<Route\s+index\s+element=\{<Navigate\s+to="dashboard"\s+replace/)
  })

  it('contains exactly the deviceDetail + ports nested routes', () => {
    expect(ORG_SHELL_BLOCK).toMatch(/<Route\s+path="devices\/:deviceId"/)
    expect(ORG_SHELL_BLOCK).toMatch(/<Route\s+path="devices\/:deviceId\/ports"/)
  })

  it('44 child routes total under OrgRouteShell (3 PR-A + 40 PR-A2 aliases + 1 index)', () => {
    const count = (ORG_SHELL_BLOCK.match(/<Route\s/g) || []).length
    // Index + dashboard + devices + devices/:deviceId + devices/:deviceId/ports + agents
    // + 40 PR-A2 aliases = 46
    expect(count).toBeGreaterThanOrEqual(44)
  })
})

describe('App.tsx — legacy root routes preserved (bookmark compatibility)', () => {
  it.each([
    'topology',
    'monitor',
    'reports',
    'audit',
    'users',
    'ipam',
    'vlan',
  ])('legacy root /%s route still mounted (outside OrgRouteShell)', (segment) => {
    // The legacy entries live BEFORE the OrgRouteShell block in App.tsx;
    // they remain reachable by direct URL/bookmark but operations sidebar
    // never navigates to them (per PR-A2 contract).
    const re = new RegExp(`<Route\\s+path="${segment.replace(/-/g, '\\-')}"`)
    expect(APP_SRC).toMatch(re)
  })

  it('LegacyRedirect retained for /dashboard, /devices, /agents', () => {
    expect(APP_SRC).toMatch(/<Route\s+path="dashboard"\s+element=\{<LegacyRedirect/)
    expect(APP_SRC).toMatch(/<Route\s+path="devices"\s+element=\{<LegacyRedirect/)
    expect(APP_SRC).toMatch(/<Route\s+path="agents"\s+element=\{<LegacyRedirect/)
  })
})
