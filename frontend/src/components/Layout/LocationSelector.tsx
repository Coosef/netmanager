import { Select, Space, Spin, Tag, Tooltip } from 'antd'
import { EnvironmentOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useSite } from '@/contexts/SiteContext'
import { useTheme } from '@/contexts/ThemeContext'

const ALL = '__all__'

/**
 * Faz 8 Phase F + PR #96 — the active-location selector.
 *
 * Backend-driven: the option list is exactly the locations the backend
 * returns for the authenticated user (user_locations source of truth —
 * Phase E). There is intentionally NO organization selector — a normal
 * user's organization is fixed server-side by their token and is never
 * switchable from the UI.
 *
 * Seven distinct visual states, in priority order:
 *
 *   1. `sitesLoading`        → spinner    ("Lokasyonlar yükleniyor…")
 *   2. `hasContextFailure`   → error tag  ("Lokasyonlar yüklenemedi")
 *   3. super-admin + no tenant
 *                            → tenant-required tag
 *                              ("Önce firma seçin")
 *   4. `!hasLocationAccess`  → no-access tag (existing)
 *   5. `locations.length === 0` AND in a tenant
 *                            → no-assigned tag
 *                              ("Atanmış lokasyon yok")
 *   6. exactly one location  → static text (no switcher)
 *   7. many locations        → switcher; org-wide roles get an
 *                              "Tüm Lokasyonlar" option in addition.
 *
 * The retired `none_defined` ("No location defined") tag is no longer
 * surfaced to end users — it conflated three semantically-different
 * conditions (super-admin no tenant / scoped user no membership /
 * tenant has no locations yet). The i18n key is kept in the locale
 * files for one release for back-compat but no code path renders it.
 *
 * Switching calls SiteContext.setLocation, which clears the React Query
 * cache and rebinds live streams so no previous-location data leaks.
 */
export default function LocationSelector({ isMobile }: { isMobile?: boolean }) {
  const {
    activeLocationId, setLocation, locations,
    sitesLoading, hasContextFailure,
    hasLocationAccess, isOrgWide,
    isSuperAdmin, organization,
  } = useSite()
  const { isDark } = useTheme()
  const { t } = useTranslation()

  // (1) Still resolving — backend has not returned yet.
  if (sitesLoading) {
    return (
      <Space size={6} data-testid="location-selector-loading">
        <Spin size="small" />
        <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
          {t('location_selector.loading')}
        </span>
      </Space>
    )
  }

  // (2) Backend / API error — the location list could not be fetched.
  if (hasContextFailure) {
    return (
      <Tooltip title={t('location_selector.error_tooltip')}>
        <Tag icon={<EnvironmentOutlined />} color="error" style={{ margin: 0 }}
          data-testid="location-selector-error">
          {t('location_selector.error_tag')}
        </Tag>
      </Tooltip>
    )
  }

  // (3) Super-admin who hasn't yet selected a tenant context. Distinct
  // from the legacy `none_defined` tag — "select a tenant first" tells
  // the operator what to do next, instead of stating a technical fact.
  if (isSuperAdmin && organization === null) {
    return (
      <Tooltip title={t('location_selector.tenant_required_tooltip')}>
        <Tag icon={<EnvironmentOutlined />} color="processing" style={{ margin: 0 }}
          data-testid="location-selector-tenant-required">
          {t('location_selector.tenant_required_tag')}
        </Tag>
      </Tooltip>
    )
  }

  // (4) Scoped user with no usable location (existing Faz 8 Phase E
  // contract — backend explicitly returns has_location_access=false).
  if (!hasLocationAccess) {
    return (
      <Tooltip title={t('location_selector.no_access_tooltip')}>
        <Tag icon={<EnvironmentOutlined />} color="warning" style={{ margin: 0 }}
          data-testid="location-selector-no-access">
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

  // (5) Tenant context is set but no locations come back from
  // /context/current. Distinct from (4): (4) is "your account is
  // unassigned", (5) is "the tenant has nothing to show you yet".
  //
  // Super-admins are not "assigned" to locations the way a
  // location-scoped user is — their reach is the platform. Surfacing
  // an alarming "No assigned location" tag to a super-admin who has
  // just opened the panel is misleading (the screen behind it still
  // shows real data via the unscoped `/locations/` endpoint). Fall
  // back to the neutral "All locations" indicator for that role.
  if (locations.length === 0) {
    if (isSuperAdmin) {
      return (
        <Tag color="default" style={{ margin: 0 }}
          data-testid="location-selector-super-admin-empty">
          {t('location_selector.all_locations')}
        </Tag>
      )
    }
    return (
      <Tooltip title={t('location_selector.no_access_tooltip')}>
        <Tag icon={<EnvironmentOutlined />} color="warning" style={{ margin: 0 }}
          data-testid="location-selector-no-assigned">
          {t('location_selector.no_assigned_tag')}
        </Tag>
      </Tooltip>
    )
  }

  // (6) Single fixed location for a location-scoped user — show it,
  // no switcher.
  if (locations.length === 1 && !isOrgWide) {
    const only = locations[0]
    return (
      <Space size={6} data-testid="location-selector-single">
        {dot(only.color)}
        <span style={{ fontSize: 13, color: isDark ? '#cbd5e1' : '#334155' }}>
          {only.name}
        </span>
      </Space>
    )
  }

  // (7) Multi-location switcher. Org-wide roles additionally get the
  // explicit "All locations" option — it's NEVER a silent fallback.
  const options = [
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
    <Space size={6} data-testid="location-selector-multi">
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
