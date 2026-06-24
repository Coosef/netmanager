/**
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24) —
 * shared QueryClient singleton contract.
 *
 * Pre-fix: QueryClient was constructed as a local const inside App.tsx
 * → non-React modules (auth store logout) had no handle to the cache.
 * Post-fix: instance moved to `@/lib/queryClient`. App.tsx imports the
 * same instance; auth store logout dynamically imports it for cache
 * cleanup.
 */
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryClient } from '../queryClient'

describe('lib/queryClient — P0.2 shared singleton', () => {
  it('exports a QueryClient instance', () => {
    expect(queryClient).toBeInstanceOf(QueryClient)
  })

  it('preserves the pre-fix defaultOptions (retry: 1, staleTime: 30000)', () => {
    const opts = queryClient.getDefaultOptions()
    expect(opts.queries?.retry).toBe(1)
    expect(opts.queries?.staleTime).toBe(30000)
  })

  it('module exports the same instance on repeated imports', async () => {
    const { queryClient: again } = await import('../queryClient')
    expect(again).toBe(queryClient)
  })
})
