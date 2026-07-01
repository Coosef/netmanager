// @vitest-environment jsdom
/**
 * RBAC-SPRINT-2.2C-A — Firmware read hardening regression pins.
 *
 * Sprint 2.2C-A is a READ-ONLY backend hardening PR paired with a
 * frontend feature-flag alignment change. The frontend does exactly
 * three things:
 *   1. Adds `feature: 'firmware'` to the firmware menu tab so an org
 *      with `plan.features.firmware === false` never sees the tab
 *      (matches the backend `_feat("firmware")` gate on router.py:62).
 *   2. Keeps the /firmware route at `RoleRoute(minRole="org_admin")`
 *      on BOTH nested mounts — no PermRoute migration in this PR.
 *   3. Adds a Firmware row to the Permission Matrix editor with the
 *      full six-verb column set so operators can toggle the future
 *      mutating gates once the deferred high-risk PR lands.
 *
 * These tests pin the intentional NON-changes so a future PR that
 * migrates Firmware to PermRoute or opens it to location_admin MUST
 * also update this test file (providing an intentional review
 * checkpoint).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GROUP_BY_KEY } from '@/utils/menuGroups'

// ═════════════════════════════════════════════════════════════════════════
// menuGroups.ts — firmware tab feature-flag alignment
// ═════════════════════════════════════════════════════════════════════════

describe('Sprint 2.2C-A — firmware menu tab feature-flag alignment', () => {
  const firmwareTab = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'firmware')!

  it('firmware tab exists in the config group', () => {
    expect(firmwareTab).toBeDefined()
    expect(firmwareTab.route).toBe('/firmware')
  })

  it('firmware tab still gates on minRole=org_admin (unchanged)', () => {
    expect(firmwareTab.minRole).toBe('org_admin')
  })

  it('firmware tab still has NO module gate — no PermRoute migration', () => {
    // Regression pin: Sprint 2.2C-A is READ-ONLY backend hardening;
    // the frontend route + tab gate stay on RoleRoute(org_admin). A
    // future PR that opens firmware to location_admin must also flip
    // this assertion.
    expect(firmwareTab.module).toBeUndefined()
  })

  it('firmware tab carries the feature: "firmware" alignment field', () => {
    // NEW pin — backend router.py:62 has `_feat("firmware")` on the
    // firmware.router include. Without this frontend field, an org
    // with plan.features.firmware=false would see the tab (frontend
    // gate passes on minRole alone) and get 403 on click. Adding the
    // feature field closes the asymmetry.
    expect(firmwareTab.feature).toBe('firmware')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// App.tsx — /firmware route still uses RoleRoute on BOTH mounts
// ═════════════════════════════════════════════════════════════════════════

describe('App.tsx /firmware route gate is UNCHANGED (regression pin)', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  it('/firmware still uses RoleRoute(minRole="org_admin") on BOTH mounts', () => {
    const matches = appSrc.match(
      /path="firmware"[^>]*<RoleRoute minRole="org_admin">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('/firmware has NOT silently migrated to PermRoute during this PR', () => {
    // If a future PR wants to open Firmware to location_admin via
    // firmware:view / firmware:rollout_status, it should ALSO update
    // this test. Until then, no PermRoute wrapper on /firmware is
    // permitted.
    expect(appSrc).not.toMatch(/path="firmware"[^>]*<PermRoute module="firmware"/)
  })
})
