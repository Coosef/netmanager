/**
 * NOC console preference persistence.
 *
 * The operator's engine / overlay setup survives a reload and — being
 * UI-only — survives a location switch unchanged (the graph resets, the
 * console layout does not). No org/location data here, so nothing
 * tenant-scoped is persisted.
 */
import type { ViewMode, LayoutMode3D } from './nocUi'
import type { OverlayLayer } from '../overlays/overlayModel'

const KEY = 'nm-topology-noc-prefs'

export interface UiPrefs {
  viewMode: ViewMode
  layoutMode: LayoutMode3D
  overlayLayers: OverlayLayer[]
  /** T4.3 wall-screen / presentation default for the kiosk/NOC display.
   *  When true, the page enters presentation+fullscreen on mount; chrome
   *  is hidden and the status bar dims after idle. Overridden by the
   *  `?wall=1` URL parameter when present. */
  wallMode?: boolean
}

function storage(explicit?: Storage): Storage | null {
  if (explicit) return explicit
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // privacy mode / disabled storage
  }
}

/** Load persisted console prefs — partial + defensive. */
export function loadUiPrefs(explicit?: Storage): Partial<UiPrefs> {
  const s = storage(explicit)
  if (!s) return {}
  try {
    const raw = s.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const out: Partial<UiPrefs> = {}
    if (parsed.viewMode === '2d' || parsed.viewMode === '3d') out.viewMode = parsed.viewMode
    if (parsed.layoutMode === 'orbit' || parsed.layoutMode === 'cluster') {
      out.layoutMode = parsed.layoutMode
    }
    if (Array.isArray(parsed.overlayLayers)) {
      out.overlayLayers = parsed.overlayLayers.filter((l: unknown) => typeof l === 'string')
    }
    if (typeof parsed.wallMode === 'boolean') out.wallMode = parsed.wallMode
    return out
  } catch {
    return {}
  }
}

/** Persist console prefs — never throws. */
export function saveUiPrefs(prefs: UiPrefs, explicit?: Storage): void {
  const s = storage(explicit)
  if (!s) return
  try {
    s.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* storage full / disabled — non-fatal */
  }
}
