import { Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'

/**
 * PR-A — Legacy operations URL → URL-authoritative org route.
 *
 * Three legacy entry points (`/dashboard`, `/devices`, `/agents`) keep
 * working for bookmarks / external links / email, but their content is
 * now served from `/app/org/:resolvedOrgId/<segment>`.
 *
 * P0.1 HOTFIX (2026-06-23) — JWT-only decision. The previous
 * implementation gated the redirect on `useSite().ctxResolved`, which
 * deadlocked the legacy route when the operator's session token was
 * expired or invalid:
 *
 *   1. /dashboard renders inside AppLayout
 *   2. AppLayout wraps the workspace Outlet in <LocationGate>
 *   3. LocationGate shows the "Lokasyon bağlamı çözümleniyor…" spinner
 *      while `sitesLoading` is true
 *   4. Meanwhile, the SiteContext ctx query 401-loops on the bad token
 *   5. ctxResolved never becomes true → LegacyRedirect returns `null`
 *   6. Spinner sticks forever; operator never reaches the redirect
 *
 * The fix is two-part:
 *
 *   - Drop the `ctxResolved` wait: the only information needed for the
 *     redirect decision is in the JWT (already in the auth store):
 *     `user.system_role` + `user.org_id`. The `activeOrgId` localStorage
 *     hint is consulted ONLY for the super-admin operations branches
 *     because that's where it matters (the operator's currently-picked
 *     tenant). When `activeOrgId` is missing for a super-admin doing
 *     `/devices` or `/agents`, fall back to `/platform/organizations`
 *     so the operator picks a tenant explicitly instead of getting
 *     bounced to their irrelevant home org.
 *
 *   - The companion LocationGate fix at `LocationGate.tsx` bypasses
 *     the spinner for these three pure-redirect pathnames so the
 *     Navigate component below can actually mount + fire.
 *
 * Decision order (per operator addendum):
 *
 *   1. no user (token missing / not yet hydrated) → `/`
 *      → RootRedirect surfaces the login / spinner fallback
 *
 *   2. super_admin + dashboard segment → `/platform/overview`
 *      (super-admins always land on the platform control plane;
 *      a bookmark to `/dashboard` should NOT pin them to a tenant)
 *
 *   3. super_admin + devices/agents segment:
 *      a. activeOrgId is set + non-null → `/app/org/<activeOrgId>/<seg>`
 *         (the operator's currently-active tenant per
 *         `localStorage[nm-active-org-id]`)
 *      b. activeOrgId is null → `/platform/organizations`
 *         (operator must pick a tenant before the operations alias
 *         can scope correctly; we do NOT default to their JWT org_id
 *         because for a super-admin that's almost never the right
 *         tenant)
 *
 *   4. normal user (any segment) → `/app/org/<user.org_id>/<segment>`
 *      (their JWT-fixed home tenant; activeOrgId is irrelevant — the
 *      backend ignores X-Org-Id from non-super-admin callers anyway)
 */
export default function LegacyRedirect({ segment }: { segment: 'dashboard' | 'devices' | 'agents' }) {
  const user = useAuthStore((s) => s.user)
  const { activeOrgId } = useSite()

  // 1. No user → bounce home (RootRedirect handles login fallback).
  if (!user) return <Navigate to="/" replace />

  const isSuperAdmin = user.system_role === 'super_admin'

  // 2. Super-admin + dashboard → platform control plane.
  if (isSuperAdmin && segment === 'dashboard') {
    return <Navigate to="/platform/overview" replace />
  }

  // 3. Super-admin + operations legacy alias (devices / agents).
  if (isSuperAdmin) {
    if (activeOrgId != null) {
      return <Navigate to={`/app/org/${activeOrgId}/${segment}`} replace />
    }
    // No tenant picked → operator must select one explicitly.
    return <Navigate to="/platform/organizations" replace />
  }

  // 4. Normal user → JWT-fixed home tenant.
  const userOrgId = user.org_id ?? null
  if (userOrgId == null) {
    // Defensive: a non-super-admin user with no org_id is a malformed
    // JWT. Bounce home so RootRedirect can surface a clearer message.
    return <Navigate to="/" replace />
  }
  return <Navigate to={`/app/org/${userOrgId}/${segment}`} replace />
}
