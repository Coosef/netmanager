import { Dropdown, Space, Tag, Typography } from 'antd'
import {
  ApartmentOutlined,
  CaretDownOutlined,
  AppstoreOutlined,
  SwapOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useSite } from '@/contexts/SiteContext'
import { useTheme } from '@/contexts/ThemeContext'

/**
 * PR-A — OrgBadge.
 *
 * The org indicator rendered in the Header when the user is inside
 * `/app/org/:organizationId/*`. Replaces the OrganizationSelector
 * dropdown in that shell — the URL is now authoritative for the org
 * context, so a free-form switcher would be a footgun.
 *
 * Two variants by role:
 *
 *   - Super-admin → dropdown with three actions:
 *       1. Firma değiştir   → navigate /platform/organizations
 *       2. Platform Yönetimi → navigate /platform/overview
 *       3. Bu firmanın detayları → navigate /platform/organizations/:id
 *
 *   - Normal user → read-only badge. No dropdown — their tenant is
 *     fixed by the JWT and any "switcher" would imply switchability
 *     that does not exist for them.
 */
export default function OrgBadge() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams<{ organizationId?: string }>()
  const { organization, isPlatformSuperAdmin } = useSite()
  const { isDark } = useTheme()

  const routeOrgId = params.organizationId ? Number(params.organizationId) : null
  const displayName = organization?.name ?? t('operations.org_badge_loading')

  const badge = (
    <Space
      size={6}
      data-testid="org-badge"
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        background: isDark ? '#0c2040' : '#e0f0ff',
        cursor: isPlatformSuperAdmin ? 'pointer' : 'default',
      }}
    >
      <ApartmentOutlined style={{ fontSize: 13 }} />
      <Typography.Text style={{ fontSize: 13, fontWeight: 600 }}>{displayName}</Typography.Text>
      {!isPlatformSuperAdmin && (
        <Tag color="default" style={{ fontSize: 10, marginLeft: 4 }}>
          {t('operations.org_badge_readonly')}
        </Tag>
      )}
      {isPlatformSuperAdmin && (
        <CaretDownOutlined style={{ fontSize: 10, opacity: 0.7 }} />
      )}
    </Space>
  )

  if (!isPlatformSuperAdmin) {
    return badge
  }

  const menuItems = [
    {
      key: 'switch_org',
      icon: <SwapOutlined />,
      label: t('operations.org_badge_action_switch_org'),
      onClick: () => navigate('/platform/organizations'),
    },
    {
      key: 'platform_admin',
      icon: <AppstoreOutlined />,
      label: t('operations.org_badge_action_platform_admin'),
      onClick: () => navigate('/platform/overview'),
    },
    ...(routeOrgId
      ? [
          {
            key: 'org_detail',
            icon: <InfoCircleOutlined />,
            label: t('operations.org_badge_action_org_detail'),
            onClick: () => navigate(`/platform/organizations/${routeOrgId}`),
          },
        ]
      : []),
  ]

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomLeft">
      {badge}
    </Dropdown>
  )
}
