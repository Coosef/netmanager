/**
 * Audit Log v2 PR 2 — action → human-readable summary.
 *
 * Pure utility — UI rendering YOK; i18nKey + values dict döner, çağıran
 * <Trans> veya t() ile çözer. Bu sayede çeviri 4 dilde paralel çalışır.
 *
 * 12 yaygın action için spesifik formatter; bilinmeyenler kategori bazlı
 * fallback'e düşer. Hassas alanlar (token/password/key/secret) summary
 * çıktısında MASKELENİR — UI'da düz text olarak görünmez.
 */
import type { AuditLog } from '@/types'
import { getAuditActionCategory, type AuditActionCategory } from './auditActionCategory'

export type AuditSummaryTone = 'info' | 'success' | 'warning' | 'danger'

export type AuditSummary = {
  /** i18n key — caller t()/Trans ile çözer */
  i18nKey: string
  /** interpolation values */
  values: Record<string, string | number>
  /** UI ton ipucu (kart/alert rengi vs.) */
  tone: AuditSummaryTone
}

// ─── Sensitive field masking ─────────────────────────────────────────────────

/**
 * Hassas olabilecek alan adları — substring match. Bu alanlar formatter
 * değerlerinden ÇIKARILIR (UI'da yer almaz). Drawer'ın "Gelişmiş / Raw Data"
 * Collapse'ünde raw JSON gösterilirken yine maskeleme uygulanır.
 */
const SENSITIVE_FIELD_PATTERNS = [
  'password', 'pwd', 'passwd',
  'token', 'jwt', 'bearer',
  'secret', 'private_key', 'privatekey',
  'api_key', 'apikey',
  'session_key', 'sessionkey',
  'snmp_community',
  'enable_secret',
  'ssh_password', 'ssh_pass',
  'mfa_totp_secret', 'mfa_pending_secret',
  'recovery_code', 'recovery_codes',
  'auth', 'credential', 'credentials',
] as const

/**
 * Bir field adının hassas olup olmadığını kontrol eder.
 * Substring (lowercase) match — agresif ama güvenli.
 */
export function isSensitiveField(fieldName: string | null | undefined): boolean {
  if (!fieldName || typeof fieldName !== 'string') return false
  const lower = fieldName.toLowerCase()
  return SENSITIVE_FIELD_PATTERNS.some((p) => lower.includes(p))
}

/**
 * Bir değeri UI'da gösterilebilecek string'e çevirir. Hassas alanlar
 * gönderilirse '***' döndürür. Nested object/array için JSON özet (kısa).
 */
export function maskedDisplayValue(
  fieldName: string | null | undefined,
  value: unknown,
): string {
  if (isSensitiveField(fieldName)) return '***'
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    if (value.length === 0) return '—'
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Array / object → kısa JSON; uzun ise truncate
  try {
    const json = JSON.stringify(value)
    if (json.length > 100) return json.slice(0, 97) + '…'
    return json
  } catch {
    return '[object]'
  }
}

// ─── 12 yaygın action için spesifik formatter ───────────────────────────────

type Formatter = (record: AuditLog) => AuditSummary

