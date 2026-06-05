import { Select, Space, Spin, Tag, Tooltip } from 'antd'
import { EnvironmentOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useSite } from '@/contexts/SiteContext'
import { useTheme } from '@/contexts/ThemeContext'

const ALL = '__all__'

/**
 * Faz 8 Phase F — the active-location selector.
 *
 * Backend-driven: the option list is exactly the locations the backend
 * returns for the authenticated user (user_locations source of truth —
 * Phase E). There is intentionally NO organization selector — a normal
 * user's organization is fixed server-side by their token and is never
 * switchable from the UI.
 *
 *   * still resolving        → a spinner;
 *   * no accessible location → a muted, non-interactive tag;
 *   * exactly one location   → shown as static text (no switching UX);
 *   * many locations         → a switcher;
 *   * org-wide roles         → additionally an explicit "Tüm Lokasyonlar"
 *                              (all locations) option — never a fallback.
 *
 * Switching calls SiteContext.setLocation, which clears the React Query
 * cache and rebinds live streams so no previous-location data leaks.
 */
export default function LocationSelector({ isMobile }: { isMobile?: boolean }) {
  const {
    activeLocationId, setLocation, locations,
    sitesLoading, hasLocationAccess, isOrgWide,
  } = useSite()
  const { isDark } = useTheme()
  const { t } = useTranslation()

  if (sitesLoading) {
    return <Spin size="small" />
  }

  if (!hasLocationAccess) {
    return (
      <Tooltip title={t('location_selector.no_access_tooltip')}>
        <Tag icon={<EnvironmentOutlined />} color="warning" style={{ margin: 0 }}>
          {t('location_selector.no_access_tag')}
        </Tag>
      </Tooltip>
    )
  }

  const active = locations.find((l) => l.id === activeLocationId)
  const dot = (color?: string | null) => (
    <span
      style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color || '#3b82f6',
        display: 'inline-block', flexShrink: 0,
      }}
    />
  )

  // Single fixed location for a location-scoped user — show it, no switcher.
  if (locations.length === 1 && !isOrgWide) {
    const only = locations[0]
    return (
      <Space size={6}>
        {dot(only.color)}
        <span style={{ fontSize: 13, color: isDark ? '#cbd5e1' : '#334155' }}>
          {only.name}
        </span>
      </Space>
    )
  }

  // Org-wide user whose org has no locations yet — nothing to switch.
  if (locations.length === 0) {
    return (
      <Tag color="default" style={{ margin: 0 }}>
        {t('location_selector.none_defined')}
      </Tag>
    )
  }

  const options = [
    // "All locations" is offered ONLY to org-wide roles; a location-scoped
    // user always operates inside exactly one location.
    ...(isOrgWide ? [{ value: ALL, label: t('location_selector.all_locations') }] : []),
    ...locations.map((loc) => ({
      value: String(loc.id),
      label: (
        <Space size={6}>
          {dot(loc.color)}
          {loc.name}
        </Space>
      ),
    })),
  ]

  return (
    <Space size={6}>
      {dot(active?.color)}
      <Select
        value={activeLocationId != null ? String(activeLocationId) : ALL}
        onChange={(v) => setLocation(v === ALL ? null : Number(v))}
        options={options}
        size="small"
        variant="borderless"
        popupMatchSelectWidth={false}
        style={{
          width: isMobile ? 124 : 168,
          background: activeLocationId != null
            ? (isDark ? '#0c2040' : '#e0f0ff')
            : 'transparent',
          borderRadius: 6,
        }}
      />
    </Space>
  )
}
