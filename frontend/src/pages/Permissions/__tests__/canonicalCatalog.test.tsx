// @vitest-environment jsdom
/**
 * P2-CATALOG-A — Permission Set UI canonical key catalogue.
 *
 * Pins the five new actions (devices.{create, connect, move},
 * config_backups.{backup, restore}) on the Permission Set editor so
 * the matrix renders + the granted/total badge accounts for them.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../index.tsx'),
  'utf-8',
)

describe('Permissions UI — canonical catalog source pins', () => {
  it('MODULES.devices declares the seven canonical actions in order', () => {
    // The matrix renders actions in declaration order; this pin keeps
    // the visible column order stable.
    expect(SRC).toMatch(
      /key:\s*'devices'[\s\S]{0,400}'view'[\s\S]{0,300}'create'[\s\S]{0,200}'edit'[\s\S]{0,200}'delete'[\s\S]{0,200}'ssh'[\s\S]{0,200}'connect'[\s\S]{0,200}'move'/,
    )
  })

  it('MODULES.config_backups declares the five canonical actions in order', () => {
    expect(SRC).toMatch(
      /key:\s*'config_backups'[\s\S]{0,400}'view'[\s\S]{0,200}'edit'[\s\S]{0,200}'delete'[\s\S]{0,200}'backup'[\s\S]{0,200}'restore'/,
    )
  })

  it('Action labels surface the operator-facing Turkish strings', () => {
    expect(SRC).toMatch(/key:\s*'connect',\s*label:\s*'Bilgi Çek'/)
    expect(SRC).toMatch(/key:\s*'move',\s*label:\s*'Taşı'/)
    expect(SRC).toMatch(/key:\s*'backup',\s*label:\s*'Yedek Al'/)
    expect(SRC).toMatch(/key:\s*'restore',\s*label:\s*'Geri Yükle'/)
    // Pre-existing label preserved
    expect(SRC).toMatch(/key:\s*'ssh',\s*label:\s*'SSH'/)
  })

  it('ALL_ACTIONS includes the four new column keys', () => {
    expect(SRC).toMatch(/'connect',\s*'move',\s*'backup',\s*'restore'/)
  })

  it('ALL_ACTIONS column-header switch renders the new TR labels', () => {
    // The header maps action key → label inline; the new keys must
    // each resolve to a Turkish label so the column header is
    // human-readable for operators.
    expect(SRC).toMatch(/a === 'connect'\s*\?\s*'Bilgi Çek'/)
    expect(SRC).toMatch(/a === 'move'\s*\?\s*'Taşı'/)
    expect(SRC).toMatch(/a === 'backup'\s*\?\s*'Yedek Al'/)
    expect(SRC).toMatch(/a === 'restore'\s*\?\s*'Geri Yükle'/)
  })

  it('grantedCount badge formula references MODULES.actions.length', () => {
    // The totalCount badge is `MODULES.reduce((s, m) => s + m.actions.length, 0)`.
    // The new actions extend this sum automatically — the test pins
    // the formula so a future refactor cannot silently revert to a
    // hard-coded 37.
    expect(SRC).toMatch(/MODULES\.reduce\(\(sum,\s*m\)\s*=>\s*sum\s*\+\s*m\.actions\.length,\s*0\)/)
  })
})


// Behavioral check: MODULES.actions.length sums to 67 after Sprint 2.2A.
//   37 (pre-canonical) + 5 (P2-CATALOG-A) + 9 (RBAC-Phase-1)
//   + 4 (Sprint 2.1) + 12 (Sprint 2.2A) = 67
// Sprint 2.2A breakdown:
//   config_drift(view, manage, run) = 3
//   security_audit(view, profile_manage, run) = 3
//   asset_lifecycle(view, manage) = 2
//   terminal_sessions(view, summarize) = 2
//   mac_arp(view, collect) = 2
//   total = 12
describe('Permissions UI — total grant count', () => {
  it('total actions across all modules = 67 (37 prior + 5 P2-CATALOG-A + 9 RBAC-Phase-1 + 4 Sprint-2.1 + 12 Sprint-2.2A)', async () => {
    const moduleBlock = SRC.match(/const MODULES[\s\S]*?\n\]\n/m)
    expect(moduleBlock).toBeTruthy()
    const declared = moduleBlock![0]
    // 14 + 4 (Phase 1) + 2 (Sprint 2.1) + 5 (Sprint 2.2A) = 25 module keys
    const innerActionCount = (declared.match(/\{\s*key:\s*'(?!devices|config_backups|tasks|playbooks|topology|monitoring|ipam|audit_logs|reports|users|locations|agents|settings|driver_templates|discovery|vlan|racks|maps|approvals|notifications|config_drift|security_audit|asset_lifecycle|terminal_sessions|mac_arp)/g) ?? []).length
    expect(innerActionCount).toBe(67)
  })
})

// Sprint 2.2A pins — 5 new module rows.
describe('Sprint 2.2A — new module rows in Permissions UI', () => {
  it('MODULES.config_drift declares view + manage + run actions', () => {
    expect(SRC).toMatch(
      /key:\s*'config_drift'[\s\S]{0,400}'view'[\s\S]{0,200}'manage'[\s\S]{0,200}'run'/,
    )
  })
  it('MODULES.security_audit declares view + profile_manage + run actions', () => {
    expect(SRC).toMatch(
      /key:\s*'security_audit'[\s\S]{0,400}'view'[\s\S]{0,200}'profile_manage'[\s\S]{0,200}'run'/,
    )
  })
  it('MODULES.asset_lifecycle declares view + manage', () => {
    expect(SRC).toMatch(
      /key:\s*'asset_lifecycle'[\s\S]{0,300}'view'[\s\S]{0,200}'manage'/,
    )
  })
  it('MODULES.terminal_sessions declares view + summarize', () => {
    expect(SRC).toMatch(
      /key:\s*'terminal_sessions'[\s\S]{0,300}'view'[\s\S]{0,200}'summarize'/,
    )
  })
  it('MODULES.mac_arp declares view + collect', () => {
    expect(SRC).toMatch(
      /key:\s*'mac_arp'[\s\S]{0,300}'view'[\s\S]{0,200}'collect'/,
    )
  })
  it('Action labels surface the TR strings for new Sprint 2.2A verbs', () => {
    expect(SRC).toMatch(/key:\s*'profile_manage',\s*label:\s*'Profil Yönet'/)
    expect(SRC).toMatch(/key:\s*'summarize',\s*label:\s*'AI Özet'/)
    expect(SRC).toMatch(/key:\s*'collect',\s*label:\s*'Topla'/)
    expect(SRC).toMatch(/key:\s*'run',\s*label:\s*'Şimdi Çalıştır'/)
  })
  it('ALL_ACTIONS includes profile_manage + summarize + collect column keys', () => {
    expect(SRC).toMatch(/'profile_manage',\s*'summarize',\s*'collect'/)
  })
  it('ALL_ACTIONS column-header switch renders TR labels for new verbs', () => {
    expect(SRC).toMatch(/a === 'profile_manage'\s*\?\s*'Profil Yönet'/)
    expect(SRC).toMatch(/a === 'summarize'\s*\?\s*'AI Özet'/)
    expect(SRC).toMatch(/a === 'collect'\s*\?\s*'Topla'/)
  })
})

// Sprint 2.1 pins — approvals + notifications module rows.
describe('Sprint 2.1 — new module rows in Permissions UI', () => {
  it('MODULES.approvals declares view + review actions', () => {
    expect(SRC).toMatch(
      /key:\s*'approvals'[\s\S]{0,300}'view'[\s\S]{0,200}'review'/,
    )
  })
  it('MODULES.notifications declares view + manage actions', () => {
    expect(SRC).toMatch(
      /key:\s*'notifications'[\s\S]{0,300}'view'[\s\S]{0,200}'manage'/,
    )
  })
  it('Action labels surface the Turkish strings for new verbs', () => {
    expect(SRC).toMatch(/key:\s*'review',\s*label:\s*'Onayla\/Reddet'/)
    expect(SRC).toMatch(/key:\s*'manage',\s*label:\s*'Yönet'/)
  })
  it('ALL_ACTIONS includes review + manage column keys', () => {
    expect(SRC).toMatch(/'review',\s*'manage'/)
  })
  it('ALL_ACTIONS column-header switch renders TR labels for new verbs', () => {
    expect(SRC).toMatch(/a === 'review'\s*\?\s*'Onayla\/Reddet'/)
    expect(SRC).toMatch(/a === 'manage'\s*\?\s*'Yönet'/)
  })
})
