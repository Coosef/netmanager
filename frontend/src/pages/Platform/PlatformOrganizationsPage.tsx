import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Input, Space, Table, Tag, Typography, Button } from 'antd'
import { ApartmentOutlined, SearchOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { organizationsApi, type Organization } from '@/api/organizations'

/**
 * PR-A — Platform / Firmalar listesi.
 *
 * Read-only table of every organization the super-admin may scope into.
 * Each row has a "Detay" action that navigates to
 * `/platform/organizations/:organizationId`. The detail page surfaces
 * the "Çalışma alanını aç" CTA which then enters the URL-authoritative
 * operations panel.
 */
export default function PlatformOrganizationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: organizationsApi.list,
    staleTime: 60_000,
  })

  const filtered = filter.trim().length === 0
    ? orgs
    : orgs.filter(
        (o) =>
          o.name.toLowerCase().includes(filter.toLowerCase()) ||
          o.slug.toLowerCase().includes(filter.toLowerCase()),
      )

  const columns = [
    {
      title: t('platform.organizations.col_name'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Space>
          <ApartmentOutlined />
          <Typography.Text strong>{name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('platform.organizations.col_slug'),
      dataIndex: 'slug',
      key: 'slug',
      render: (slug: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          /{slug}
        </Typography.Text>
      ),
    },
    {
      title: t('platform.organizations.col_status'),
      dataIndex: 'is_active',
      key: 'is_active',
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'success' : 'warning'}>
          {isActive
            ? t('platform.organizations.status_active')
            : t('platform.organizations.status_inactive')}
        </Tag>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, org: Organization) => (
        <Button
          type="link"
          size="small"
          onClick={() => navigate(`/platform/organizations/${org.id}`)}
          data-testid={`platform-org-detail-${org.id}`}
        >
          {t('platform.organizations.action_detail')} <RightOutlined />
        </Button>
      ),
    },
  ]

  return (
    <div style={{ padding: '24px 24px 80px' }} data-testid="platform-organizations-page">
      <Typography.Title level={3} style={{ marginBottom: 4 }}>
        {t('platform.organizations.title')}
      </Typography.Title>
      <Typography.Paragraph style={{ color: 'var(--fg-2)', marginBottom: 24 }}>
        {t('platform.organizations.subtitle')}
      </Typography.Paragraph>

      <Card>
        <Space style={{ marginBottom: 16 }} size={12}>
          <Input
            placeholder={t('platform.organizations.search_placeholder')}
            prefix={<SearchOutlined />}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            allowClear
            style={{ width: 280 }}
            data-testid="platform-organizations-search"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('platform.organizations.count_label', { count: filtered.length })}
          </Typography.Text>
        </Space>
        <Table
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={filtered}
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>
    </div>
  )
}
