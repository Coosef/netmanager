// LANG-INFRA — dayjs locale side-effect import registry.
//
// dayjs locale paketleri side-effect olarak kaydolur (import edildiklerinde
// global dayjs registry'sine eklenirler). Dil değişiminde `dayjs.locale(code)`
// çağrısı bu paketlerden okur.
//
// Yeni dil eklemek için:
//   1. Aşağıya `import 'dayjs/locale/<code>'` satırı ekle (alfabetik).
//   2. SUPPORTED_DAYJS_LOCALES listesine kodu ekle.
//   3. (`i18n/antdLocales.ts` + `locales/<code>.json` de eklemeyi unutma.)
//
// Component/page dosyalarına DOKUNULMAZ.
import 'dayjs/locale/tr'
import 'dayjs/locale/en'
import 'dayjs/locale/de'
import 'dayjs/locale/ru'

export const SUPPORTED_DAYJS_LOCALES = ['tr', 'en', 'de', 'ru'] as const
