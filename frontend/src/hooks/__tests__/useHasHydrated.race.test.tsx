// @vitest-environment jsdom
/**
 * P0.2 SITECONTEXT HYDRATION RACE + PLATFORM RECOVERY (2026-06-24).
 *
 * Production incident: hard refresh on /app/org/:id/* hung at
 * "Lokasyon bağlamı çözümleniyor…" indefinitely. Browser console
 * snapshot:
 *
 *     tokenPresent: true
 *     hydrated:     false   ← stuck
 *     ctx_present:  false
 *     sitesLoading: true
 *
 * Token WAS hydrated (so Zustand persist's _hasHydrated MUST be true);
 * the useHasHydrated hook's React state simply missed the
 * onFinishHydration once-only event because its useEffect subscribed
 * AFTER the rehydrate microtask resolved. These tests pin the
 * three-stage recheck (sync + microtask + setTimeout) that guarantees
 * the hook lands on `true` regardless of which scheduler turn the
 * Zustand microtask resolves on.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ─── Source-level pins ─────────────────────────────────────────────────

describe('useHasHydrated — P0.2 source contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../useHasHydrated.ts'),
    'utf-8',
  )

  it('three-stage recheck is wired (sync + microtask + setTimeout)', () => {
    // Synchronous recheck inside useEffect
    expect(SRC).toMatch(/checkAndSet\(\)\s*\n\s*\/\/ \(2\)/)
    // queueMicrotask recheck
    expect(SRC).toMatch(/queueMicrotask\(checkAndSet\)/)
    // setTimeout(0) recheck — task queue fallback
    expect(SRC).toMatch(/setTimeout\(checkAndSet,\s*0\)/)
  })

  it('listeners still subscribed for future rehydrate cycles', () => {
    expect(SRC).toMatch(/useAuthStore\.persist\.onHydrate\(\(\) => \{[\s\S]{0,200}setHydrated\(false\)/)
    expect(SRC).toMatch(/useAuthStore\.persist\.onFinishHydration\(\(\) => \{[\s\S]{0,200}setHydrated\(true\)/)
  })

  it('cleanup function clears the setTimeout AND unsubscribes listeners', () => {
    expect(SRC).toMatch(/clearTimeout\(timeoutId\)/)
    expect(SRC).toMatch(/unsubStart\(\)/)
    expect(SRC).toMatch(/unsubFinish\(\)/)
  })
})

// ─── Behavioral tests ──────────────────────────────────────────────────

// Mock the auth store's persist API so we can control hasHydrated()
// return value across timeline phases.
let mockHasHydrated = false
const onHydrateListeners: Array<() => void> = []
const onFinishListeners: Array<() => void> = []

vi.mock('@/store/auth', () => ({
  useAuthStore: Object.assign(
    () => ({}),
    {
      persist: {
        hasHydrated: () => mockHasHydrated,
        onHydrate: (cb: () => void) => {
          onHydrateListeners.push(cb)
          return () => {
            const i = onHydrateListeners.indexOf(cb)
            if (i >= 0) onHydrateListeners.splice(i, 1)
          }
        },
        onFinishHydration: (cb: () => void) => {
          onFinishListeners.push(cb)
          return () => {
            const i = onFinishListeners.indexOf(cb)
            if (i >= 0) onFinishListeners.splice(i, 1)
          }
        },
      },
    },
  ),
}))

import { useHasHydrated } from '../useHasHydrated'

function reset() {
  mockHasHydrated = false
  onHydrateListeners.length = 0
  onFinishListeners.length = 0
}

beforeEach(reset)
afterEach(reset)

describe('useHasHydrated — race scenarios', () => {
  it('Scenario A: persist.hasHydrated()=true BEFORE listener subscribe → hook returns true', async () => {
    // Operator's production scenario: rehydrate microtask resolved
    // BEFORE useHasHydrated mounted. Initial useState gets true.
    mockHasHydrated = true
    const { result } = renderHook(() => useHasHydrated())
    expect(result.current).toBe(true)
  })

  it('Scenario B: persist.hasHydrated()=false at mount, then flips true mid-microtask → hook recovers via queueMicrotask check', async () => {
    // This is THE production deadlock. Mount with false; then the
    // Zustand microtask resolves WITHOUT firing the subscribed
    // listener (because subscribe-after-fire); the queueMicrotask
    // recheck must catch the new value.
    mockHasHydrated = false
    const { result } = renderHook(() => useHasHydrated())
    expect(result.current).toBe(false)
    // Simulate Zustand finishing rehydrate but NOT firing the
    // listener (i.e. the once-only fire window already passed).
    mockHasHydrated = true
    // Wait for the queueMicrotask + setTimeout(0) checks to run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1))
    })
    expect(result.current).toBe(true)
  })

  it('Scenario C: persist.hasHydrated()=false at mount AND microtask, recovers via setTimeout(0) recheck', async () => {
    mockHasHydrated = false
    const { result } = renderHook(() => useHasHydrated())
    expect(result.current).toBe(false)
    // Resolve hydration only AFTER the microtask checkpoint
    // (simulates a very slow rehydrate scheduler — defensive case).
    await act(async () => {
      // Flush microtasks first (queueMicrotask runs here)
      await Promise.resolve()
      // Now flip the flag — only the setTimeout(0) check will catch it
      mockHasHydrated = true
      // Allow the setTimeout(0) task to run
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(result.current).toBe(true)
  })

  it('Scenario D: future onFinishHydration listener still updates state (cross-tab storage event)', async () => {
    mockHasHydrated = false
    const { result } = renderHook(() => useHasHydrated())
    // Flush the three recheck phases — none catch a `true`.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(result.current).toBe(false)
    // Now simulate a delayed rehydrate (e.g. cross-tab event):
    // listener fires AFTER initial mount.
    mockHasHydrated = true
    await act(async () => {
      onFinishListeners.forEach((cb) => cb())
    })
    expect(result.current).toBe(true)
  })

  it('Scenario E: onHydrate listener resets to false (mid-session rehydrate)', async () => {
    mockHasHydrated = true
    const { result } = renderHook(() => useHasHydrated())
    expect(result.current).toBe(true)
    // Simulate rehydrate STARTING again (e.g. cross-tab login event)
    await act(async () => {
      mockHasHydrated = false
      onHydrateListeners.forEach((cb) => cb())
    })
    expect(result.current).toBe(false)
    // ...and finishing.
    await act(async () => {
      mockHasHydrated = true
      onFinishListeners.forEach((cb) => cb())
    })
    expect(result.current).toBe(true)
  })

  it('Cleanup: unmount removes listeners + clears pending setTimeout', async () => {
    mockHasHydrated = false
    const { unmount } = renderHook(() => useHasHydrated())
    expect(onHydrateListeners.length).toBe(1)
    expect(onFinishListeners.length).toBe(1)
    unmount()
    expect(onHydrateListeners.length).toBe(0)
    expect(onFinishListeners.length).toBe(0)
  })
})
