import { QueryClient } from '@tanstack/react-query'

/**
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24) —
 * single module-level QueryClient instance.
 *
 * The instance was previously created as a local const in App.tsx, which
 * left non-React modules (notably the auth store's `logout` action) with
 * no way to invalidate cached queries. The result: a logout did NOT
 * clear the cached `/context/current` response, so a subsequent re-login
 * could land on the stale ctx and skip the fresh fetch — one half of
 * the production "Lokasyon bağlamı çözümleniyor…" hard-refresh deadlock.
 *
 * Exporting the instance from this module gives both the React tree
 * (via `QueryClientProvider` in App.tsx) AND the auth store
 * (`store/auth.ts:logout`) the same handle. The store's logout now
 * calls `queryClient.removeQueries({ queryKey: ['context'] })` so the
 * next session starts cold.
 *
 * Defaults preserved from the previous inline declaration:
 *   queries: { retry: 1, staleTime: 30000 }
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
})
