// T9 follow-up — Dil dosyaları otomatik keşif (Vite import.meta.glob).
// LANG-INFRA — AntD + dayjs locale yönetimi merkezi i18n modülüne taşındı;
// dil değişiminde her ikisi de otomatik switch eder. Component/page/App.tsx
// dosyalarına dokunmak gerekmez; sözleşme `i18n/` klasörüdür.
//
// Yeni dil eklemek için:
//   1. `src/i18n/locales/<kod>.json` dosyasını oluştur (mevcut bir dili
//      kopyala ve içindeki değerleri çevir).
//   2. JSON'un başına şu meta-bloğunu koy (UI'da listeleme için):
//        "__meta": { "name": "Español", "flag": "🇪🇸", "region": "España" }
//   3. `src/i18n/antdLocales.ts` içine satır ekle.
//   4. `src/i18n/dayjsLocales.ts` içine `import 'dayjs/locale/<kod>'` ekle.
//   5. `pnpm i18n:check` ile parity'yi doğrula.
//   6. Frontend'i yenile — yeni dil otomatik üst menüye düşer.
//
// `__meta` yoksa kod büyük harfle gösterilir (örn. "ES").
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import dayjs from 'dayjs'
// LANG-INFRA: dayjs locale paketleri side-effect kayıt — `dayjs.locale(code)`
// bunlardan okur. Import yan etkisi olduğu için kullanılmasa bile silinmemeli.
import './dayjsLocales'

// Vite eager-import: locales/ klasörünün ALTINDAKİ tüm .json dosyalarını
// build-time'da toplar; manuel import gerekmez.
const modules = import.meta.glob('./locales/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>

export interface LanguageMeta {
  code: string
  name: string
  flag?: string
  region?: string
}

const resources: Record<string, { translation: Record<string, unknown> }> = {}
const _available: LanguageMeta[] = []

for (const path in modules) {
  const code = path.replace('./locales/', '').replace('.json', '')
  const data = modules[path] ?? {}
  resources[code] = { translation: data }
  const meta = (data['__meta'] as Record<string, string> | undefined) ?? {}
  _available.push({
    code,
    name: meta.name || code.toUpperCase(),
    flag: meta.flag,
    region: meta.region,
  })
}
// Türkçe önce (default), sonra alfabetik
_available.sort((a, b) => {
  if (a.code === 'tr') return -1
  if (b.code === 'tr') return 1
  return a.name.localeCompare(b.name)
})

export const availableLanguages: LanguageMeta[] = _available

const saved = localStorage.getItem('nm-lang') || 'tr'
const initialLng = resources[saved] ? saved : (resources.tr ? 'tr' : Object.keys(resources)[0])

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLng,
    fallbackLng: 'tr',
    interpolation: { escapeValue: false },
  })

// LANG-INFRA: dayjs locale init'le senkron + her dil değişiminde otomatik
// güncellenir. Önceden App.tsx'te `dayjs.locale('tr')` sabitlenmişti.
dayjs.locale(initialLng)
i18n.on('languageChanged', (lng) => {
  dayjs.locale(lng)
})

// LANG-INFRA: AntD locale erişimi tek noktadan — App.tsx ConfigProvider
// `getAntdLocale(i18n.language)` ile besler. Yeni dil için App.tsx
// dokunulmaz.
export { getAntdLocale } from './antdLocales'

export default i18n
