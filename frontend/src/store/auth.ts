import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/types'

interface AuthState {
  token: string | null
  user: Pick<User, 'id' | 'username' | 'role'> & { tenant_id?: number | null } | null
  setAuth: (token: string, user: Pick<User, 'id' | 'username' | 'role'> & { tenant_id?: number | null }) => void
  logout: () => void
  hasPermission: (role: string) => boolean
  isSuperAdmin: () => boolean
}

const ROLE_ORDER = ['viewer', 'operator', 'admin', 'super_admin']

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
      hasPermission: (minRole: string) => {
        const user = get().user
        if (!user) return false
        return ROLE_ORDER.indexOf(user.role) >= ROLE_ORDER.indexOf(minRole)
      },
      isSuperAdmin: () => get().user?.role === 'super_admin',
    }),
    { name: 'netmgr-auth' },
  ),
)
