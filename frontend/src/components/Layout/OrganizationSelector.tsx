import { Select, Space, Tag, Tooltip } from 'antd'
import { ApartmentOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useSite } from '@/contexts/SiteContext'
import { useTheme } from '@/contexts/ThemeContext'
import { organizationsApi } from '@/api/organizations'

/**
 * PLATFORM/OPERATIONS-PHASE1A (2026-06-22) — the super-admin
 * Organization Switcher. Mounted in `Header.tsx` between the menu
 * group nav and the `LocationSelector`.
 *
 * Visibility rules:
 *   1. Renders ONLY when `useSite().isSuperAdmin === true`. For normal
 *      users the widget returns `null` — their tenant is fixed
 *      server-side by their JWT and any client-side switcher would be
 *      misleading at best, a footgun at worst.
 *   2. While the context is still resolving (`ctxResolved === false`),
 *      the widget renders a tiny placeholder to avoid the same
 *      hydration-window flicker PR #103 closed for the location
 *      selector.
 *
 * Switch semantics:
 *   - `onChange` calls `useSite().setOrganization(orgId | null)`.
 *   - That writes localStorage[`nm-active-org-id`], clears the
 *     active location, and `invalidateQueries()`s the cache.
 *   - The Axios interceptor (`api/client.ts`) then attaches
 *     `X-Org-Id` to every subsequent request and the backend
 *     `resolve_location_context` drops the super-admin RLS bypass and
 *     scopes into that tenant.
 *
 * "Platform Mode" option:
 *   - Value `null` (rendered as the trailing option in the dropdown)
 *     clears the active org and removes the localStorage key. The
 *     backend then sees no X-Org-Id from the client and the
 *     super-admin RLS bypass takes effect again — useful for
 *     platform-admin operations (audit log filter "All tenants",
 *     global health, license overview).
 */
export default function OrganizationSelector() {
  const { isSuperAdmin, activeOrgId, setOrganization, ctxResolved } = useSite()
  const { isDark } = useTheme()
  const { t } = useTranslation()

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: organizationsApi.list,
    staleTime: 60_000,
    enabled: isSuperAdmin && ctxResolved,
  })

  // Non-super-admin (normal user): the tenant is fixed by JWT. Render
  // nothing — the user sees only their home org's data and any client-
  // side switcher would imply switchability that does not exist for
  // them.
  if (!isSuperAdmin) return null

  // Hydration window — keep the slot reserved so the surrounding
  // header layout does not jump when ctx finally resolves.
  if (!ctxResolved) {
    return (
      <Space size={6} data-testid="org-selector-loading">
        <ApartmentOutlined style={{ color: isDark ? '#94a3b8' : '#64748b', fontSize: 14 }} />
        <span style={{ fontSize: 12, color: isDark ? '#94a3b8' : '#64748b' }}>
          {t('org_selector.loading')}
        </span>
      </Space>
    )
  }

  // Backend API failure — surface a discrete error tag without
  // breaking the header layout.
  if (!isLoading && orgs.length === 0) {
    return (
      <Tooltip title={t('org_selector.empty_tooltip')}>
        <Tag color="default" data-testid="org-selector-empty">
          <ApartmentOutlined /> {t('org_selector.empty_tag')}
        </Tag>
      </Tooltip>
    )
  }

  const PLATFORM_MODE = '__platform__'

  const options = [
    ...orgs.map((o) => ({
      value: String(o.id),
      label: (
        <Space size={6}>
          <ApartmentOutlined />
          <span>{o.name}</span>
          {!o.is_active && (
            <Tag color="warning" style={{ fontSize: 10, marginLeft: 4 }}>
              {t('org_selector.inactive_badge')}
            </Tag>
          )}
        </Space>
      ),
    })),
    {
      value: PLATFORM_MODE,
      label: (
        <Space size={6}>
          <ApartmentOutlined style={{ color: '#94a3b8' }} />
          <span style={{ color: '#94a3b8' }}>
            {t('org_selector.platform_mode')}
          </span>
        </Space>
      ),
    },
  ]

  return (
    <Space size={6} data-testid="org-selector">
      <Select
        value={activeOrgId != null ? String(activeOrgId) : PLATFORM_MODE}
        onChange={(v) => setOrganization(v === PLATFORM_MODE ? null : Number(v))}
        options={options}
        size="small"
        variant="borderless"
        popupMatchSelectWidth={false}
        style={{
          width: 180,
          background: activeOrgId != null
            ? (isDark ? '#0c2040' : '#e0f0ff')
            : 'transparent',
          borderRadius: 6,
        }}
        data-testid="org-selector-select"
      />
    </Space>
  )
}
