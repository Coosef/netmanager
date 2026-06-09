/**
 * Audit Log v2 PR 1 — Action → kategori mapping.
 *
 * Backend `audit_logs.action` free-text bir alandır (50+ distinct değer
 * prod'da). UI'da bunları 6 anlamsal kategoriye + neutral fallback'e
 * gruplayarak görsel ayrım sağlıyoruz. Strateji:
 *   1. Exact match — yaygın action'lar için (en güvenli, kontrol edilen
 *      değerler)
 *   2. Suffix/prefix pattern fallback — uzun kuyruk action'ları (yeni
 *      backend action eklendiğinde otomatik kategorize edilir)
 *   3. Bilinmeyen → 'neutral'
 *
 * Kategoriler:
 *   auth     — oturum açma/kapama, MFA, davet, şifre değişimi
 *   create   — _created, _started gibi yeni kayıt
 *   update   — _updated, _saved, _assigned, _pushed gibi değişim
 *   delete   — _deleted, _archived
 *   approve  — onay/red iş akışı (approve, reject, review)
 *   security — güvenlik ihlali tespit/izleme (blocked, audit_run)
 *   neutral  — kategorize edilemeyen (fallback)
 */

export type AuditActionCategory =
  | 'auth'
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'security'
  | 'neutral'

// Exact match map — production audit_logs tablosundaki distinct action'lar
const EXACT_MAP: Record<string, AuditActionCategory> = {
  // auth
  login: 'auth',
  login_failed: 'auth',
  login_mfa_challenge: 'auth',
  login_mfa_success: 'auth',
  logout: 'auth',
  password_changed: 'auth',
  password_reset: 'auth',
  mfa_enabled: 'auth',
  mfa_disabled: 'auth',
  mfa_enroll_started: 'auth',
  mfa_verify_failed: 'auth',
  mfa_confirm_failed: 'auth',
  invite_accepted: 'auth',
  invite_created: 'auth',
  user_created: 'auth',
  user_deleted: 'delete',
  user_role_changed: 'update',

  // security
  login_blocked_ip: 'security',
  security_audit_run: 'security',
  permission_denied: 'security',
  permission_changed: 'security',

  // approve
  approval_requested: 'approve',
  approval_approved: 'approve',
  approval_rejected: 'approve',
  approval_review: 'approve',
  change_approved: 'approve',
  change_rejected: 'approve',

  // CLI/manual command — interaktif aksiyon
  cli_command: 'update',
}

// Suffix pattern fallback — uzun kuyruk için
// Sıralama önemli: spesifik suffix'ler önce gelmeli
const SUFFIX_PATTERNS: ReadonlyArray<{ suffix: string; category: AuditActionCategory }> = [
  // delete pattern'leri önce (archive/delete fallback için)
  { suffix: '_deleted', category: 'delete' },
  { suffix: '_archived', category: 'delete' },
  { suffix: '_removed', category: 'delete' },

  // approve pattern'leri
  { suffix: '_approved', category: 'approve' },
  { suffix: '_rejected', category: 'approve' },
  { suffix: '_requested', category: 'approve' },
  { suffix: '_review', category: 'approve' },

  // create pattern'leri
  { suffix: '_created', category: 'create' },
  { suffix: '_discovered', category: 'create' },
  { suffix: '_started', category: 'create' },
  { suffix: '_taken', category: 'create' },
  { suffix: '_triggered', category: 'create' },

  // update pattern'leri (en uzun kuyruk)
  { suffix: '_updated', category: 'update' },
  { suffix: '_saved', category: 'update' },
  { suffix: '_assigned', category: 'update' },
  { suffix: '_changed', category: 'update' },
  { suffix: '_pushed', category: 'update' },
  { suffix: '_rotated', category: 'update' },
  { suffix: '_confirmed', category: 'update' },
  { suffix: '_fetched', category: 'update' },
  { suffix: '_collected', category: 'update' },
  { suffix: '_run', category: 'update' },
  { suffix: '_check', category: 'update' },
  { suffix: '_completed', category: 'update' },
  { suffix: '_tested', category: 'update' },
  { suffix: '_set', category: 'update' },
  { suffix: '_queued', category: 'update' },
]

// Prefix pattern fallback (suffix yetersizse)
const PREFIX_PATTERNS: ReadonlyArray<{ prefix: string; category: AuditActionCategory }> = [
  { prefix: 'login_', category: 'auth' },
  { prefix: 'logout_', category: 'auth' },
  { prefix: 'password_', category: 'auth' },
  { prefix: 'mfa_', category: 'auth' },
  { prefix: 'invite_', category: 'auth' },
  { prefix: 'permission_', category: 'security' },
  { prefix: 'security_', category: 'security' },
  { prefix: 'approval_', category: 'approve' },
]

/**
 * Action string'ini 6 anlamsal kategoriden birine map'ler.
 * Bilinmeyen action her zaman 'neutral' döner — fail-safe.
 */
export function getAuditActionCategory(action: string | null | undefined): AuditActionCategory {
  if (!action || typeof action !== 'string') return 'neutral'
  const a = action.trim().toLowerCase()
  if (!a) return 'neutral'

  // 1. Exact match
  if (EXACT_MAP[a]) return EXACT_MAP[a]

  // 2. Suffix patterns (uzun match önce — sıralı array)
  for (const { suffix, category } of SUFFIX_PATTERNS) {
    if (a.endsWith(suffix)) return category
  }

  // 3. Prefix patterns
  for (const { prefix, category } of PREFIX_PATTERNS) {
    if (a.startsWith(prefix)) return category
  }

  // 4. Fallback
  return 'neutral'
}
