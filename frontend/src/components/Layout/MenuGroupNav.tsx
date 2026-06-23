// MenuGroupNav — Charon Faz 3 yeni component.
//
// Sayfa içerik alanının üstüne aktif ana grubun yatay tab strip'ini render
// eder. PR-A2 öncesi yalnız legacy route'larda görünürdü; PR-A2 ile
// operations panel `/app/org/:organizationId/*` altında da render edilir
// ve tab tıklamaları operations URL'sini korur (URL-authoritative
// cache bridge bozulmaz).
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
  prefixRouteForOperations,
} from '@/utils/menuGroups'
import { useRouteOrgId } from '@/hooks/useRouteOrgId'
import { useVisibilityContext } from './useNavGroups'

export default function MenuGroupNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const ctx = useVisibilityContext()
  // PR-A2 — when inside /app/org/:id/*, derive the logical pathname by
  // stripping the operations prefix so getActiveGroup matches the same
  // legacy GroupKey it would for the bare /devices, /topology, etc. The
  // tab.route navigation target is then re-prefixed before navigate so
  // the URL-authoritative cache bridge in OrgRouteShell stays intact.
  const routeOrgId = useRouteOrgId()
  const opsPrefix = routeOrgId != null ? `/app/org/${routeOrgId}` : ''
  const logicalPathname = opsPrefix && location.pathname.startsWith(opsPrefix + '/')
    ? location.pathname.slice(opsPrefix.length) || '/'
    : location.pathname

  const groupKey = getActiveGroup(logicalPathname)
  if (!groupKey) return null

  const group = GROUP_BY_KEY[groupKey]
  if (group.tabs.length === 0) return null   // Dashboard

  const visibleTabs = getVisibleTabs(group, ctx)
  if (visibleTabs.length === 0) return null  // hiç yetkili tab yok

  return (
    <nav className="nm-mg-nav" role="tablist" aria-label={t(group.i18nKey)}>
      {visibleTabs.map((tab) => {
        const targetRoute = prefixRouteForOperations(tab.route, routeOrgId)
        const active = location.pathname === targetRoute ||
          (targetRoute !== '/' && location.pathname.startsWith(targetRoute + '/'))
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active}
            className={`nm-mg-tab ${active ? 'active' : ''}`}
            onClick={() => navigate(targetRoute)}
            data-tab-route={targetRoute}
          >
            {t(tab.i18nKey)}
          </button>
        )
      })}
    </nav>
  )
}
