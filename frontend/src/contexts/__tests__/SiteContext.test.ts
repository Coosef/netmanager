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
import { shouldReconcileLocation } from '../SiteContext'

function ctx(overrides: Partial<CurrentContext>): CurrentContext {
  return {
    user_id: 1,
    username: 'admin',
    system_role: 'super_admin',
    is_super_admin: true,
    is_org_wide: true,
    organization: { id: 1, name: 'Default', slug: 'default' },
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
