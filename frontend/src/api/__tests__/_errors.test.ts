/**
 * HF#9 — formatApiError unit testleri.
 * RCA: Pydantic v2 422 detail array'i React render'ında object child olarak
 * geçince "Minified React error #31" tetikleniyor. Bu helper detayı her
 * formatta string'e normalize eder.
 */
import { describe, it, expect } from 'vitest'
import { formatApiError } from '../_errors'

describe('formatApiError', () => {
  it('returns fallback when no detail present', () => {
    expect(formatApiError({}, 'fallback')).toBe('fallback')
    expect(formatApiError({ response: {} }, 'fallback')).toBe('fallback')
    expect(formatApiError({ response: { data: {} } }, 'fallback')).toBe('fallback')
    expect(formatApiError(null, 'fallback')).toBe('fallback')
    expect(formatApiError(undefined, 'fallback')).toBe('fallback')
  })

  it('returns string detail as-is', () => {
    const err = { response: { data: { detail: 'IP already exists' } } }
    expect(formatApiError(err, 'fallback')).toBe('IP already exists')
  })

  it('formats Pydantic v2 array detail into readable joined string', () => {
    // Gerçek FastAPI 422 örneği — HF#9 RCA'nın merkezindeki vaka
    const err = {
      response: {
        data: {
          detail: [
            {
              type: 'missing',
              loc: ['body', 'ssh_username'],
              msg: 'Field required',
              input: { ip_address: '10.0.0.1' },
            },
            {
              type: 'missing',
              loc: ['body', 'ssh_password'],
              msg: 'Field required',
              input: { ip_address: '10.0.0.1' },
            },
          ],
        },
      },
    }
    const result = formatApiError(err, 'fallback')
    expect(result).toContain('ssh_username: Field required')
    expect(result).toContain('ssh_password: Field required')
    expect(result).toContain(';')
    // En önemli — React #31 koruması: result string olmalı, object değil
    expect(typeof result).toBe('string')
  })

  it('falls back to JSON.stringify for non-array object detail', () => {
    const err = { response: { data: { detail: { code: 'X', extra: 1 } } } }
    const result = formatApiError(err, 'fallback')
    expect(typeof result).toBe('string')
    expect(result).toContain('code')
    expect(result).toContain('"X"')
  })

  it('handles array with mixed string + object entries', () => {
    const err = {
      response: {
        data: {
          detail: [
            'sade hata mesajı',
            { type: 'value_error', loc: ['body', 'ip'], msg: 'invalid format' },
          ],
        },
      },
    }
    const result = formatApiError(err, 'fallback')
    expect(result).toContain('sade hata mesajı')
    expect(result).toContain('ip: invalid format')
    expect(result).toContain(';')
  })

  it('handles object detail with no msg/loc gracefully', () => {
    const err = { response: { data: { detail: [{ random: 'field' }] } } }
    const result = formatApiError(err, 'fallback')
    expect(typeof result).toBe('string')
    // ya JSON.stringify ya fallback olabilir; her ikisi de "string"
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns fallback for empty array detail', () => {
    const err = { response: { data: { detail: [] } } }
    expect(formatApiError(err, 'fallback')).toBe('fallback')
  })
})
