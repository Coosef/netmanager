import { describe, it, expect } from 'vitest'
import {
  keyboardAction, isPanelVisible, isPanelExpanded, togglePanel, type PanelId,
} from '../noc/nocUi'
import { loadUiPrefs, saveUiPrefs } from '../noc/uiPrefs'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  } as Storage
}

// ── keyboard shortcuts ──────────────────────────────────────────────────────
describe('keyboardAction', () => {
  it('maps every NOC shortcut', () => {
    expect(keyboardAction('f')).toEqual({ kind: 'fullscreen' })
    expect(keyboardAction('2')).toEqual({ kind: 'view', view: '2d' })
    expect(keyboardAction('3')).toEqual({ kind: 'view', view: '3d' })
    expect(keyboardAction('c')).toEqual({ kind: 'layout', layout: 'cluster' })
    expect(keyboardAction('o')).toEqual({ kind: 'layout', layout: 'orbit' })
    expect(keyboardAction('i')).toEqual({ kind: 'incidentFocus' })
    expect(keyboardAction('n')).toEqual({ kind: 'cycleIncident', direction: 'next' })
    expect(keyboardAction('p')).toEqual({ kind: 'cycleIncident', direction: 'prev' })
    expect(keyboardAction('Escape')).toEqual({ kind: 'clear' })
  })
  it('is case-insensitive', () => {
    expect(keyboardAction('F')).toEqual({ kind: 'fullscreen' })
    expect(keyboardAction('C')).toEqual({ kind: 'layout', layout: 'cluster' })
    expect(keyboardAction('N')).toEqual({ kind: 'cycleIncident', direction: 'next' })
  })
  it('returns null for an unbound key', () => {
    expect(keyboardAction('x')).toBeNull()
    expect(keyboardAction('Enter')).toBeNull()
  })
})

// ── panel visibility (fullscreen / presentation / selection) ────────────────
describe('isPanelVisible', () => {
  const base = { fullscreen: false, presentation: false, hasSelection: false }

  it('shows controls / intel / legend by default', () => {
    for (const p of ['controls', 'intel', 'legend'] as PanelId[]) {
      expect(isPanelVisible(p, base)).toBe(true)
    }
  })
  it('detail panel requires a selection', () => {
    expect(isPanelVisible('detail', base)).toBe(false)
    expect(isPanelVisible('detail', { ...base, hasSelection: true })).toBe(true)
  })
  it('fullscreen auto-collapses the legend only', () => {
    const fs = { ...base, fullscreen: true }
    expect(isPanelVisible('legend', fs)).toBe(false)
    expect(isPanelVisible('controls', fs)).toBe(true)
  })
  it('presentation mode hides every panel (wall-screen)', () => {
    const pres = { ...base, presentation: true, hasSelection: true }
    for (const p of ['controls', 'intel', 'detail', 'legend'] as PanelId[]) {
      expect(isPanelVisible(p, pres)).toBe(false)
    }
  })
})

// ── panel collapse ──────────────────────────────────────────────────────────
describe('panel collapse', () => {
  it('togglePanel flips a panel and isPanelExpanded reflects it', () => {
    let collapsed = new Set<PanelId>()
    expect(isPanelExpanded('controls', collapsed)).toBe(true)
    collapsed = togglePanel(collapsed, 'controls')
    expect(isPanelExpanded('controls', collapsed)).toBe(false)
    collapsed = togglePanel(collapsed, 'controls')
    expect(isPanelExpanded('controls', collapsed)).toBe(true)
  })
  it('togglePanel returns a new set (immutable)', () => {
    const a = new Set<PanelId>()
    const b = togglePanel(a, 'intel')
    expect(b).not.toBe(a)
    expect(a.size).toBe(0)
  })
})

// ── preference persistence ──────────────────────────────────────────────────
describe('uiPrefs', () => {
  it('round-trips view / layout / overlay layers', () => {
    const s = fakeStorage()
    saveUiPrefs({ viewMode: '3d', layoutMode: 'cluster', overlayLayers: ['threats', 'ghosts'] }, s)
    const loaded = loadUiPrefs(s)
    expect(loaded.viewMode).toBe('3d')
    expect(loaded.layoutMode).toBe('cluster')
    expect(loaded.overlayLayers).toEqual(['threats', 'ghosts'])
  })
  it('returns an empty object when nothing is stored', () => {
    expect(loadUiPrefs(fakeStorage())).toEqual({})
  })
  it('ignores corrupt / invalid stored values', () => {
    const s = fakeStorage()
    s.setItem('nm-topology-noc-prefs', '{not json')
    expect(loadUiPrefs(s)).toEqual({})
    s.setItem('nm-topology-noc-prefs', JSON.stringify({ viewMode: 'hologram' }))
    expect(loadUiPrefs(s).viewMode).toBeUndefined()
  })
  it('persistence is not location-scoped — survives a location switch', () => {
    // prefs are keyed by a constant, never by org/location
    const s = fakeStorage()
    saveUiPrefs({ viewMode: '3d', layoutMode: 'orbit', overlayLayers: ['threats'] }, s)
    // a location switch changes the graph, not storage — prefs still load
    expect(loadUiPrefs(s).viewMode).toBe('3d')
    expect(s.length).toBe(1)
  })
})
