import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import tr from './locales/tr.json'
import en from './locales/en.json'
import ru from './locales/ru.json'
import de from './locales/de.json'

const saved = localStorage.getItem('nm-lang') || 'tr'

i18n
  .use(initReactI18next)
  .init({
    resources: {
      tr: { translation: tr },
      en: { translation: en },
      ru: { translation: ru },
      de: { translation: de },
    },
    lng: saved,
    fallbackLng: 'tr',
    interpolation: { escapeValue: false },
  })

export default i18n
