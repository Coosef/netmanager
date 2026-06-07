// useNavGroups — Charon menü Faz 3.
//
// Eski 4 nav-group düz liste yapısı kaldırıldı; helper veri katmanından
// (`utils/menuGroups.ts`) 12 ana grup okunur. Sidebar ve TopNav bu hook'a
// güvenir; tek kaynak.
//
// Faz 2 helper'ı (GROUP_DEFINITIONS) saf veri + saf-fonksiyon; bu hook
// React/i18n/auth katmanını birleştirip render'a hazır liste üretir.
import {
  DashboardOutlined, DesktopOutlined, AlertOutlined, BellOutlined,
  SettingOutlined, RobotOutlined, SafetyOutlined, BarChartOutlined,
  ToolOutlined, TeamOutlined, AuditOutlined, GlobalOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'
import { monitorApi } from '@/api/monitor'
import { approvalsApi } from '@/api/approvals'
import {
  GROUP_DEFINITIONS,
  getFirstVisibleTab,
  getVisibleGroups,
  getVisibleTabs,
  type GroupKey,
  type VisibilityContext,
} from '@/utils/menuGroups'

// ─── React hook: VisibilityContext (auth + features) ────────────────────────

/** Helper'lara verilecek minimum context'i auth store + site context'inden
 *  toplar. MenuGroupNav + Sidebar her ikisi de kullanır. */
export function useVisibilityContext(): VisibilityContext {
  const { isSuperAdmin, hasPermission, can } = useAuthStore()
  const { features } = useSite()
  return {
    isSuperAdmin,
    hasPermission,
    can,
    features: (features as Readonly<Record<string, boolean>>) ?? {},
  }
}

// ─── Grup ikonları (React seviyesi; data layer'a katmıyoruz) ────────────────

const GROUP_ICONS: Record<GroupKey, React.ReactNode> = {
  dashboard:      <DashboardOutlined />,
  inventory:      <DesktopOutlined />,
  monitoring:     <AlertOutlined />,
  alerts:         <BellOutlined />,
  config:         <SettingOutlined />,
  automation:     <RobotOutlined />,
  security:       <SafetyOutlined />,
  reports:        <BarChartOutlined />,
  tools:          <ToolOutlined />,
  admin_users:    <TeamOutlined />,
  admin_audit:    <AuditOutlined />,
  admin_platform: <GlobalOutlined />,
}

// ─── Render-ready tipler ────────────────────────────────────────────────────

export interface NavTabItem {
  /** Tab anahtarı — grup içinde benzersiz. */
  key: string
  /** Navigate hedefi (mevcut route, dokunulmaz). */
  route: string
  /** i18n çevirili etiket. */
  label: string
}

export interface NavGroupItem {
  /** Grup anahtarı — pathname matching ve sidebar key olarak kullanılır. */
  groupKey: GroupKey
  /** i18n çevirili grup etiketi. */
  label: string
  /** Sidebar/TopNav ikon. */
  icon: React.ReactNode
  /** Sidebar/TopNav tıklamasında yönlendirme hedefi.
   *  Dashboard için `/`, diğer gruplar için ilk yetkili tab'ın route'u. */
  route: string
  /** Toplam pending/onaylanmamış sayısı; >0 ise sidebar/TopNav rozetinde. */
  badgeCount?: number
  /** Badge stili — crit (kritik) veya warn (uyarı). */
  badgeKind?: 'crit' | 'warn'
  /** TopNav dropdown + MenuGroupNav strip için yetkili tab listesi. */
  tabs: NavTabItem[]
}

// ─── Tek kaynak nav data — Sidebar + TopNav + MenuGroupNav ─────────────────

export function useNavGroups(): NavGroupItem[] {
  const { t } = useTranslation()
  const ctx = useVisibilityContext()

  // Badge query'leri (mevcut davranış korunur). Yetki yoksa 401 döner;
  // sessizce ignore edilir.
  const { data: stats } = useQuery({
    queryKey: ['monitor-stats'],
    queryFn: () => monitorApi.getStats(),
    refetchInterval: 30_000,
  })
  const { data: approvalCount } = useQuery({
    queryKey: ['approval-pending-count'],
    queryFn: approvalsApi.pendingCount,
    refetchInterval: 30_000,
  })
  const unacked = stats?.events_24h?.unacknowledged ?? 0
  const approvals = approvalCount?.count ?? 0

  const visibleGroups = getVisibleGroups(ctx)

  return visibleGroups.map((g): NavGroupItem => {
    const visibleTabs = getVisibleTabs(g, ctx).map((tab) => ({
      key: tab.key,
      route: tab.route,
      label: t(tab.i18nKey),
    }))
    const firstTab = getFirstVisibleTab(g, ctx)
    const targetRoute = g.route ?? firstTab?.route ?? '/'

    // Badge eşlemesi — mevcut iki badge (monitor + approvals) yeni gruplarda
    // korunur. Monitor → İzleme & Analitik grubu; Approvals → Otomasyon &
    // İş Akışları grubu.
    let badgeCount: number | undefined
    let badgeKind: 'crit' | 'warn' | undefined
    if (g.key === 'monitoring' && unacked > 0) {
      badgeCount = unacked
      badgeKind = 'crit'
    } else if (g.key === 'automation' && approvals > 0) {
      badgeCount = approvals
      badgeKind = 'warn'
    }

    return {
      groupKey: g.key,
      label: t(g.i18nKey),
      icon: GROUP_ICONS[g.key],
      route: targetRoute,
      badgeCount,
      badgeKind,
      tabs: visibleTabs,
    }
  })
}

// Backward-compat: bazı eski test/komponent'ler GROUP_DEFINITIONS sayısına
// erişmek isteyebilir. Faz 3 sonrası kaldırılmaya aday.
export const __TOTAL_GROUPS = GROUP_DEFINITIONS.length
