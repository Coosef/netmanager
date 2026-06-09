import { Link } from 'react-router-dom'
import { Tooltip, Typography } from 'antd'
import {
  DesktopOutlined,
  UserOutlined,
  CloudServerOutlined,
  GlobalOutlined,
  SafetyOutlined,
  CodeOutlined,
  HddOutlined,
  TeamOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  TagOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import {
  resolveResourceRoute,
  isKnownResourceType,
  type ResourceIconName,
} from './auditResourceRoutes'

const { Text } = Typography

/**
 * Audit Log v2 PR 3 — Resource link component.
 *
 * 4 render senaryosu:
 *   1. type yok                       → "—"
 *   2. type var, route YOK            → düz text + tooltip "Detay sayfası yok"
 *   3. type+route var, yetki YOK      → düz text + tooltip "Erişim yetkisi yok"
 *   4. type+route+yetki + id (zorunlu) → <Link to={path}> tıklanabilir
 *
 * Permission: useAuthStore().can(module, action). PR 1+2 davranışı
 * korunur — yalnız Kaynak alanı bu component'le sarılır.
 */

type Props = {
  type?: string | null
  id?: string | null
  name?: string | null
  /** Compact: tablo içi küçük chip; drawer'da false (varsayılan) */
  compact?: boolean
}

const ICON_MAP: Record<ResourceIconName, React.ReactNode> = {
  device:    <DesktopOutlined />,
  user:      <UserOutlined />,
  task:      <PlayCircleOutlined />,
  agent:     <CloudServerOutlined />,
  ipam:      <GlobalOutlined />,
  security:  <SafetyOutlined />,
  terminal:  <CodeOutlined />,
  lifecycle: <HddOutlined />,
  org:       <TeamOutlined />,
  template:  <FileTextOutlined />,
  unknown:   <TagOutlined />,
}

export default function AuditResourceLink({ type, id, name, compact }: Props) {
  const { t } = useTranslation()
  const can = useAuthStore((s) => s.can)

  // ── 1. type yok → "—" ─────────────────────────────────────────────────
  if (!type) {
    return (
      <Text data-testid="audit-resource-link-empty" style={{ color: 'var(--fg-3)' }}>
        —
      </Text>
    )
  }

  const route = resolveResourceRoute(type, id)
  const display = name || id || type
  const typeLabel = String(type)

  // ── 2. route yok → düz text + tooltip "Detay sayfası yok" ───────────
  if (!route) {
    // map'te tanımlı değil mi yoksa id eksik mi ayrıştır — tooltip metni
    // farklı olabilir, ama UX'i basit tutmak için tek tooltip
    const tipKey = isKnownResourceType(type)
      ? 'audit.resource.no_id_for_detail'  // map var ama id eksik
      : 'audit.resource.no_route'           // map'te yok

    return (
      <Tooltip title={t(tipKey)}>
        <Text
          data-testid="audit-resource-link-noroute"
          data-resource-type={typeLabel}
          style={{
            fontSize: compact ? 12 : 13,
            color: 'var(--fg-2)',
            cursor: 'help',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: compact ? 200 : 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <TagOutlined style={{ fontSize: compact ? 10 : 12, color: 'var(--fg-3)' }} />
          <span style={{ fontFamily: 'monospace' }}>{typeLabel}</span>
          <span style={{ color: 'var(--fg-3)' }}>/</span>
          <span>{display}</span>
        </Text>
      </Tooltip>
    )
  }

  // ── 3. route var, yetki YOK → düz text + tooltip "Erişim yetkisi yok" ──
  const hasPermission = can(route.module, route.action)
  if (!hasPermission) {
    return (
      <Tooltip title={t('audit.resource.no_permission')}>
        <Text
          data-testid="audit-resource-link-noperm"
          data-resource-type={typeLabel}
          style={{
            fontSize: compact ? 12 : 13,
            color: 'var(--fg-2)',
            cursor: 'not-allowed',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            maxWidth: compact ? 200 : 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {ICON_MAP[route.icon]}
          <span>{display}</span>
        </Text>
      </Tooltip>
    )
  }

  // ── 4. Tam link ───────────────────────────────────────────────────────
  return (
    <Link
      to={route.path}
      data-testid="audit-resource-link"
      data-resource-type={typeLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: compact ? 12 : 13,
        maxWidth: compact ? 220 : 360,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {ICON_MAP[route.icon]}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{display}</span>
    </Link>
  )
}
