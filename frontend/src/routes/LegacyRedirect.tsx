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
 * Org id resolution order:
 *   1. `useSite().activeOrgId` — a super-admin's previously-picked
 *      tenant. The OrganizationSelector localStorage value survives
 *      reloads.
 *   2. `user.org_id` — the home organization stamped by the JWT.
 *
 * Super-admin without an active org → `/platform/overview` (the natural
 * landing page for the control plane); they can pick a tenant from
 * Firmalar and walk back via "Çalışma alanını aç".
 *
 * Anyone with no org id at all is bounced to `/` (RootRedirect surfaces
 * the actual fallback — login or an empty-state message).
 */
export default function LegacyRedirect({ segment }: { segment: 'dashboard' | 'devices' | 'agents' }) {
  const user = useAuthStore((s) => s.user)
  const { activeOrgId, ctxResolved, isPlatformSuperAdmin } = useSite()

  // Wait for context so the role + org id are settled.
  if (!ctxResolved) return null
  if (!user) return <Navigate to="/" replace />

  const resolvedOrgId = activeOrgId ?? user.org_id ?? null

  if (resolvedOrgId == null) {
    if (isPlatformSuperAdmin || user.system_role === 'super_admin') {
      return <Navigate to="/platform/overview" replace />
    }
    return <Navigate to="/" replace />
  }

  return <Navigate to={`/app/org/${resolvedOrgId}/${segment}`} replace />
}
