import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'

/**
 * PR-A — Platform panel guard.
 *
 * Wraps every `/platform/*` route. Only super_admin (ROLE identity, not
 * the currently-active RLS bypass flag) may enter. Anyone else is
 * redirected to `/` — RootRedirect then sends them to their operations
 * home `/app/org/<own>/dashboard`.
 *
 * The shell renders `<Outlet />`; the surrounding AppLayout's sidebar
 * switches to `PlatformSidebar` via `detectPanelMode(pathname)`.
 *
 * Note: the guard uses `useAuthStore.user.system_role` (stable role
 * identity) rather than `useSite().isSuperAdmin` (the bypass-active
 * flag) — a scoped super-admin who has X-Org-Id active still has the
 * role and must be able to walk back to the platform panel.
 */
export default function PlatformShell() {
  const user = useAuthStore((s) => s.user)
  const { ctxResolved, isPlatformSuperAdmin } = useSite()

  // Wait for context resolution to avoid a flash redirect during
  // hydration. user.system_role is locally persisted so it's available
  // immediately; isPlatformSuperAdmin is the backend-confirmed echo.
  if (user == null) return null
  if (!ctxResolved) return null

  if (user.system_role !== 'super_admin' && !isPlatformSuperAdmin) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}
