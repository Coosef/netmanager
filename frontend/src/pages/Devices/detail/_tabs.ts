/**
 * T10 C7.B — Device Detail Page sekme katalogu (tek kaynak).
 *
 * `key` = URL `?tab=` parametresinin değeri (derin link).
 * Sıra üretim sırasında korunur. C7.B'de overview + security live; diğerleri C7.C/D'de.
 */
export type TabKey =
  | 'overview' | 'ports' | 'security'
  | 'vlan' | 'mac' | 'poe' | 'events' | 'backup' | 'actions' | 'terminal'

export interface TabSpec {
  key: TabKey
  /** i18n key — UI'da t(labelKey) ile çevrilir. Module-level literal
   *  bırakılmaz (KURAL-E1 — render-time çözümleme). */
  labelKey: string
  /** Bu sekme henüz placeholder mı (içerik C7.C/D'de gelecek). */
  placeholder?: boolean
}

export const DETAIL_TABS: TabSpec[] = [
  { key: 'overview', labelKey: 'devices.detail.tabs.overview' },
  { key: 'ports',    labelKey: 'devices.detail.tabs.ports' },
  { key: 'security', labelKey: 'devices.detail.tabs.security' },
  { key: 'vlan',     labelKey: 'devices.detail.tabs.vlan' },
  { key: 'mac',      labelKey: 'devices.detail.tabs.mac' },
  { key: 'poe',      labelKey: 'devices.detail.tabs.poe' },
  { key: 'events',   labelKey: 'devices.detail.tabs.events' },
  { key: 'backup',   labelKey: 'devices.detail.tabs.backup' },
  { key: 'actions',  labelKey: 'devices.detail.tabs.actions' },
  { key: 'terminal', labelKey: 'devices.detail.tabs.terminal' },
]

export const DEFAULT_TAB: TabKey = 'overview'

export function normalizeTab(raw: string | null | undefined): TabKey {
  if (!raw) return DEFAULT_TAB
  return (DETAIL_TABS.find((t) => t.key === raw)?.key ?? DEFAULT_TAB)
}
