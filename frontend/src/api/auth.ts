import client from './client'
import type { LoginResult, TokenResponse, User, Permissions } from '@/types'

export const authApi = {
  /** Login may return EITHER a real TokenResponse (no MFA) OR an
   *  MfaChallengeResponse (caller must complete via verifyMfa). Callers
   *  should narrow with `'mfa_required' in res`. */
  login: (username: string, password: string) =>
    client.post<LoginResult>('/auth/login', { username, password }).then((r) => r.data),

  /** Trade an MFA challenge_token + OTP (or recovery code) for a real
   *  session. `method` defaults to 'totp'; pass 'recovery' for a code
   *  from the user's recovery list. */
  verifyMfa: (challenge_token: string, code: string, method: 'totp' | 'recovery' = 'totp') =>
    client
      .post<TokenResponse>('/auth/mfa/verify', { challenge_token, code, method })
      .then((r) => r.data),

  me: () => client.get<User>('/auth/me').then((r) => r.data),

  myPermissions: () =>
    client.get<{ permissions: Permissions; system_role: string }>('/auth/me/permissions').then((r) => r.data),

  acceptInvite: (payload: {
    token: string
    username: string
    password: string
    full_name?: string
  }) =>
    client.post<TokenResponse>('/auth/invite/accept', payload).then((r) => r.data),

  /** T8.4 — server-side session revoke. Client localStorage'ı her
   *  halükarda temizler; backend ek olarak jti'yi user_sessions tablosunda
   *  revoked_at=now olarak işaretler → diğer tab'larda da invalid. */
  logout: () => client.post('/auth/logout').catch(() => null),
}
