/**
 * T10 C7.B — Device Detail Page sekme katalogu (tek kaynak).
 *
 * `key` = URL `?tab=` parametresinin değeri (derin link).
 * Sıra üretim sırasında korunur. C7.B'de overview + security live; diğerleri C7.C/D'de.
 */
export type TabKey =
  | 'overview' | 'ports' | 'security'
  | 'vlan' | 'mac' | 'poe' | 'events' | 'backup' | 'actions'

export interface TabSpec {
  key: TabKey
  label: string
  /** Bu sekme henüz placeholder mı (içerik C7.C/D'de gelecek). */
  placeholder?: boolean
}

export const DETAIL_TABS: TabSpec[] = [
  { key: 'overview', label: 'Genel' },
  { key: 'ports',    label: 'Portlar' }, // C7.C live
  { key: 'security', label: 'Güvenlik Politikası' },
  { key: 'vlan',     label: 'VLAN' }, // C7.D live
  { key: 'mac',      label: 'MAC Tablosu',       placeholder: true }, // C7.D
  { key: 'poe',      label: 'PoE',               placeholder: true }, // C7.D
  { key: 'events',   label: 'Olaylar',           placeholder: true }, // C7.D
  { key: 'backup',   label: 'Config Backup',     placeholder: true }, // C7.D
  { key: 'actions',  label: 'Aksiyonlar',        placeholder: true }, // C7.D
]

export const DEFAULT_TAB: TabKey = 'overview'

export function normalizeTab(raw: string | null | undefined): TabKey {
  if (!raw) return DEFAULT_TAB
  return (DETAIL_TABS.find((t) => t.key === raw)?.key ?? DEFAULT_TAB)
}
