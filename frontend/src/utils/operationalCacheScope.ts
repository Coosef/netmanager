import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * PR-A2 — operational vs preserved query-cache scope.
 *
 * The operator-mandated cache bridge contract (`OrgRouteShell` transition):
 * on an org URL change, every cache entry that represents tenant-bound
 * operational data MUST be cancelled + removed so a previous tenant's
 * payload cannot render under the new tenant's URL. AT THE SAME TIME,
 * non-org-bound application state (auth/session/user/permissions, feature
 * flags, i18n bootstrap, platform control plane lists) MUST survive —
 * otherwise the user is silently logged out / their JWT permissions are
 * lost / the entire UI re-bootstraps for what is conceptually a tenant
 * filter switch.
 *
 * Strategy: explicit ALLOWLIST of preserved queryKey prefixes. Everything
 * else is treated as operational. Allowlist-by-prefix is safer than
 * denylist-by-pattern because:
 *
 *   - Missing an operational entry → leaks across tenants (UNSAFE).
 *   - Missing a preserved entry → unnecessary refetch (slower but
 *     correct; the entry refetches under the new scope).
 *
 * The allowlist is intentionally narrow: only those queryKey prefixes that
 * we have explicitly reasoned about as "not org-bound".
 *
 *   - 'my-permissions'     — the caller's RBAC permission map (per-user)
 *   - 'my-profile'         — the caller's profile (per-user)
 *   - 'user-profile'       — alias used by some pages
 *   - 'feature-flags'      — bootstrap config (global)
 *   - 'platform'           — Platform control-plane queries (super-admin
 *                            global; `platform.organizations` etc.)
 *   - 'credential-profiles' — global credential-profile catalogue read
 *                            by DeviceForm / others; not org-bound at the
 *                            cache layer (backend RLS still enforces per-
 *                            request scope via X-Org-Id).
 *
 * Pure for unit testing — `OrgRouteShell` calls
 * `clearOperationalQueryCache(queryClient)` and the implementation can be
 * verified at the QueryClient API level without rendering React.
 */
const PRESERVED_QUERY_KEY_PREFIXES: ReadonlyArray<string> = [
  'my-permissions',
  'my-profile',
  'user-profile',
  'feature-flags',
  'platform',
  'credential-profiles',
]

/**
 * Return `true` when the supplied queryKey represents tenant-bound
 * operational data that MUST be cleared on an org route change.
 *
 * Edge cases:
 *   - empty or non-array queryKey → operational (defensive — unknown
 *     shape should not survive a tenant switch).
 *   - queryKey whose first segment is not a string → operational (same
 *     rationale; well-known preserved keys all start with a string id).
 */
export function isOperationalQueryKey(queryKey: QueryKey): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return true
  const first = queryKey[0]
  if (typeof first !== 'string') return true
  return !PRESERVED_QUERY_KEY_PREFIXES.includes(first)
}

/**
 * Cancel every in-flight operational query and remove every cached
 * operational entry. Auth/session/global queries (per the allowlist
 * above) are LEFT UNTOUCHED.
 *
 * Order matters:
 *   1. `cancelQueries({predicate})` — abort in-flight fetches FIRST so
 *      their late responses cannot write to the cache the next moment.
 *   2. `removeQueries({predicate})` — drop cache entries SECOND so any
 *      mounted observer for an operational query rebinds against an
 *      empty entry and triggers a fresh fetch under the new scope.
 *
 * Both steps use the same predicate so a regression that drifts the two
 * is impossible at the API level.
 */
export function clearOperationalQueryCache(queryClient: QueryClient): void {
  const predicate = (query: { queryKey: QueryKey }) => isOperationalQueryKey(query.queryKey)
  // Cast `.queryKey` access — React Query's Query type has it; the
  // structural type above keeps the predicate testable in isolation.
  queryClient.cancelQueries({ predicate: (q) => predicate(q as { queryKey: QueryKey }) })
  queryClient.removeQueries({ predicate: (q) => predicate(q as { queryKey: QueryKey }) })
}

/**
 * Exposed for tests + diagnostic UI. The list is stable across releases —
 * adding a new preserved prefix is a deliberate widening of the bridge's
 * "auth/global" carveout and must be code-reviewed.
 */
export const PRESERVED_PREFIXES_FOR_TEST: ReadonlyArray<string> = PRESERVED_QUERY_KEY_PREFIXES
