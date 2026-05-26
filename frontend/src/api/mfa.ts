// MFA enrollment / management client. Login itself (challenge + verify)
// lives in api/auth.ts because the challenge token is returned by /auth/login.
import client from './client'
import type {
  MfaConfirmResponse,
  MfaEnrollResponse,
  MfaStatus,
} from '@/types'

export const mfaApi = {
  /** Read state for Settings UI's MFA card. */
  status: () =>
    client.get<MfaStatus>('/users/me/mfa/status').then((r) => r.data),

  /** Start TOTP enrollment — backend stashes pending_secret and returns
   *  it once for the frontend to render as a QR. Re-calling overwrites
   *  the pending secret (user scanned the wrong QR), which is intended. */
  enrollTotp: () =>
    client.post<MfaEnrollResponse>('/users/me/mfa/enroll/totp').then((r) => r.data),

  /** Verify the first code from the authenticator → enables MFA + mints
   *  recovery codes. The plaintext codes are returned ONCE; persist them
   *  to user-visible storage immediately. */
  confirm: (code: string) =>
    client.post<MfaConfirmResponse>('/users/me/mfa/confirm', { code }).then((r) => r.data),

  /** Turn MFA off. Requires the account password; the code (TOTP or
   *  recovery) is optional but strongly recommended — the Settings page
   *  always sends one. */
  disable: (password: string, code?: string) =>
    client.post<{ mfa_enabled: false }>('/users/me/mfa/disable',
      { password, ...(code ? { code } : {}) }).then((r) => r.data),

  /** Roll the recovery codes — old ones become invalid. Requires a
   *  current TOTP so a hijacked tab can't rotate the user's fallbacks. */
  regenerateRecoveryCodes: (code: string) =>
    client.post<MfaConfirmResponse>('/users/me/mfa/recovery-codes/regenerate',
      { code }).then((r) => r.data),

  // T9 Tur 2 #2b — Email kanalı
  /** Email kanalına OTP yolla (enrollment). Kullanıcı emailini alır →
   *  confirmEmail() ile doğrular. */
  enrollEmail: () =>
    client.post<{ ok: boolean; email_masked: string; ttl_sec: number }>(
      '/users/me/mfa/enroll/email', {},
    ).then((r) => r.data),

  /** Enrollment kodunu doğrula → mfa_methods'a 'email' eklenir.
   *  İlk MFA kanalı email ise recovery codes mint edilir + döner. */
  confirmEmail: (code: string) =>
    client.post<{ mfa_enabled: boolean; methods: string[]; recovery_codes?: string[] }>(
      '/users/me/mfa/confirm-email', { code },
    ).then((r) => r.data),

  /** Email method'unu kaldır (son MFA değilse). Son ise /disable kullan. */
  removeEmail: () =>
    client.delete<{ removed: boolean; methods?: string[]; note?: string }>(
      '/users/me/mfa/methods/email',
    ).then((r) => r.data),
}
