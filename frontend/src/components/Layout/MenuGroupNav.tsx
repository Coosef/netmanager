// MenuGroupNav — Charon Faz 3 yeni component.
//
// Sayfa içerik alanının üstüne aktif ana grubun yatay tab strip'ini render
// eder. Plan A gereği URL değişmiyor; tab'lar mevcut route'lara navigate.
//
// Görünürlük koşulları:
//   · Aktif grup belirlenebilmeli (getActiveGroup(pathname) !== null)
//   · Grupta en az 1 yetkili tab olmalı
//   · Dashboard (tek sayfa) için strip render edilmez
//
// RBAC: kullanıcının yetkisi olmayan tab'lar görünmez.
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  GROUP_BY_KEY,
  getActiveGroup,
  getVisibleTabs,
} from '@/utils/menuGroups'
import { useVisibilityContext } from './useNavGroups'

export default function MenuGroupNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const ctx = useVisibilityContext()

  const groupKey = getActiveGroup(location.pathname)
  if (!groupKey) return null

  const group = GROUP_BY_KEY[groupKey]
  if (group.tabs.length === 0) return null   // Dashboard

  const visibleTabs = getVisibleTabs(group, ctx)
  if (visibleTabs.length === 0) return null  // hiç yetkili tab yok

  return (
    <nav className="nm-mg-nav" role="tablist" aria-label={t(group.i18nKey)}>
      {visibleTabs.map((tab) => {
        const active = location.pathname === tab.route ||
          (tab.route !== '/' && location.pathname.startsWith(tab.route + '/'))
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active}
            className={`nm-mg-tab ${active ? 'active' : ''}`}
            onClick={() => navigate(tab.route)}
          >
            {t(tab.i18nKey)}
          </button>
        )
      })}
    </nav>
  )
}
