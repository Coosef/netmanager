/**
 * i18n agents.windows_hint consistency guard.
 *
 * The Windows manual command UI is gone (PR #80, post-CI review #2).
 * Each locale's `agents.windows_hint` must reflect the new
 * "download and run" behaviour -- no "paste", "yapıştır" or similar
 * legacy phrasing that would refer to the removed command box.
 *
 * Also asserts that `agents.linux_download_failed` exists in all
 * four locales and is distinct from the Windows equivalent so the
 * Linux failure path can show a Linux-specific message.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const LOCALES = ['tr', 'en', 'de', 'ru'] as const

function loadAgents(lang: string): Record<string, string> {
  const p = resolve(__dirname, `../../../i18n/locales/${lang}.json`)
  const raw = JSON.parse(readFileSync(p, 'utf-8'))
  return (raw.agents ?? {}) as Record<string, string>
}

describe('agents.windows_hint -- consistent with download-only UI', () => {
  for (const lang of LOCALES) {
    it(`[${lang}] does not mention paste / yapıştır / einfügen / вставьте`, () => {
      const hint = loadAgents(lang).windows_hint
      expect(hint).toBeTruthy()
      const FORBIDDEN = [
        // English
        'paste', 'Paste', 'PASTE',
        // Turkish (case + suffix variations -- yapıştır is the root)
        'yapıştır', 'Yapıştır', 'YAPIŞTIR',
        'yapistir', 'Yapistir',
        // German
        'einfüg', 'Einfüg', 'EINFÜG',
        // Russian
        'вставь', 'Встав', 'ВСТАВ',
      ]
      for (const word of FORBIDDEN) {
        expect(hint).not.toContain(word)
      }
    })

    it(`[${lang}] mentions Windows installer + download semantics`, () => {
      const hint = loadAgents(lang).windows_hint
      // At least ONE of these "download"-flavoured tokens must appear
      // in the locale's natural phrasing. We list per locale rather
      // than a single regex so each locale's choice is explicit.
      const DOWNLOAD_TOKENS: Record<string, string[]> = {
        tr: ['indir', 'İndir'],
        en: ['Download', 'download'],
        de: ['herunter', 'Herunter'],
        ru: ['скач', 'Скач'],
      }
      const hits = DOWNLOAD_TOKENS[lang].filter((tok) => hint.includes(tok))
      expect(hits.length).toBeGreaterThan(0)
    })

    it(`[${lang}] does NOT reference the removed PowerShell window phrasing`, () => {
      const hint = loadAgents(lang).windows_hint
      const LEGACY = [
        'PowerShell (Yönetici) penceresine',
        'into an elevated PowerShell window',
        'PowerShell (Administrator)',
        'PowerShell-Fenster',
      ]
      for (const phrase of LEGACY) {
        expect(hint).not.toContain(phrase)
      }
    })
  }
})


describe('agents.linux_download_failed -- distinct from Windows messages', () => {
  for (const lang of LOCALES) {
    it(`[${lang}] linux_download_failed exists`, () => {
      const a = loadAgents(lang)
      expect(typeof a.linux_download_failed).toBe('string')
      expect((a.linux_download_failed ?? '').length).toBeGreaterThan(0)
    })

    it(`[${lang}] linux_download_failed differs from windows_download_failed`, () => {
      const a = loadAgents(lang)
      expect(a.linux_download_failed).not.toBe(a.windows_download_failed)
    })

    it(`[${lang}] linux_download_failed does NOT mention Windows`, () => {
      const a = loadAgents(lang)
      const v = (a.linux_download_failed ?? '').toLowerCase()
      expect(v).not.toContain('windows')
    })
  }
})


describe('agents.windows_download_primary_hint -- consolidated away', () => {
  for (const lang of LOCALES) {
    it(`[${lang}] secondary hint key removed (single authoritative hint)`, () => {
      const a = loadAgents(lang)
      expect(a.windows_download_primary_hint).toBeUndefined()
    })
  }
})


// ────────────────────────────────────────────────────────────────
// WINDOWS_AGENT_DEVELOPMENT_PAUSED: the three new "coming soon"
// keys (badge, message, tooltip) must exist in every locale, be
// non-empty, and be DISTINCT from the legacy windows_hint /
// windows_download_failed keys so a future change to one set does
// not silently drift the other.
// ────────────────────────────────────────────────────────────────


describe('agents.windows_coming_soon_* -- present and consistent across locales', () => {
  const KEYS = [
    'windows_coming_soon_badge',
    'windows_coming_soon_message',
    'windows_coming_soon_tooltip',
  ] as const

  for (const lang of LOCALES) {
    for (const key of KEYS) {
      it(`[${lang}] ${key} is a non-empty string`, () => {
        const a = loadAgents(lang)
        expect(typeof a[key]).toBe('string')
        expect((a[key] ?? '').length).toBeGreaterThan(0)
      })
    }

    it(`[${lang}] coming-soon keys do NOT collide with legacy windows_hint`, () => {
      const a = loadAgents(lang)
      // The pause copy must differ from the old "download and run"
      // hint -- otherwise the locale change would be a silent
      // identity edit.
      expect(a.windows_coming_soon_message).not.toBe(a.windows_hint)
      expect(a.windows_coming_soon_tooltip).not.toBe(a.windows_hint)
    })

    it(`[${lang}] coming-soon message does NOT echo download_failed copy`, () => {
      const a = loadAgents(lang)
      expect(a.windows_coming_soon_message).not.toBe(a.windows_download_failed)
      expect(a.windows_coming_soon_message).not.toBe(a.windows_validation_failed)
    })

    it(`[${lang}] badge is a short label (<= 32 chars), tooltip is concise (<= 64 chars)`, () => {
      const a = loadAgents(lang)
      expect((a.windows_coming_soon_badge ?? '').length).toBeLessThanOrEqual(32)
      expect((a.windows_coming_soon_tooltip ?? '').length).toBeLessThanOrEqual(64)
    })
  }

  it('badge strings differ across locales (no accidental English fallback)', () => {
    // Each locale picked a deliberate translation of "coming soon".
    // If two non-en locales accidentally inherited the en string,
    // this collapses and the test would flag it.
    const tr = loadAgents('tr').windows_coming_soon_badge
    const en = loadAgents('en').windows_coming_soon_badge
    const de = loadAgents('de').windows_coming_soon_badge
    const ru = loadAgents('ru').windows_coming_soon_badge
    expect(tr).not.toBe(en)
    expect(de).not.toBe(en)
    expect(ru).not.toBe(en)
  })
})
