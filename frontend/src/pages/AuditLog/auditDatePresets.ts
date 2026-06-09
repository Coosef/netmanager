import dayjs, { type Dayjs } from 'dayjs'

/**
 * Audit Log v2 PR 4 — Quick date preset utility.
 *
 * Pure helper — UI rendering YOK. 5 hızlı zaman aralığı + reverse detection.
 *
 * Strateji:
 *   - dateRange tek source-of-truth (parent state)
 *   - Preset tıklanınca `getPresetRange(preset)` ile yeni range üretilir,
 *     parent state'e set edilir
 *   - Mevcut range hangi preset'e ait olduğu reverse `detectActivePreset`
 *     ile her render'da hesaplanır (preset state TUTULMAZ — derivasyon)
 *   - Manuel RangePicker ile değişikliklerde `detectActivePreset` null
 *     döner → "Özel" highlight
 */

export type AuditDatePreset = '1h' | '24h' | '7d' | '30d' | 'custom'

/** Preset list — render order için */
export const AUDIT_DATE_PRESETS: ReadonlyArray<Exclude<AuditDatePreset, 'custom'>> = [
  '1h',
  '24h',
  '7d',
  '30d',
] as const

/**
 * Bir preset için aktif tarih aralığı üretir.
 * 'custom' → null (RangePicker'ın manuel modunu temsil eder).
 *
 * 'now' opsiyonel — test edilebilirlik için injection.
 */
export function getPresetRange(
  preset: AuditDatePreset,
  now?: Dayjs,
): [Dayjs, Dayjs] | null {
  if (preset === 'custom') return null
  const n = now ?? dayjs()
  switch (preset) {
    case '1h':
      return [n.subtract(1, 'hour'), n]
    case '24h':
      return [n.subtract(24, 'hour'), n]
    case '7d':
      return [n.subtract(7, 'day').startOf('day'), n]
    case '30d':
      return [n.subtract(30, 'day').startOf('day'), n]
  }
}

/**
 * Mevcut tarih aralığının hangi preset'e karşılık geldiğini bulur.
 *
 * Tolerance: ±2 dakika start'ta, ±2 dakika end'de (preset tıklandığı an
 * ile şu anki saat farkı doğal — '1 saat' presetinde 1 dakikalık fark
 * yine 'Son 1 saat' kabul edilir).
 *
 * Custom / null / manuel range → null döner. UI "Özel" highlight'ı için
 * kullanılır.
 */
export function detectActivePreset(
  range: [Dayjs | null, Dayjs | null] | null,
  now?: Dayjs,
  toleranceMinutes: number = 2,
): AuditDatePreset | null {
  if (!range || !range[0] || !range[1]) return null
  const [start, end] = range as [Dayjs, Dayjs]
  const n = now ?? dayjs()

  // end her preset'te 'now' civarındadır → tolerance check
  const endDiffMin = Math.abs(n.diff(end, 'minute'))
  if (endDiffMin > toleranceMinutes) return null

  // Her preset için ideal start'ı hesapla; tolerance içindeyse match
  for (const p of AUDIT_DATE_PRESETS) {
    const ideal = getPresetRange(p, n)
    if (!ideal) continue
    const startDiffMin = Math.abs(start.diff(ideal[0], 'minute'))
    if (startDiffMin <= toleranceMinutes) {
      return p
    }
  }

  return null
}

/**
 * Bir aktif filter setinden, kaç tanesinin aktif olduğunu sayar.
 * AuditFilterBar'ın "3 filtre temizlenecek" chip'i için.
 */
export type AuditActiveFilters = {
  search?: string
  actionFilter?: string
  ipFilter?: string
  resourceType?: string
  statusFilter?: string
  dateRange?: [Dayjs | null, Dayjs | null] | null
}

export function countActiveFilters(f: AuditActiveFilters): number {
  let n = 0
  if (f.search && f.search.trim()) n++
  if (f.actionFilter && f.actionFilter.trim()) n++
  if (f.ipFilter && f.ipFilter.trim()) n++
  if (f.resourceType) n++
  if (f.statusFilter) n++
  if (f.dateRange && (f.dateRange[0] || f.dateRange[1])) n++
  return n
}
