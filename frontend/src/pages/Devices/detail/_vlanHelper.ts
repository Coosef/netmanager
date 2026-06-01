/**
 * T10 C7 Dalga 1 RED-fix — VLAN list parser (trunk "Allowed VLANs" alanı için).
 *
 * Cisco-vari kullanıcı girdisini int listesine çevirir:
 *   "1,10,20-30,100"  →  [1, 10, 20, 21, …, 30, 100]
 *   "  2400 , 2410-2415 "  →  [2400, 2410, 2411, 2412, 2413, 2414, 2415]
 *
 * Geçersiz token bulursa Error fırlatır (form validation tetikleyici).
 * 1-4094 dışı VLAN, ters aralık veya non-numeric token reddedilir.
 * Sonuç dedupe + sıralı (Backend Cisco/Ruijie command builder virgülle birleştirir;
 * dedupe + sıra deterministik komut için faydalı).
 */
export class VlanListError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VlanListError'
  }
}

export function parseVlanList(input: string): number[] {
  if (!input || !input.trim()) {
    throw new VlanListError('VLAN listesi boş olamaz')
  }
  const out = new Set<number>()
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean)
  for (const part of parts) {
    const rng = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (rng) {
      const start = parseInt(rng[1], 10)
      const end = parseInt(rng[2], 10)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new VlanListError(`Geçersiz aralık: "${part}"`)
      }
      if (start < 1 || end > 4094) {
        throw new VlanListError(`Aralık 1-4094 dışında: "${part}"`)
      }
      if (start > end) {
        throw new VlanListError(`Ters aralık (start > end): "${part}"`)
      }
      // Aşırı büyük aralık (örn. tüm 4094) DoS olmaz ama yavaş olabilir; pratik limit.
      if (end - start > 1000) {
        throw new VlanListError(`Aralık çok geniş (>1000 VLAN): "${part}"`)
      }
      for (let v = start; v <= end; v++) out.add(v)
    } else if (/^\d+$/.test(part)) {
      const v = parseInt(part, 10)
      if (v < 1 || v > 4094) {
        throw new VlanListError(`VLAN 1-4094 dışında: ${v}`)
      }
      out.add(v)
    } else {
      throw new VlanListError(`Geçersiz token: "${part}"`)
    }
  }
  if (out.size === 0) {
    throw new VlanListError('VLAN listesi boş olamaz')
  }
  return Array.from(out).sort((a, b) => a - b)
}

/** Sayı listesini kullanıcı dostu kısa hâle çevirir (boş ise '—'). */
export function formatVlanList(ids: number[]): string {
  if (!ids.length) return '—'
  return ids.slice(0, 12).join(', ') + (ids.length > 12 ? ` … (+${ids.length - 12})` : '')
}
