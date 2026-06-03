/**
 * HF#9 (2026-06-03) — Backend error detail'i AntD message/notification için
 * string'e normalize eder. FastAPI 422 ValidationError detail bir ARRAY of
 * objects (`[{ type, loc, msg, input }]`) olarak gelir; bunu AntD message.error
 * gibi React render'ına doğrudan vermek "Minified React error #31 — Objects
 * are not valid as a React child" crash'ini tetikler.
 *
 * Kullanım:
 *   onError: (err) => message.error(formatApiError(err, 'Default mesaj'))
 *   catch (err) { msg.error(formatApiError(err, 'Default')) }
 *
 * Davranış:
 *   - string detail  → aynen döndürür
 *   - Pydantic array → "loc: msg; loc: msg" şeklinde join
 *   - object detail  → JSON.stringify fallback (son çare)
 *   - hiç detail yok → fallback metni
 */
export function formatApiError(err: any, fallback: string): string {
  const detail = err?.response?.data?.detail
  if (detail == null) return fallback

  if (typeof detail === 'string') return detail || fallback

  if (Array.isArray(detail)) {
    const parts = detail
      .map((d: any): string => {
        if (typeof d === 'string') return d
        if (d && typeof d === 'object') {
          // Pydantic v2: { type, loc, msg, input }
          // loc array — ilk eleman genelde "body"; ondan sonrasını alan adı
          const loc = Array.isArray(d.loc) ? d.loc.slice(1).join('.') : ''
          const msg = typeof d.msg === 'string' ? d.msg : ''
          if (loc && msg) return `${loc}: ${msg}`
          return msg || loc || JSON.stringify(d)
        }
        return String(d)
      })
      .filter(Boolean)
    return parts.length > 0 ? parts.join('; ') : fallback
  }

  if (typeof detail === 'object') {
    try {
      return JSON.stringify(detail)
    } catch {
      return fallback
    }
  }

  return String(detail) || fallback
}
