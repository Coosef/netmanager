/**
 * PR-A — panelMode helper.
 *
 * `detectPanelMode` is the single source of truth for the "which panel
 * surface is this?" decision used by AppLayout (sidebar switch) and
 * Header (LocationSelector / OrgBadge / OrganizationSelector visibility).
 * A bug here would silently render the wrong widgets across the entire
 * app, so the test fixture matrix is exhaustive.
 */
import { describe, it, expect } from 'vitest'
import { detectPanelMode, extractRouteOrgId } from '../panelMode'

describe('detectPanelMode', () => {
  it.each([
    ['/platform',                       'platform'],
    ['/platform/overview',              'platform'],
    ['/platform/organizations',         'platform'],
    ['/platform/organizations/6',       'platform'],
    ['/platform/organizations/6/sub',   'platform'],
    ['/platform/some-future-page',      'platform'],
  ])('platform: %s → %s', (path, expected) => {
    expect(detectPanelMode(path)).toBe(expected)
  })

  it.each([
    ['/app',                          'operations'],
    ['/app/org/6',                    'operations'],
    ['/app/org/6/dashboard',          'operations'],
    ['/app/org/6/devices',            'operations'],
    ['/app/org/6/agents',             'operations'],
    ['/app/org/42/devices',           'operations'],
    ['/app/org/6/devices/123',        'operations'],
  ])('operations: %s → %s', (path, expected) => {
    expect(detectPanelMode(path)).toBe(expected)
  })

  it.each([
    ['/',                  'legacy'],
    ['/dashboard',         'legacy'],
    ['/devices',           'legacy'],
    ['/devices/42',        'legacy'],
    ['/agents',            'legacy'],
    ['/topology',          'legacy'],
    ['/monitor',           'legacy'],
    ['/audit',             'legacy'],
    ['/users',             'legacy'],
    ['/settings',          'legacy'],
    ['/platformish',       'legacy'],  // ← careful: must not match /platform prefix
    ['/applet',            'legacy'],  // ← must not match /app prefix
    ['/app-store',         'legacy'],  // ← must not match /app prefix
  ])('legacy: %s → %s', (path, expected) => {
    expect(detectPanelMode(path)).toBe(expected)
  })
})

describe('extractRouteOrgId', () => {
  it.each([
    ['/app/org/6',                    6],
    ['/app/org/6/',                   6],
    ['/app/org/6/devices',            6],
    ['/app/org/42/devices',           42],
    ['/app/org/123/agents',           123],
    ['/app/org/6/devices/42',         6],
  ])('valid: %s → %s', (path, expected) => {
    expect(extractRouteOrgId(path)).toBe(expected)
  })

  it.each([
    ['/app',                          null],
    ['/app/org',                      null],
    ['/app/org/',                     null],
    ['/app/org/abc',                  null],
    ['/app/org/-1',                   null], // backref: regex requires \d+, negatives reject at the leading -
    ['/app/org/0',                    null], // 0 is not a positive org id
    ['/dashboard',                    null],
    ['/platform/overview',            null],
    ['/',                             null],
  ])('invalid: %s → %s', (path, expected) => {
    expect(extractRouteOrgId(path)).toBe(expected)
  })
})