const FORMATTERS: Record<string, Formatter> = {
  login: (r) => ({
    i18nKey: 'audit.summary.login',
    values: { user: r.username },
    tone: 'success',
  }),
  login_failed: (r) => ({
    i18nKey: 'audit.summary.login_failed',
    values: { user: r.username, ip: r.client_ip || '—' },
    tone: 'danger',
  }),
  logout: (r) => ({
    i18nKey: 'audit.summary.logout',
    values: { user: r.username },
    tone: 'info',
  }),
  mfa_enabled: (r) => ({
    i18nKey: 'audit.summary.mfa_enabled',
    values: { user: r.username },
    tone: 'success',
  }),
  mfa_disabled: (r) => ({
    i18nKey: 'audit.summary.mfa_disabled',
    values: { user: r.username },
    tone: 'warning',
  }),
  password_changed: (r) => ({
    i18nKey: 'audit.summary.password_changed',
    values: { user: r.username },
    tone: 'info',
  }),
  user_created: (r) => ({
    i18nKey: 'audit.summary.user_created',
    values: {
      actor: r.username,
      target: r.resource_name || r.resource_id || '—',
    },
    tone: 'success',
  }),
  user_updated: (r) => ({
    i18nKey: 'audit.summary.user_updated',
    values: {
      actor: r.username,
      target: r.resource_name || r.resource_id || '—',
      changes: countChangedFields(r),
    },
    tone: 'info',
  }),
  device_created: (r) => ({
    i18nKey: 'audit.summary.device_created',
    values: {
      actor: r.username,
      device: r.resource_name || r.resource_id || '—',
    },
    tone: 'success',
  }),
  device_updated: (r) => ({
    i18nKey: 'audit.summary.device_updated',
    values: {
      actor: r.username,
      device: r.resource_name || r.resource_id || '—',
      changes: countChangedFields(r),
    },
    tone: 'info',
  }),
  device_deleted: (r) => ({
    i18nKey: 'audit.summary.device_deleted',
    values: {
      actor: r.username,
      device: r.resource_name || r.resource_id || '—',
    },
    tone: 'warning',
  }),
  config_template_pushed: (r) => ({
    i18nKey: 'audit.summary.config_template_pushed',
    values: {
      actor: r.username,
      device: r.resource_name || r.resource_id || '—',
    },
    tone: 'info',
  }),
}

// ─── Fallback ───────────────────────────────────────────────────────────────

const CATEGORY_TONE: Record<AuditActionCategory, AuditSummaryTone> = {
  auth: 'info',
  create: 'success',
  update: 'info',
  delete: 'warning',
  approve: 'success',
  security: 'warning',
  neutral: 'info',
}

/**
 * Bilinmeyen action için kategori bazlı fallback. Çıktı her zaman
 * okunabilir bir cümle olur.
 */
function fallbackFormat(record: AuditLog): AuditSummary {
  const category = getAuditActionCategory(record.action)
  const tone: AuditSummaryTone =
    record.status === 'failure' ? 'danger' : CATEGORY_TONE[category]
  // i18nKey kategori bazlı; "actor tarafından action gerçekleştirildi" gibi
  return {
    i18nKey: `audit.summary.category.${category}`,
    values: {
      actor: record.username,
      action: record.action,
      target: record.resource_name || record.resource_id || record.resource_type || '—',
    },
    tone,
  }
}

/**
 * Bir audit log kaydı için human-readable summary üret.
 *
 * Çıktı: { i18nKey, values, tone } — caller t() veya <Trans i18nKey={...}
 * values={...}> ile DOM'a yerleştirir. Component formatting'i değişebilir
 * (renk vs.), tone ipucu ile yapılır.
 */
export function formatAuditAction(record: AuditLog | null | undefined): AuditSummary {
  if (!record || !record.action) {
    return {
      i18nKey: 'audit.summary.category.neutral',
      values: { actor: '—', action: '—', target: '—' },
      tone: 'info',
    }
  }
  const fn = FORMATTERS[record.action]
  if (fn) {
    const out = fn(record)
    // failure status genel danger ton'a düşer (formatter override değilse)
    if (record.status === 'failure' && out.tone !== 'danger') {
      return { ...out, tone: 'danger' }
    }
    return out
  }
  return fallbackFormat(record)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Before/After arasında değişen alan sayısını sayar.
 * AuditDiffViewer'ın `computeDiff` mantığıyla tutarlı olmalı.
 */
function countChangedFields(record: AuditLog): number {
  const before = (record.before_state ?? {}) as Record<string, unknown>
  const after = (record.after_state ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  let n = 0
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) n++
  }
  return n
}
