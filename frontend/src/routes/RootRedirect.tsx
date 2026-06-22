import { Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'
import { useSite } from '@/contexts/SiteContext'

/**
 * P0 LOGIN-AUTH-LOOP-FIX (2026-06-10) — `<Route index>` artık doğrudan
 * `<DashboardPage>` render etmiyor; bunun yerine auth state + hidrasyon
 * temelli güvenli yönlendirme yapan bu component'i kullanıyor.
 *
 * PR-A (2026-06-22) — login redirect rolü gözeten matrise dönüştürüldü:
 *
 *   token YOK + !hydrated → minimal Spin (blank screen YOK)
 *   token YOK + hydrated  → /login
 *   token VAR + ctx YOK   → token-first → render placeholder (blank YOK)
 *   token VAR + super_admin (ROLE)            → /platform/overview
 *   token VAR + non-super-admin + org_id var → /app/org/<orgId>/dashboard
 *   token VAR + non-super-admin + org_id YOK → /login (defansif fallback)
 *
 * Old `/dashboard` redirect path is preserved via the LegacyRedirect
 * component mounted under that route — bookmarks/external links/email
 * keep working but the canonical destination is the URL-authoritative
 * `/app/org/:id/dashboard`.
 */
export default function RootRedirect() {
  const hydrated = useHasHydrated()
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const { ctxResolved, activeOrgId, isPlatformSuperAdmin } = useSite()

  // Pre-hydration spinner — same anti-blank-screen contract as PR #64.
  if (!token) {
    if (!hydrated) {
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
          }}
          data-testid="root-redirect-loading"
        >
          <Spin size="large" />
        </div>
      )
    }
    return <Navigate to="/login" replace />
  }

  // Token-first contract: with a token but no user object yet (pre-
  // hydration), we cannot tell role. Render spinner — never blank.
  if (!user || !ctxResolved) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
        data-testid="root-redirect-loading"
      >
        <Spin size="large" />
      </div>
    )
  }

  // Super-admin: land on the platform control plane. The scoped state
  // (activeOrgId !== null) does not change this — the operator can pick
  // a tenant from Firmalar and use the "Çalışma alanını aç" CTA, but
  // login default is always the platform overview.
  if (user.system_role === 'super_admin' || isPlatformSuperAdmin) {
    return <Navigate to="/platform/overview" replace />
  }

  // Normal user: URL-authoritative operations home. Prefer the
  // user.org_id stamped by the JWT; fall back to activeOrgId only if
  // the JWT didn't carry one (legacy session).
  const resolvedOrgId = user.org_id ?? activeOrgId ?? null
  if (resolvedOrgId == null) {
    // No org context at all — bounce to login so the operator
    // re-authenticates / contacts an admin.
    return <Navigate to="/login" replace />
  }
  return <Navigate to={`/app/org/${resolvedOrgId}/dashboard`} replace />
}
