/**
 * Audit Log v2 PR 1 — auditActionCategory mapping testleri.
 *
 * Hedef: 50+ prod action'unun doğru kategoriye düştüğünü ve bilinmeyen
 * action'ların her zaman 'neutral' fallback'e indiğini sabitlemek.
 */
import { describe, it, expect } from 'vitest'
import {
  getAuditActionCategory,
  type AuditActionCategory,
} from '../auditActionCategory'

describe('getAuditActionCategory — exact match (yaygın action\'lar)', () => {
  it.each<[string, AuditActionCategory]>([
    ['login', 'auth'],
    ['login_failed', 'auth'],
    ['login_mfa_challenge', 'auth'],
    ['login_mfa_success', 'auth'],
    ['password_changed', 'auth'],
    ['password_reset', 'auth'],
    ['mfa_enabled', 'auth'],
    ['mfa_enroll_started', 'auth'],
    ['mfa_verify_failed', 'auth'],
    ['invite_accepted', 'auth'],
    ['invite_created', 'auth'],
    ['user_created', 'auth'],
    ['user_deleted', 'delete'],
    ['user_role_changed', 'update'],

    ['login_blocked_ip', 'security'],
    ['security_audit_run', 'security'],
    ['permission_denied', 'security'],
    ['permission_changed', 'security'],

    ['approval_requested', 'approve'],
    ['approval_approved', 'approve'],
    ['approval_rejected', 'approve'],
    ['change_approved', 'approve'],

    ['cli_command', 'update'],
  ])('%s → %s', (action, expected) => {
    expect(getAuditActionCategory(action)).toBe(expected)
  })
})

describe('getAuditActionCategory — suffix pattern fallback', () => {
  it.each<[string, AuditActionCategory]>([
    // delete
    ['device_deleted', 'delete'],
    ['device_archived', 'delete'],
    ['agent_archived', 'delete'],
    ['something_removed', 'delete'],

    // approve
    ['change_approved', 'approve'],
    ['workflow_rejected', 'approve'],

    // create
    ['device_created', 'create'],
    ['ghost_device_discovered', 'create'],
    ['hop_discovery_started', 'create'],
    ['config_backup_taken', 'create'],
    ['ipam_arp_sync_triggered', 'create'],

    // update
    ['device_updated', 'update'],
    ['snmp_settings_saved', 'update'],
    ['interface_vlan_assigned', 'update'],
    ['agent_key_rotated', 'update'],
    ['device_reachability_confirmed', 'update'],
    ['device_info_fetched', 'update'],
    ['mac_arp_collected', 'update'],
    ['eol_lookup_run', 'update'],
    ['config_policy_check', 'update'],
    ['ipam_scan_completed', 'update'],
    ['device_tested', 'update'],
    ['golden_config_set', 'update'],
    ['bulk_backup_queued', 'update'],
    ['config_template_pushed', 'update'],
  ])('%s → %s (suffix pattern)', (action, expected) => {
    expect(getAuditActionCategory(action)).toBe(expected)
  })
})

describe('getAuditActionCategory — prefix pattern fallback', () => {
  it('login_* prefix → auth', () => {
    expect(getAuditActionCategory('login_attempt_logged')).toBe('auth')
  })
  it('mfa_* prefix → auth', () => {
    expect(getAuditActionCategory('mfa_custom_xyz')).toBe('auth')
  })
  it('security_* prefix → security', () => {
    expect(getAuditActionCategory('security_alert_raised')).toBe('security')
  })
  it('approval_* prefix → approve', () => {
    expect(getAuditActionCategory('approval_custom_action')).toBe('approve')
  })
})

describe('getAuditActionCategory — neutral fallback (defansif)', () => {
  it('boş string → neutral', () => {
    expect(getAuditActionCategory('')).toBe('neutral')
  })
  it('null → neutral', () => {
    expect(getAuditActionCategory(null)).toBe('neutral')
  })
  it('undefined → neutral', () => {
    expect(getAuditActionCategory(undefined)).toBe('neutral')
  })
  it('bilinmeyen action → neutral', () => {
    expect(getAuditActionCategory('totally_unknown_random_action')).toBe('neutral')
  })
  it('sadece whitespace → neutral', () => {
    expect(getAuditActionCategory('   ')).toBe('neutral')
  })
  it('non-string input → neutral (defansif)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getAuditActionCategory(123 as any)).toBe('neutral')
  })
})

describe('getAuditActionCategory — case-insensitive', () => {
  it('UPPER CASE login → auth', () => {
    expect(getAuditActionCategory('LOGIN')).toBe('auth')
  })
  it('Mixed Case Device_Created → create', () => {
    expect(getAuditActionCategory('Device_Created')).toBe('create')
  })
  it('whitespace trim', () => {
    expect(getAuditActionCategory('  login  ')).toBe('auth')
  })
})
