import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserRole, SystemRole, Permissions } from '@/types'

type AuthUser = {
  id: number
  username: string
  role: UserRole
  system_role: SystemRole
  tenant_id?: number | null
  org_id?: number | null
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  permissions: Permissions | null
  setAuth: (token: string, user: AuthUser, permissions?: Permissions | null) => void
  logout: () => void
  // New permission-based checks
  can: (module: string, action: string) => boolean
  // System role checks
  isSuperAdmin: () => boolean
  isOrgAdmin: () => boolean
  // Legacy role-order checks (kept for backward compat)
  hasPermission: (minRole: UserRole) => boolean
  isLocationScoped: () => boolean
}

// Legacy role hierarchy order (lowest → highest)
const ROLE_ORDER: UserRole[] = [
  'location_viewer',
  'viewer',
  'location_operator',
  'operator',
  'location_manager',
  'org_viewer',
  'admin',
  'super_admin',
]

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      permissions: null,

      setAuth: (token, user, permissions = null) => set({ token, user, permissions }),

      logout: () => set({ token: null, user: null, permissions: null }),

      can: (module: string, action: string) => {
        const user = get().user
        if (!user) return false
        // System-role bypass
        if (user.system_role === 'super_admin' || user.system_role === 'org_admin') return true
        // Legacy role bypass for super_admin
        if (user.role === 'super_admin') return true
        // admin: use permissions object if present, otherwise allow all
        if (user.role === 'admin') {
          const perms = get().permissions
          if (!perms) return true  // no perms yet → allow (will refresh on mount)
          const val = (perms.modules?.[module] as Record<string, boolean> | undefined)?.[action]
          return val !== false  // allow if not explicitly denied
        }
        // All other roles: check permissions object
        const perms = get().permissions
        if (!perms) return false
        return !!(perms.modules?.[module] as Record<string, boolean> | undefined)?.[action]
      },

      isSuperAdmin: () => {
        const user = get().user
        return user?.system_role === 'super_admin' || user?.role === 'super_admin'
      },

      isOrgAdmin: () => {
        const user = get().user
        return (
          user?.system_role === 'super_admin' ||
          user?.system_role === 'org_admin' ||
          user?.role === 'super_admin' ||
          user?.role === 'admin'
        )
      },

      hasPermission: (minRole: UserRole) => {
        const user = get().user
        if (!user) return false
        return ROLE_ORDER.indexOf(user.role as UserRole) >= ROLE_ORDER.indexOf(minRole)
      },

      isLocationScoped: () => {
        const user = get().user
        return ['location_manager', 'location_operator', 'location_viewer', 'operator', 'viewer'].includes(
          user?.role ?? ''
        )
      },
    }),
    { name: 'netmgr-auth' },
  ),
)
