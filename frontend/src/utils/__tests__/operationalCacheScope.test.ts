/**
 * PR-A2 — operational vs preserved query-cache scope.
 *
 * The predicate is the single source of truth for the
 * `clearOperationalQueryCache(queryClient)` cache bridge wipe. A
 * regression here either:
 *   - drops a preserved key (auth/session/user → user is silently
 *     logged out on every tenant switch), or
 *   - preserves an operational key (cross-tenant leak — what PR-A2
 *     exists to prevent).
 *
 * Both failures are catastrophic; the fixture matrix below pins every
 * documented prefix + a representative sample of operational keys.
 */
import { describe, it, expect, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  isOperationalQueryKey,
  clearOperationalQueryCache,
  PRESERVED_PREFIXES_FOR_TEST,
} from '../operationalCacheScope'

describe('isOperationalQueryKey — predicate matrix', () => {
  it.each([
    // Auth / user / permissions / global (PRESERVED → not operational)
    [['my-permissions'], false],
    [['my-profile'], false],
    [['user-profile'], false],
    [['feature-flags'], false],
    [['credential-profiles'], false],
    // Platform control plane (PRESERVED)
    [['platform', 'organizations'], false],
    [['platform', 'overview', 'metrics'], false],
    [['platform'], false],
  ])('preserved key %j → operational = %s', (key, expected) => {
    expect(isOperationalQueryKey(key)).toBe(expected)
  })

  it.each([
    // PR-A migrated org-scoped keys (OPERATIONAL)
    [['org', 6, 'devices-list', 'q', 'cisco']],
    [['org', 6, 'agents-list']],
    [['org', 1, 'locations']],
    [['org', 42, 'devices-stats', 'main']],
    // Pre-PR-A2 legacy keys (OPERATIONAL — backend scoped via X-Org-Id,
    // but cache key itself doesn't carry org. Cache bridge wipes them.)
    [['devices', 'q', 'cisco']],
    [['topology-graph', 'all']],
    [['monitor-stats', 'site-a']],
    [['report-summary', 'site-b']],
    [['ipam-zones']],
    [['audit-log', 1]],
    // Context query — operational, partitioned by routeOrgId itself
    [['context', 'current', 6, 7]],
    // Header / dashboard widgets — operational
    [['header-recent-events']],
    [['monitor-events-cards', 'critical', 24]],
    [['playbooks']],
  ])('operational key %j → operational = true', (key) => {
    expect(isOperationalQueryKey(key)).toBe(true)
  })

  it.each([
    [[]],
    [[123]],         // first segment not a string
    [[null]],        // weird first
    [[{ a: 1 }]],
  ])('defensive: malformed key %j → operational (safe default)', (key) => {
    expect(isOperationalQueryKey(key as unknown[])).toBe(true)
  })
})

describe('PRESERVED_PREFIXES_FOR_TEST — allowlist surface', () => {
  it('contains every documented preserved prefix', () => {
    for (const prefix of [
      'my-permissions',
      'my-profile',
      'user-profile',
      'feature-flags',
      'platform',
      'credential-profiles',
    ]) {
      expect(PRESERVED_PREFIXES_FOR_TEST).toContain(prefix)
    }
  })

  it('has no duplicates', () => {
    const set = new Set(PRESERVED_PREFIXES_FOR_TEST)
    expect(set.size).toBe(PRESERVED_PREFIXES_FOR_TEST.length)
  })
})

describe('clearOperationalQueryCache — QueryClient integration', () => {
  it('cancels + removes ONLY operational queries; preserved survive', () => {
    const qc = new QueryClient()

    // Seed cache with mixed entries.
    qc.setQueryData(['my-permissions'], { canEdit: true })
    qc.setQueryData(['platform', 'organizations'], [{ id: 6, name: 'ATG' }])
    qc.setQueryData(['feature-flags'], { ai_assistant: true })

    qc.setQueryData(['org', 6, 'devices-list'], [{ id: 1 }])
    qc.setQueryData(['topology-graph', 'main'], { nodes: 100 })
    qc.setQueryData(['monitor-stats', 'site'], { events: 5 })
    qc.setQueryData(['context', 'current', 6, 7], { organization: { id: 6 } })

    // Pre-flight count.
    expect(qc.getQueryCache().getAll()).toHaveLength(7)

    clearOperationalQueryCache(qc)

    // Preserved survive.
    expect(qc.getQueryData(['my-permissions'])).toBeDefined()
    expect(qc.getQueryData(['platform', 'organizations'])).toBeDefined()
    expect(qc.getQueryData(['feature-flags'])).toBeDefined()

    // Operational gone.
    expect(qc.getQueryData(['org', 6, 'devices-list'])).toBeUndefined()
    expect(qc.getQueryData(['topology-graph', 'main'])).toBeUndefined()
    expect(qc.getQueryData(['monitor-stats', 'site'])).toBeUndefined()
    expect(qc.getQueryData(['context', 'current', 6, 7])).toBeUndefined()

    expect(qc.getQueryCache().getAll()).toHaveLength(3)
  })

  it('calls cancelQueries BEFORE removeQueries (order is load-bearing)', () => {
    const qc = new QueryClient()
    const cancelSpy = vi.spyOn(qc, 'cancelQueries')
    const removeSpy = vi.spyOn(qc, 'removeQueries')

    clearOperationalQueryCache(qc)

    expect(cancelSpy).toHaveBeenCalledOnce()
    expect(removeSpy).toHaveBeenCalledOnce()
    // Invocation order: cancel first, remove second.
    const cancelOrder = cancelSpy.mock.invocationCallOrder[0]
    const removeOrder = removeSpy.mock.invocationCallOrder[0]
    expect(cancelOrder).toBeLessThan(removeOrder)
  })

  it('both calls receive a predicate (not bare object — pin the API)', () => {
    const qc = new QueryClient()
    const cancelSpy = vi.spyOn(qc, 'cancelQueries')
    const removeSpy = vi.spyOn(qc, 'removeQueries')

    clearOperationalQueryCache(qc)

    expect(cancelSpy.mock.calls[0][0]).toHaveProperty('predicate')
    expect(removeSpy.mock.calls[0][0]).toHaveProperty('predicate')
    expect(typeof (cancelSpy.mock.calls[0][0] as { predicate: unknown }).predicate).toBe('function')
    expect(typeof (removeSpy.mock.calls[0][0] as { predicate: unknown }).predicate).toBe('function')
  })
})
