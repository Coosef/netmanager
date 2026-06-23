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


// Behavioral check: MODULES.actions.length sums to 42 with the new keys.
describe('Permissions UI — total grant count', () => {
  it('total actions across all modules = 42 (37 prior + 5 P2-CATALOG-A)', async () => {
    // Re-evaluate the literal by parsing the file: we count the
    // `{ key:` markers inside the actions arrays.
    // Easier path: read the runtime-loaded module via dynamic import.
    // But the file pulls in AntD + theme hooks at module init, which
    // requires a heavy jsdom setup. We approximate by counting
    // top-level `{ key:` markers inside each MODULES action array.
    // The source-level pin above is the canonical guarantee; this
    // arithmetic pin double-checks the operator-facing count.
    const moduleBlock = SRC.match(/const MODULES[\s\S]*?\n\]\n/m)
    expect(moduleBlock).toBeTruthy()
    const declared = moduleBlock![0]
    // Count occurrences of `{ key: '...'` inside the actions arrays —
    // the outer `key: 'devices'` style markers also match but appear
    // exactly once per module declaration (14 modules), so we
    // separately count those and subtract.
    const innerActionCount = (declared.match(/\{\s*key:\s*'(?!devices|config_backups|tasks|playbooks|topology|monitoring|ipam|audit_logs|reports|users|locations|agents|settings|driver_templates)/g) ?? []).length
    expect(innerActionCount).toBe(42)
  })
})
