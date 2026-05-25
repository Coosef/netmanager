/**
 * NOC console UI logic — keyboard shortcuts + panel-visibility rules.
 *
 * Pure, framework-free, unit-testable. The page component (index.tsx)
 * owns the React state and DOM (fullscreen API, key listener) and routes
 * through these functions.
 */

export type ViewMode = '2d' | '3d'
export type LayoutMode3D = 'orbit' | 'cluster'

/** Collapsible floating panels. */
export type PanelId = 'controls' | 'intel' | 'detail' | 'legend'
export const PANEL_IDS: PanelId[] = ['controls', 'intel', 'detail', 'legend']

/** A keyboard shortcut resolves to exactly one of these intents. */
export type UiAction =
  | { kind: 'fullscreen' }
  | { kind: 'view'; view: ViewMode }
  | { kind: 'layout'; layout: LayoutMode3D }
  | { kind: 'incidentFocus' }
  | { kind: 'cycleIncident'; direction: 'next' | 'prev' }
  | { kind: 'clear' }

/**
 * Map a keyboard key to a NOC action. Returns null for unbound keys.
 *   F fullscreen · 2 2D · 3 3D · C cluster · O orbit · I incident focus
 *   N next anomaly (P prev) · Esc clear selection / exit
 */
export function keyboardAction(key: string): UiAction | null {
  switch (key.toLowerCase()) {
    case 'f': return { kind: 'fullscreen' }
    case '2': return { kind: 'view', view: '2d' }
    case '3': return { kind: 'view', view: '3d' }
    case 'c': return { kind: 'layout', layout: 'cluster' }
    case 'o': return { kind: 'layout', layout: 'orbit' }
    case 'i': return { kind: 'incidentFocus' }
    case 'n': return { kind: 'cycleIncident', direction: 'next' }
    case 'p': return { kind: 'cycleIncident', direction: 'prev' }
    case 'escape': return { kind: 'clear' }
    default: return null
  }
}

export interface PanelContext {
  /** True fullscreen (browser Fullscreen API) is active. */
  fullscreen: boolean
  /** NOC wall-screen presentation mode — minimal chrome. */
  presentation: boolean
  /** A node/incident is selected (the detail panel needs one). */
  hasSelection: boolean
}

/**
 * Hard visibility — whether a floating panel renders at all.
 *  - presentation mode hides every panel (wall-screen: canvas + status only)
 *  - fullscreen auto-collapses the non-essential legend
 *  - the detail panel requires a selection
 * Manual collapse is a separate, softer state (see `isPanelExpanded`).
 */
export function isPanelVisible(panel: PanelId, ctx: PanelContext): boolean {
  if (ctx.presentation) return false
  if (panel === 'detail' && !ctx.hasSelection) return false
  if (ctx.fullscreen && panel === 'legend') return false // auto-collapse
  return true
}

/** A visible panel is either expanded (full content) or collapsed to a pill. */
export function isPanelExpanded(panel: PanelId, collapsed: Set<PanelId>): boolean {
  return !collapsed.has(panel)
}

/** Toggle a panel's manual-collapse (expanded ⇄ pill), returning a new set. */
export function togglePanel(collapsed: Set<PanelId>, panel: PanelId): Set<PanelId> {
  const next = new Set(collapsed)
  if (next.has(panel)) next.delete(panel)
  else next.add(panel)
  return next
}
