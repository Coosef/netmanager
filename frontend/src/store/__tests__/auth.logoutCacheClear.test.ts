/**
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24) —
 * auth store logout must remove cached ['context'] React Query
 * entries so a subsequent re-login starts from a cold cache.
 *
 * Pre-fix behavior: `logout()` only cleared local auth state
 * (token/user/permissions). React Query cache still held the previous
 * session's `/context/current` response. On re-login, useQuery's
 * `enabled: !!token && hydrated` flipped true and React Query
 * served the stale cached response BEFORE the queryKey-driven
 * refetch could fire — leaving the new session looking at the
 * old tenant's organization / location data until the staleTime
 * elapsed.
 *
 * Post-fix: logout dynamically imports the shared queryClient
 * singleton and calls `removeQueries({ queryKey: ['context'] })`.
 * `removeQueries` (not `invalidateQueries`) wipes the entry so the
 * next `enabled=true` transition does a fresh fetch instead of
 * serving stale-then-refetching.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('auth store logout — P0.2 context cache cleanup', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../auth.ts'),
    'utf-8',
  )
  const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')

  it('logout dynamically imports the queryClient singleton', () => {
    expect(SRC).toMatch(/import\(['"]@\/lib\/queryClient['"]\)/)
  })

  it('logout calls removeQueries with the canonical context queryKey', () => {
    // Pin the EXACT call shape: removeQueries({ queryKey: ['context'] })
    expect(SRC).toMatch(/removeQueries\(\s*\{\s*queryKey:\s*\[['"]context['"]\]\s*\}\s*\)/)
  })

  it('removeQueries (NOT invalidateQueries) — we wipe, we do not refetch', () => {
    // Pin the semantic choice. invalidateQueries would mark the
    // entry stale + trigger a background refetch with the OLD
    // X-Org-Id / token header during the brief window before
    // setState({token:null}) runs. removeQueries drops the entry
    // synchronously so no in-flight refetch carries old credentials.
    expect(codeOnly).not.toMatch(/queryClient\.invalidateQueries\(\s*\{\s*queryKey:\s*\[['"]context['"]\]/)
  })

  it('removeQueries call is GUARDED by try/catch so logout never throws on cache cleanup failure', () => {
    // The block must be wrapped so a queryClient module load failure
    // (extremely unlikely but possible during HMR) does not leave the
    // user stuck on a half-completed logout. The local auth state
    // clear MUST always run.
    expect(SRC).toMatch(/try\s*\{\s*import\(['"]@\/lib\/queryClient['"]\)/)
    expect(SRC).toMatch(/catch\s*\{\s*\/\*\s*noop\s*\*\/\s*\}/)
  })

  it('local auth state clear still runs AFTER the cache cleanup attempt', () => {
    // Order check: the dynamic import for queryClient comes BEFORE
    // set({ token: null, user: null, permissions: null }).
    const removeIdx = codeOnly.indexOf("removeQueries")
    const clearIdx = codeOnly.indexOf("set({ token: null, user: null, permissions: null })")
    expect(removeIdx).toBeGreaterThan(0)
    expect(clearIdx).toBeGreaterThan(0)
    expect(removeIdx).toBeLessThan(clearIdx)
  })
})
