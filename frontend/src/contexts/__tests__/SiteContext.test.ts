/**
 * Regression coverage for `shouldReconcileLocation` — the predicate
 * that gates SiteContext's stale-location reconciliation effect.
 *
 * The fix this file pins down (hotfix/site-context-orgwide-reconciliation-loop):
 *
 *   Faz 8 Phase E (`5c1fbc99`, 2026-05-19) introduced a reconciliation
 *   useEffect that compared `activeLocationId` against
 *   `ctx.allowed_location_ids`. The contract assumption — that
 *   `allowed_location_ids` is the explicit per-user whitelist — only
 *   holds for LOCATION-SCOPED roles. For org-wide roles (super_admin,
 *   org_admin) the backend returns `allowed_location_ids: []` to mean
 *   "no whitelist; every location allowed", and the membership check
 *   `[].includes(x) === false` would unconditionally trip the
 *   `queryClient.clear()` branch, evict the ctx cache, refire useQuery,
 *   re-run the effect, … forever. User-visible: stuck spinner,
 *   location switch not taking, topology never loading, WS reconnect
 *   storm. The fix is one guard: return early when `ctx.is_org_wide`.
 */
import { describe, it, expect } from 'vitest'
import type { CurrentContext } from '../../api/context'
import { shouldReconcileLocation, isActiveLocationStale } from '../SiteContext'

function ctx(overrides: Partial<CurrentContext>): CurrentContext {
  return {
    user_id: 1,
    username: 'admin',
    system_role: 'super_admin',
    is_super_admin: true,
    is_org_wide: true,
    organization: { id: 1, name: 'Default', slug: 'default' },
    features: {},
    locations: [],
    allowed_location_ids: [],
    active_location_id: null,
    has_location_access: true,
    ...overrides,
  }
}

describe('shouldReconcileLocation', () => {
  it('returns false when ctx is null (still loading)', () => {
    expect(shouldReconcileLocation(null, 7)).toBe(false)
    expect(shouldReconcileLocation(undefined, 7)).toBe(false)
  })

  it('returns false when activeLocationId is null (nothing to reconcile)', () => {
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: false, allowed_location_ids: [1, 2] }),
        null,
      ),
    ).toBe(false)
  })

  // ── The regression — load-bearing guard against the infinite loop ───
  it('NEVER reconciles for org-wide users — `allowed_location_ids: []` means "all allowed"', () => {
    // The exact shape an org-wide super_admin gets back from the
    // backend, with a stored activeLocationId that the membership
    // check would otherwise reject.
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: true, allowed_location_ids: [] }),
        5,
      ),
    ).toBe(false)
    // Same predicate must hold no matter what active_location_id the
    // backend echoes back — it would otherwise feed the loop.
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: true, allowed_location_ids: [], active_location_id: 5 }),
        5,
      ),
    ).toBe(false)
    // Org-wide users with a non-empty allowed list (unusual but valid
    // for an admin who's also a member of specific locations) still
    // skip reconciliation — `is_org_wide` is authoritative.
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: true, allowed_location_ids: [1, 2] }),
        99,
      ),
    ).toBe(false)
  })

  it('reconciles a location-scoped user with a stored id NOT in the whitelist', () => {
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: false, allowed_location_ids: [1, 2] }),
        7,
      ),
    ).toBe(true)
  })

  it('does NOT reconcile a location-scoped user whose stored id IS in the whitelist', () => {
    expect(
      shouldReconcileLocation(
        ctx({ is_org_wide: false, allowed_location_ids: [1, 2] }),
        1,
      ),
    ).toBe(false)
  })

  it('reconciles a location-scoped user who lost access entirely (empty whitelist)', () => {
    // A formerly-assigned user whose user_locations row was revoked
    // should still be steered back to the backend's resolved default
    // (null → org-wide implicit OR an explicit fallback the backend
    // chooses). The predicate fires; the effect's body decides what
    // to do.
    expect(
      shouldReconcileLocation(
        ctx({
          is_org_wide: false,
          allowed_location_ids: [],
          has_location_access: false,
        }),
        3,
      ),
    ).toBe(true)
  })
})


// ─── SITE-CONTEXT-HYDRATION-GUARD (2026-06-19) ──────────────────────────
//
// Regression coverage for `isActiveLocationStale`. The predicate fills
// the gap left by `shouldReconcileLocation` for org-wide users: a
// super_admin / org_admin whose `localStorage[ACTIVE_LOCATION_KEY]`
// points at a soft-deleted (or otherwise revoked) location row no
// longer reaches that location's data, and the regular reconciliation
// effect intentionally skips them. This predicate decides when the
// stale-id cleanup effect should fire and reset the local state to the
// backend-resolved default.
describe('isActiveLocationStale', () => {
  const loc = (id: number, name: string) => ({
    id, name, color: null, city: null, country: null, device_count: 0,
  })

  it('returns false when ctx is null / undefined (still loading)', () => {
    expect(isActiveLocationStale(null, 7)).toBe(false)
    expect(isActiveLocationStale(undefined, 7)).toBe(false)
  })

  it('returns false when activeLocationId is null (nothing stored)', () => {
    expect(
      isActiveLocationStale(
        ctx({ locations: [loc(1, 'Istanbul'), loc(2, 'Ankara')] }),
        null,
      ),
    ).toBe(false)
  })

  it('returns false when the stored id is present in ctx.locations', () => {
    expect(
      isActiveLocationStale(
        ctx({ locations: [loc(1, 'Istanbul'), loc(2, 'Ankara')] }),
        2,
      ),
    ).toBe(false)
  })

  // ── The regression — org-wide super_admin whose stored id points at a
  //    soft-deleted location row that the backend no longer returns ────
  it('returns true for org-wide super_admin whose stored id is absent from ctx.locations', () => {
    expect(
      isActiveLocationStale(
        ctx({
          is_super_admin: true,
          is_org_wide: true,
          allowed_location_ids: [],
          locations: [loc(2, 'ForTow'), loc(3, 'Luxury'), loc(5, 'Unassigned')],
          // stored id 9 was a soft-deleted "Mövempic" — operator deleted
          // it; the backend no longer surfaces it.
        }),
        9,
      ),
    ).toBe(true)
  })

  it('returns true for a location-scoped user whose stored id is absent', () => {
    expect(
      isActiveLocationStale(
        ctx({
          is_org_wide: false,
          allowed_location_ids: [1, 2],
          locations: [loc(1, 'Istanbul'), loc(2, 'Ankara')],
        }),
        99,
      ),
    ).toBe(true)
  })

  it('does NOT confuse a falsy id zero with a missing id', () => {
    // Defensive — id=0 is unusual but valid. The predicate must use
    // .some not includes-with-coercion.
    expect(
      isActiveLocationStale(
        ctx({ locations: [loc(0, 'Root')] }),
        0,
      ),
    ).toBe(false)
  })

  it('is decoupled from is_org_wide — covers BOTH org-wide and scoped users', () => {
    // shouldReconcileLocation short-circuits for org-wide users to
    // protect the infinite-loop guard. isActiveLocationStale must NOT
    // honor that carve-out — that is the whole point of the new
    // predicate.
    const orgWideCtx = ctx({
      is_org_wide: true,
      allowed_location_ids: [],
      locations: [loc(1, 'A')],
    })
    expect(shouldReconcileLocation(orgWideCtx, 99)).toBe(false)
    expect(isActiveLocationStale(orgWideCtx, 99)).toBe(true)
  })
})
