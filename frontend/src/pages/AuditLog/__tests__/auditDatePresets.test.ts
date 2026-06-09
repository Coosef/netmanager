/**
 * Audit Log v2 PR 4 — auditDatePresets testleri.
 *
 * 4 quick preset + custom + detectActivePreset reverse + countActiveFilters.
 */
import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import {
  getPresetRange,
  detectActivePreset,
  countActiveFilters,
  AUDIT_DATE_PRESETS,
} from '../auditDatePresets'

const FIXED_NOW = dayjs('2026-06-09T12:00:00Z')

describe('getPresetRange — 4 preset + custom', () => {
  it('1h → [now-1h, now]', () => {
    const r = getPresetRange('1h', FIXED_NOW)
    expect(r).not.toBeNull()
    expect(r![1].isSame(FIXED_NOW)).toBe(true)
    expect(FIXED_NOW.diff(r![0], 'minute')).toBe(60)
  })

  it('24h → [now-24h, now]', () => {
    const r = getPresetRange('24h', FIXED_NOW)
    expect(r![1].isSame(FIXED_NOW)).toBe(true)
    expect(FIXED_NOW.diff(r![0], 'hour')).toBe(24)
  })

  it('7d → [now-7d.startOfDay, now]', () => {
    const r = getPresetRange('7d', FIXED_NOW)
    expect(r![1].isSame(FIXED_NOW)).toBe(true)
    // 7 gün önce startOf('day') — 00:00:00
    expect(r![0].hour()).toBe(0)
    expect(r![0].minute()).toBe(0)
    expect(FIXED_NOW.diff(r![0], 'day')).toBeGreaterThanOrEqual(7)
  })

  it('30d → [now-30d.startOfDay, now]', () => {
    const r = getPresetRange('30d', FIXED_NOW)
    expect(r![1].isSame(FIXED_NOW)).toBe(true)
    expect(r![0].hour()).toBe(0)
    expect(FIXED_NOW.diff(r![0], 'day')).toBeGreaterThanOrEqual(30)
  })

  it('custom → null (RangePicker manuel mod)', () => {
    expect(getPresetRange('custom', FIXED_NOW)).toBeNull()
  })

  it('AUDIT_DATE_PRESETS dizisi 1h/24h/7d/30d içerir, custom YOK', () => {
    expect(AUDIT_DATE_PRESETS).toEqual(['1h', '24h', '7d', '30d'])
    expect(AUDIT_DATE_PRESETS).not.toContain('custom')
  })
})

describe('detectActivePreset — reverse detection', () => {
  it('1h preset range → "1h"', () => {
    const r = getPresetRange('1h', FIXED_NOW)
    expect(detectActivePreset(r, FIXED_NOW)).toBe('1h')
  })

  it('24h preset range → "24h"', () => {
    const r = getPresetRange('24h', FIXED_NOW)
    expect(detectActivePreset(r, FIXED_NOW)).toBe('24h')
  })

  it('7d preset range → "7d"', () => {
    const r = getPresetRange('7d', FIXED_NOW)
    expect(detectActivePreset(r, FIXED_NOW)).toBe('7d')
  })

  it('30d preset range → "30d"', () => {
    const r = getPresetRange('30d', FIXED_NOW)
    expect(detectActivePreset(r, FIXED_NOW)).toBe('30d')
  })

  it('tolerance ±2 min içinde → match', () => {
    // 1h preset range; start 1 dakika geriye kaydırılır → hala "1h"
    const r = getPresetRange('1h', FIXED_NOW)!
    const shifted: [dayjs.Dayjs, dayjs.Dayjs] = [
      r[0].subtract(1, 'minute'),
      r[1],
    ]
    expect(detectActivePreset(shifted, FIXED_NOW)).toBe('1h')
  })

  it('tolerance dışı manuel range → null ("Özel")', () => {
    // 5 saat geriye kaydır — hiçbir preset'e uymaz
    const start = FIXED_NOW.subtract(5, 'hour')
    expect(detectActivePreset([start, FIXED_NOW], FIXED_NOW)).toBeNull()
  })

  it('null range → null', () => {
    expect(detectActivePreset(null, FIXED_NOW)).toBeNull()
  })

  it('range[0] veya range[1] null → null', () => {
    expect(detectActivePreset([null, FIXED_NOW], FIXED_NOW)).toBeNull()
    expect(detectActivePreset([FIXED_NOW.subtract(1, 'hour'), null], FIXED_NOW)).toBeNull()
  })

  it('end "now" değil → null', () => {
    const r = getPresetRange('1h', FIXED_NOW)!
    // end 1 saat geriye kaydır → preset değil
    expect(detectActivePreset([r[0], r[1].subtract(1, 'hour')], FIXED_NOW)).toBeNull()
  })

  it('custom range manuel girişle preset highlight göstermez', () => {
    // Tam 2 saatlik aralık — herhangi bir preset değil
    const start = FIXED_NOW.subtract(2, 'hour').subtract(30, 'minute')
    expect(detectActivePreset([start, FIXED_NOW], FIXED_NOW)).toBeNull()
  })
})

describe('countActiveFilters', () => {
  it('hiçbir filter yok → 0', () => {
    expect(countActiveFilters({})).toBe(0)
  })

  it('search dolu → 1', () => {
    expect(countActiveFilters({ search: 'admin' })).toBe(1)
  })

  it('search boş string → 0', () => {
    expect(countActiveFilters({ search: '' })).toBe(0)
  })

  it('search sadece whitespace → 0', () => {
    expect(countActiveFilters({ search: '   ' })).toBe(0)
  })

  it('6 filter hepsi dolu → 6', () => {
    expect(countActiveFilters({
      search: 'admin',
      actionFilter: 'login',
      ipFilter: '1.2.3.4',
      resourceType: 'device',
      statusFilter: 'success',
      dateRange: [FIXED_NOW.subtract(1, 'hour'), FIXED_NOW],
    })).toBe(6)
  })

  it('dateRange null → sayılmaz', () => {
    expect(countActiveFilters({ dateRange: null })).toBe(0)
  })

  it('dateRange tek taraflı (sadece start) → 1', () => {
    expect(countActiveFilters({ dateRange: [FIXED_NOW, null] })).toBe(1)
  })

  it('resourceType undefined → sayılmaz', () => {
    expect(countActiveFilters({ resourceType: undefined })).toBe(0)
  })
})
