import { useQuery } from '@tanstack/react-query'
import { Button, Card, Col, Descriptions, Row, Space, Tag, Typography, Alert, Skeleton } from 'antd'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  LoginOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { organizationsApi } from '@/api/organizations'
import { useSite } from '@/contexts/SiteContext'

/**
 * PR-A — Platform / Firma detayı.
 *
 * Shows minimal information about one organization plus the
 * "Çalışma alanını aç" CTA — the canonical entry-point from the
 * platform control plane into the URL-authoritative operations panel.
 *
 * The CTA navigates to `/app/org/:organizationId/devices`; OrgRouteShell
 * then synchronises the X-Org-Id header and renders the operations
 * shell. We pick Devices (not Dashboard) as the post-CTA landing screen
 * because the dominant super-admin workflow that triggered PR #102–#107
 * is "look at devices in this tenant".
 *
 * The page intentionally avoids per-tenant analytics (device count,
 * license usage, location count) for PR-A — surfacing those would
 * require migrating the dashboard query keys and is the "Yakında"
 * roadmap (PR-B and beyond).
 */
export default function PlatformOrganizationDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { organizationId } = useParams<{ organizationId: string }>()
  const orgIdNum = organizationId ? Number(organizationId) : NaN
  const { setOrganization } = useSite()

  const { data: orgs = [], isLoading, isError } = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: organizationsApi.list,
    staleTime: 60_000,
  })

  const org = orgs.find((o) => o.id === orgIdNum)

  const handleOpenWorkspace = () => {
    if (!org) return
    // Pre-set the active org via SiteContext as a defensive belt-and-
    // suspenders — OrgRouteShell will sync from URL too, but setting it
    // here lets the first request out of the gate carry the right
    // X-Org-Id (avoiding one round-trip's worth of mis-scoped data).
    setOrganization(org.id)
    navigate(`/app/org/${org.id}/devices`)
  }

  if (!Number.isFinite(orgIdNum) || orgIdNum <= 0) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" showIcon message={t('platform.organization_detail.invalid_id')} />
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 24px 80px' }} data-testid="platform-org-detail-page">
      <Space style={{ marginBottom: 16 }} size={12}>
        <Button
          icon={<ArrowLeftOutlined />}
          size="small"
          onClick={() => navigate('/platform/organizations')}
          data-testid="platform-org-detail-back"
        >
          {t('platform.organization_detail.back')}
        </Button>
      </Space>

      {isLoading ? (
        <Skeleton active />
      ) : isError ? (
        <Alert type="error" showIcon message={t('platform.organization_detail.fetch_error')} />
      ) : !org ? (
        <Alert
          type="warning"
          showIcon
          message={t('platform.organization_detail.not_found')}
          data-testid="platform-org-detail-not-found"
        />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} md={14}>
            <Card>
              <Space align="start" size={16} style={{ width: '100%' }}>
                <ApartmentOutlined style={{ fontSize: 28, color: 'var(--accent, #22d3c5)' }} />
                <div style={{ flex: 1 }}>
                  <Typography.Title level={4} style={{ marginBottom: 4 }}>
                    {org.name}
                  </Typography.Title>
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    /{org.slug}
                  </Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    <Tag color={org.is_active ? 'success' : 'warning'}>
                      {org.is_active
                        ? t('platform.organization_detail.status_active')
                        : t('platform.organization_detail.status_inactive')}
                    </Tag>
                  </div>
                </div>
              </Space>

              <Descriptions
                style={{ marginTop: 24 }}
                bordered
                size="small"
                column={1}
                items={[
                  {
                    key: 'id',
                    label: t('platform.organization_detail.field_id'),
                    children: <Typography.Text code>{org.id}</Typography.Text>,
                  },
                  {
                    key: 'name',
                    label: t('platform.organization_detail.field_name'),
                    children: org.name,
                  },
                  {
                    key: 'slug',
                    label: t('platform.organization_detail.field_slug'),
                    children: <Typography.Text code>/{org.slug}</Typography.Text>,
                  },
                  {
                    key: 'status',
                    label: t('platform.organization_detail.field_status'),
                    children: org.is_active
                      ? t('platform.organization_detail.status_active')
                      : t('platform.organization_detail.status_inactive'),
                  },
                ]}
              />
            </Card>
          </Col>
          <Col xs={24} md={10}>
            <Card title={t('platform.organization_detail.cta_section_title')}>
              <Typography.Paragraph>
                {t('platform.organization_detail.cta_description')}
              </Typography.Paragraph>
              <Button
                type="primary"
                size="large"
                block
                icon={<LoginOutlined />}
                onClick={handleOpenWorkspace}
                disabled={!org.is_active}
                data-testid="platform-org-detail-open-workspace"
              >
                {t('platform.organization_detail.cta_open_workspace')}
                <ArrowRightOutlined />
              </Button>
              {!org.is_active && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="warning"
                  showIcon
                  message={t('platform.organization_detail.inactive_warning')}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}
    </div>
  )
}
