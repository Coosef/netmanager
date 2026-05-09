/**
 * Safely extract a display string from any API/Axios error.
 *
 * FastAPI returns validation failures as:
 *   { detail: [ { type, loc, msg, input }, ... ] }   ← Pydantic v2
 * or plain strings:
 *   { detail: "Some message" }
 *
 * Passing a Pydantic error array directly to message.error() causes React to
 * crash ("Objects are not valid as a React child"), so we always stringify.
 */
export function apiErr(err: unknown, fallback = 'Bir hata oluştu'): string {
  const detail = (err as any)?.response?.data?.detail
  if (!detail) return fallback
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((e: any) => (typeof e === 'string' ? e : e?.msg ?? JSON.stringify(e)))
      .join(', ')
  }
  return fallback
}
