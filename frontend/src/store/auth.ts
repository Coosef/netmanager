// RBAC F2 — auth store hizalandı: backend 4-role modeline tek kaynak
// (super_admin / org_admin / location_admin / viewer). Eski persistor'da
// kalmış `admin` / `member` / `org_viewer` / `operator` / `location_*` gibi
// değerler `normalizeRole()` üzerinden yeni vocabulary'e map'leniyor —
// backend `User.role` setter'ı ile simetrik. Böylece bir kullanıcı eski
// localStorage ile geri dönerse de hooks tutarlı davranır.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SystemRole, Permissions } from '@/types'

type AuthUser = {
  id: number
  username: string
  role: SystemRole          // back-compat alias of system_role
  system_role: SystemRole
  org_id?: number | null
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  permissions: Permissions | null
  setAuth: (token: string, user: AuthUser, permissions?: Permissions | null) => void
  logout: () => void
  // Permission-based checks
  can: (module: string, action: string) => boolean
  // RBAC F8 — convenience for any mutating action (edit/create/delete/
  // push/run/backup/connect on a module). Symmetric with backend default
  // grant maps (SYSTEM_ROLE_PERMISSIONS in app/models/user.py).
  canMutate: (module: string) => boolean
  // System role checks (4-role model)
  isSuperAdmin: () => boolean
  isOrgAdmin: () => boolean
  isLocationAdmin: () => boolean
  isViewerOnly: () => boolean
  // Ordered "min role" check — Super > OrgAdmin > LocAdmin > Viewer
  hasPermission: (minRole: SystemRole) => boolean
  // True when the user's reach is location-bound (LocationAdmin / Viewer)
  isLocationScoped: () => boolean
}

// 4-role privilege hierarchy (lowest → highest).
const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']

// RBAC F8 — symmetric with backend SYSTEM_ROLE_PERMISSIONS
// (backend/app/models/user.py). Used by can() when the permissions
// object is loaded but doesn't carry an explicit entry for a module —
// we fall back to the role default rather than blindly allowing.
//
// The grant function returns true if (module, action) is allowed by the
// role's default permission set. Mutating actions on a "managed" module
// (devices, config, tasks, …) require location_admin or higher; viewer
// only ever sees 'view'.
const DEFAULT_ROLE_GRANTS: Record<SystemRole, (module: string, action: string) => boolean> = {
  super_admin: () => true,
  org_admin:   () => true,                    // backend grants "*" effectively for our UI guards
  location_admin: (module, action) => {
    // Action-set mirrors backend LOCATION_ADMIN list (device:create/edit/
    // connect/move; config:push/backup/restore; task:create; …). NOT in
    // the set: device:delete, user:*, locations:*, settings:*, permissions:*.
    if (action === 'view') return true
    if (['users', 'locations', 'settings', 'permissions'].includes(module)) return false
    if (module === 'devices' && action === 'delete') return false
    return true
  },
  viewer: (_module, action) => action === 'view',
}

// Map any legacy / loose value to a live SystemRole. Mirrors the backend
// User.role setter (backend/app/models/user.py) so frontend and backend
// agree on the normalisation. Unknown values fall back to 'viewer' —
// safe-by-default (least privilege).
function normalizeRole(value: unknown): SystemRole {
  if (!value || typeof value !== 'string') return 'viewer'
  const v = value.trim().toLowerCase()
  const live: SystemRole[] = ['super_admin', 'org_admin', 'location_admin', 'viewer']
  if ((live as string[]).includes(v)) return v as SystemRole
  const legacy: Record<string, SystemRole> = {
    admin:              'org_admin',
    org_viewer:         'viewer',
    operator:           'viewer',
    location_manager:   'location_admin',
    location_operator:  'location_admin',
    location_viewer:    'viewer',
    member:             'viewer',
  }
  return legacy[v] ?? 'viewer'
}

function normalizeUser(u: AuthUser): AuthUser {
  // Backend sends both `role` (property) and `system_role`; we trust whichever
  // comes through, normalise it, and keep them in sync.
  const sr = normalizeRole(u.system_role ?? u.role)
  return { ...u, role: sr, system_role: sr }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      permissions: null,

      setAuth: (token, user, permissions = null) =>
        set({ token, user: normalizeUser(user), permissions }),

      logout: () => set({ token: null, user: null, permissions: null }),

      can: (module: string, action: string) => {
        const user = get().user
        if (!user) return false
        // Super Admin and Org Admin: full action set within their scope —
        // their RLS already restricts which rows they see, so action-level
        // checks are unnecessary here.
        if (user.system_role === 'super_admin' || user.system_role === 'org_admin') return true
        // Location Admin and Viewer: respect the permissions object if
        // loaded. RBAC F8 — for mutating actions we DEFAULT-DENY when the
        // permissions object is missing; for read actions ('view') we
        // permit so a page doesn't blank on first paint while perms load.
        const perms = get().permissions
        const isMutating = action !== 'view'
        if (!perms) return !isMutating
        const val = (perms.modules?.[module] as Record<string, boolean> | undefined)?.[action]
        // If a per-module entry doesn't exist, fall back to role-default:
        // viewer = view-only; location_admin gets edit but not delete.
        if (val !== undefined) return val
        return DEFAULT_ROLE_GRANTS[user.system_role]?.(module, action) ?? false
      },

      canMutate: (module: string) => {
        const sr = get().user?.system_role
        if (!sr) return false
        if (sr === 'super_admin' || sr === 'org_admin') return true
        if (sr === 'viewer') return false
        // location_admin: mutating verbs allowed for everything except
        // user / locations / settings management — those are org-admin scope.
        if (sr === 'location_admin') {
          return !['users', 'locations', 'settings', 'permissions'].includes(module)
        }
        return false
      },

      isSuperAdmin: () => get().user?.system_role === 'super_admin',

      isOrgAdmin: () => {
        const sr = get().user?.system_role
        return sr === 'super_admin' || sr === 'org_admin'
      },

      isLocationAdmin: () => {
        const sr = get().user?.system_role
        return sr === 'super_admin' || sr === 'org_admin' || sr === 'location_admin'
      },

      isViewerOnly: () => get().user?.system_role === 'viewer',

      hasPermission: (minRole: SystemRole) => {
        const user = get().user
        if (!user) return false
        const userRank = ROLE_ORDER.indexOf(user.system_role)
        const minRank = ROLE_ORDER.indexOf(normalizeRole(minRole))
        return userRank >= minRank
      },

      // Reach is location-bound for the lower two roles. Org-wide and platform
      // admins are NOT location-scoped (they auto-see every location in their
      // organization / the entire platform respectively).
      isLocationScoped: () => {
        const sr = get().user?.system_role
        return sr === 'location_admin' || sr === 'viewer'
      },
    }),
    {
      name: 'netmgr-auth',
      // Re-normalise persisted user once on rehydrate — old localStorage
      // entries may still carry 'admin' / 'member' etc.
      onRehydrateStorage: () => (state) => {
        if (state?.user) state.user = normalizeUser(state.user)
      },
    },
  ),
)
