import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, UserRole } from '@/types'

type AuthUser = Pick<User, 'id' | 'username' | 'role'> & { tenant_id?: number | null }

interface AuthState {
  token: string | null
  user: AuthUser | null
  setAuth: (token: string, user: AuthUser) => void
  logout: () => void
  hasPermission: (minRole: UserRole) => boolean
  isSuperAdmin: () => boolean
  isOrgAdmin: () => boolean
  isLocationScoped: () => boolean
}

// Ordered from lowest to highest privilege
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
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
      hasPermission: (minRole: UserRole) => {
        const user = get().user
        if (!user) return false
        return ROLE_ORDER.indexOf(user.role as UserRole) >= ROLE_ORDER.indexOf(minRole)
      },
      isSuperAdmin: () => get().user?.role === 'super_admin',
      isOrgAdmin: () => {
        const role = get().user?.role
        return role === 'super_admin' || role === 'admin'
      },
      isLocationScoped: () => {
        const role = get().user?.role
        return ['location_manager', 'location_operator', 'location_viewer', 'operator', 'viewer'].includes(role ?? '')
      },
    }),
    { name: 'netmgr-auth' },
  ),
)
