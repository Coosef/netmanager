import { useQuery } from '@tanstack/react-query'
import { Card, Col, Row, Statistic, Typography, Tag, Space, Alert } from 'antd'
import { ApartmentOutlined, TeamOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { organizationsApi } from '@/api/organizations'

/**
 * PR-A — Platform control-plane landing page.
 *
 * Light, read-only summary of every tenant the super-admin may scope
 * into. This page is intentionally narrow — full per-tenant analytics
 * (license usage, retention status, global health) is the "Yakında"
 * roadmap. The page MUST stay safe to render for a super-admin who has
 * just landed via login; it never hits org-scoped endpoints.
 */
export default function PlatformOverviewPage() {
  const { t } = useTranslation()
  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: organizationsApi.list,
    staleTime: 60_000,
  })

  const activeCount = orgs.filter((o) => o.is_active).length
  const inactiveCount = orgs.length - activeCount

  return (
    <div style={{ padding: '24px 24px 80px' }} data-testid="platform-overview-page">
      <Typography.Title level={3} style={{ marginBottom: 4 }}>
        {t('platform.overview.title')}
      </Typography.Title>
      <Typography.Paragraph style={{ color: 'var(--fg-2)', marginBottom: 24 }}>
        {t('platform.overview.subtitle')}
      </Typography.Paragraph>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title={t('platform.overview.metric_total_orgs')}
              value={orgs.length}
              loading={isLoading}
              prefix={<ApartmentOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title={t('platform.overview.metric_active_orgs')}
              value={activeCount}
              loading={isLoading}
              prefix={<SafetyCertificateOutlined />}
              valueStyle={{ color: '#22c55e' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title={t('platform.overview.metric_inactive_orgs')}
              value={inactiveCount}
              loading={isLoading}
              prefix={<TeamOutlined />}
              valueStyle={{ color: inactiveCount > 0 ? '#f59e0b' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Alert
        style={{ marginTop: 24 }}
        type="info"
        showIcon
        message={t('platform.overview.coming_soon_message')}
      />

      <Card style={{ marginTop: 24 }} title={t('platform.overview.tenant_list_title')}>
        {isLoading ? (
          <Typography.Text type="secondary">{t('platform.overview.loading')}</Typography.Text>
        ) : orgs.length === 0 ? (
          <Typography.Text type="secondary">{t('platform.overview.empty')}</Typography.Text>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {orgs.map((org) => (
              <div
                key={org.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'var(--bg-1)',
                }}
              >
                <Space>
                  <ApartmentOutlined />
                  <Typography.Text strong>{org.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    /{org.slug}
                  </Typography.Text>
                </Space>
                <Tag color={org.is_active ? 'success' : 'warning'}>
                  {org.is_active
                    ? t('platform.overview.org_status_active')
                    : t('platform.overview.org_status_inactive')}
                </Tag>
              </div>
            ))}
          </Space>
        )}
      </Card>
    </div>
  )
}
