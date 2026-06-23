import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRouteOrgId } from '@/hooks/useRouteOrgId'

/**
 * PR-A2 — operations-panel-aware navigation helper.
 *
 * The PR-A2 contract: inside `/app/org/:organizationId/*`, every page-
 * level navigation that targets an operations module MUST land under the
 * same `/app/org/:routeOrgId/...` prefix. A bare `navigate('/topology')`
 * from inside the operations panel would escape to the legacy panel,
 * drop the URL-authoritative org context, and re-introduce the
 * cross-tenant leak operator addendums closed.
 *
 * This hook auto-prefixes single-segment paths. Special cases:
 *
 *   - `intentionalGlobal: true` — the caller explicitly wants to leave
 *     the operations panel (e.g., a "Hesap Ayarları" link, "Platform
 *     Yönetimi" link, "Çıkış Yap" link). The prefix is skipped; the
 *     path is navigated as-is. The flag makes the global exit
 *     **explicit + greppable + testable** instead of an accidental
 *     legacy fallback.
 *
 *   - Path already absolute under `/app/org/N/...` — navigated as-is
 *     (cross-org navigation is legitimate for super-admins via the
 *     OrgBadge dropdown).
 *
 *   - Path starts with `/platform/` or is `/login` / `/` — these are
 *     auth/control-plane paths. They are allowed but require the
 *     `intentionalGlobal: true` marker. In `import.meta.env.DEV`, a
 *     missing marker logs a console.error to catch regressions early;
 *     the navigation still proceeds (defensive — refusing would
 *     surprise the operator at runtime).
 *
 *   - `routeOrgId == null` — the caller is NOT inside the operations
 *     panel (legacy route, platform route, login). The path is
 *     navigated as-is; the hook is a no-op transformer in that case.
 */
interface OperationsNavigateOptions {
  replace?: boolean
  /**
   * Explicit acknowledgment that this navigation deliberately leaves the
   * `/app/org/:routeOrgId/*` operations panel. Required for global
   * destinations like `/settings`, `/profile`, `/login`,
   * `/platform/...`.
   */
  intentionalGlobal?: boolean
}

export type OperationsNavigateFn = (path: string, options?: OperationsNavigateOptions) => void

/**
 * Paths that are inherently global and never operations-scoped. A
 * navigation to one of these from inside the operations panel SHOULD
 * carry `intentionalGlobal: true`; if it doesn't, dev-time logging
 * surfaces the regression.
 */
const GLOBAL_PATH_PREFIXES: ReadonlyArray<string> = [
  '/login',
  '/logout',
  '/platform',
  '/profile',
  '/settings',
  '/invite',
  '/ssh/',
]

function isGlobalPath(path: string): boolean {
  if (path === '/') return true
  return GLOBAL_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?') || path.startsWith(p + '#'))
}

export function useOperationsNavigate(): OperationsNavigateFn {
  const navigate = useNavigate()
  const routeOrgId = useRouteOrgId()

  return useCallback(
    (path: string, options?: OperationsNavigateOptions) => {
      const replace = options?.replace
      const intentionalGlobal = options?.intentionalGlobal === true

      // OUTSIDE operations panel — no prefix decision to make.
      if (routeOrgId == null) {
        navigate(path, { replace })
        return
      }

      // Cross-org navigation (super-admin scoping into another tenant) —
      // already absolute under /app/org/N/...; let it through.
      if (path.startsWith('/app/org/')) {
        navigate(path, { replace })
        return
      }

      // Explicit global exit — bypass prefixing.
      if (intentionalGlobal) {
        navigate(path, { replace })
        return
      }

      // Implicit global path WITHOUT the explicit marker — log + still
      // navigate. This catches accidental legacy escapes during dev.
      if (isGlobalPath(path)) {
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.error(
            `[useOperationsNavigate] navigate('${path}') without intentionalGlobal flag from /app/org/${routeOrgId}/* — silent legacy escape risk. Pass { intentionalGlobal: true } to acknowledge.`,
          )
        }
        navigate(path, { replace })
        return
      }

      // Default: prefix with the active operations org root.
      const prefixed = path.startsWith('/')
        ? `/app/org/${routeOrgId}${path}`
        : `/app/org/${routeOrgId}/${path}`
      navigate(prefixed, { replace })
    },
    [navigate, routeOrgId],
  )
}
