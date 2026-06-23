/**
 * PR-A2 — AppLayout panelMode-aware sidebar contract.
 *
 * Source-level regression guard. PR-A2 removed OperationsSidebar in
 * favor of the legacy 12-group Sidebar in BOTH operations + legacy
 * panels (with routeOrgId-prefixed navigation via useNavGroups).
 *
 *   panelMode = 'platform'   → PlatformSidebar
 *   panelMode = 'operations' → legacy Sidebar (with routeOrgId prefix)
 *   panelMode = 'legacy'     → legacy Sidebar (root paths)
 *
 * MenuGroupNav renders in both operations + legacy (NOT platform).
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

describe('AppLayout — panelMode-aware sidebar (PR-A2)', () => {
  it('imports detectPanelMode from utils/panelMode', () => {
    expect(LAYOUT_SRC).toContain("from '@/utils/panelMode'")
    expect(LAYOUT_SRC).toContain('detectPanelMode')
  })

  it('imports PlatformSidebar + legacy Sidebar (OperationsSidebar removed)', () => {
    expect(LAYOUT_SRC).toContain("from './PlatformSidebar'")
    expect(LAYOUT_SRC).toContain("from './Sidebar'")
    expect(LAYOUT_SRC).not.toContain("from './OperationsSidebar'")
  })

  it('platform mode → PlatformSidebar', () => {
    expect(LAYOUT_SRC).toMatch(/panelMode\s*===\s*'platform'[\s\S]{0,40}\?[\s\S]{0,80}<PlatformSidebar/)
  })

  it('operations + legacy modes → legacy Sidebar (no OperationsSidebar branch)', () => {
    expect(LAYOUT_SRC).toMatch(/:\s*\(\s*<Sidebar/)
    expect(LAYOUT_SRC).not.toMatch(/<OperationsSidebar/)
  })

  it('MenuGroupNav is rendered in operations + legacy (NOT platform)', () => {
    expect(LAYOUT_SRC).toMatch(/panelMode\s*!==\s*'platform'\s*&&\s*<MenuGroupNav/)
  })

  it('LocationGate is skipped in platform mode (super-admin operates above tenants)', () => {
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
