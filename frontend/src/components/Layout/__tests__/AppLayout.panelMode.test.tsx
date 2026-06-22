/**
 * PR-A — AppLayout panelMode switching contract.
 *
 * Source-level regression guard on the AppLayout sidebar / Header /
 * MenuGroupNav / LocationGate conditionals: a regression that wires the
 * legacy Sidebar into /platform/* (or vice versa) would silently break
 * the entire PR-A surface.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const LAYOUT_SRC = readFileSync(
  resolve(__dirname, '../AppLayout.tsx'),
  'utf-8',
)

const HEADER_SRC = readFileSync(
  resolve(__dirname, '../Header.tsx'),
  'utf-8',
)

describe('AppLayout — panelMode-aware sidebar', () => {
  it('imports detectPanelMode from utils/panelMode', () => {
    expect(LAYOUT_SRC).toContain("from '@/utils/panelMode'")
    expect(LAYOUT_SRC).toContain('detectPanelMode')
  })

  it('imports PlatformSidebar + OperationsSidebar + legacy Sidebar', () => {
    expect(LAYOUT_SRC).toContain("from './PlatformSidebar'")
    expect(LAYOUT_SRC).toContain("from './OperationsSidebar'")
    expect(LAYOUT_SRC).toContain("from './Sidebar'")
  })

  it('platform mode → PlatformSidebar', () => {
    expect(LAYOUT_SRC).toMatch(/panelMode\s*===\s*'platform'[\s\S]*?<PlatformSidebar/)
  })

  it('operations mode → OperationsSidebar', () => {
    expect(LAYOUT_SRC).toMatch(/panelMode\s*===\s*'operations'[\s\S]*?<OperationsSidebar/)
  })

  it('MenuGroupNav is rendered only in legacy mode', () => {
    expect(LAYOUT_SRC).toMatch(/panelMode\s*===\s*'legacy'\s*&&\s*<MenuGroupNav/)
  })

  it('LocationGate is skipped in platform mode (super-admin operates above tenants)', () => {
    // The platform branch renders a bare <Outlet />; the legacy/operations
    // branch wraps in <LocationGate>. Both must appear in the conditional.
    expect(LAYOUT_SRC).toMatch(
      /panelMode\s*===\s*'platform'\s*\?\s*\(\s*<Outlet\s*\/>\s*\)\s*:\s*\(\s*<LocationGate/,
    )
  })
})

describe('Header — panelMode-aware tenant widgets', () => {
  it('imports detectPanelMode + OrgBadge', () => {
    expect(HEADER_SRC).toContain("from '@/utils/panelMode'")
    expect(HEADER_SRC).toContain("from './OrgBadge'")
  })

  it('OrgBadge renders only in operations mode', () => {
    expect(HEADER_SRC).toMatch(/panelMode\s*===\s*'operations'\s*&&\s*<OrgBadge/)
  })

  it('OrganizationSelector renders only in legacy mode', () => {
    expect(HEADER_SRC).toMatch(/panelMode\s*===\s*'legacy'\s*&&\s*<OrganizationSelector/)
  })

  it('LocationSelector is HIDDEN in platform mode', () => {
    expect(HEADER_SRC).toMatch(/panelMode\s*!==\s*'platform'\s*&&\s*<LocationSelector/)
  })
})
