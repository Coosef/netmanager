import React, { useState } from 'react'
import {
  Modal, Button, Card, Checkbox, Space, Tag, Typography, Spin, Alert,
  Row, Col, Statistic, Tooltip, Empty,
} from 'antd'
import {
  ApartmentOutlined, EnvironmentOutlined, ShareAltOutlined,
  CheckOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { devicesApi, type GroupSuggestion } from '@/api/devices'

const { Text } = Typography

const TYPE_CONFIG: Record<GroupSuggestion['suggestion_type'], { icon: React.ReactNode; color: string; label: string }> = {
  site_based:       { icon: <EnvironmentOutlined />, color: 'blue',   label: 'Lokasyon' },
  layer_based:      { icon: <ApartmentOutlined />,   color: 'purple', label: 'Katman' },
  topology_cluster: { icon: <ShareAltOutlined />,    color: 'orange', label: 'Topoloji Kümesi' },
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function AutoGroupingModal({ open, onClose }: Props) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [applied, setApplied] = useState(false)
  const [applyResult, setApplyResult] = useState<{ id: number; name: string; device_count: number }[]>([])

  const { data, isLoading } = useQuery({
    queryKey: ['group-suggestions'],
    queryFn: () => devicesApi.getGroupSuggestions(),
    enabled: open,
  })

  const applyMutation = useMutation({
    mutationFn: (suggestions: GroupSuggestion[]) =>
      devicesApi.applyGroupSuggestions(
        suggestions.map((s) => ({
          name: s.suggested_name,
          description: s.description,
          device_ids: s.device_ids,
        }))
      ),
    onSuccess: (res) => {
      setApplied(true)
      setApplyResult(res.created)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['device-groups'] })
    },
  })

  const suggestions = data?.suggestions ?? []

  const toggleAll = () => {
    if (selected.size === suggestions.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(suggestions.map((_, i) => i)))
    }
  }

  const handleApply = () => {
    const chosen = suggestions.filter((_, i) => selected.has(i))
    applyMutation.mutate(chosen)
  }

  const handleClose = () => {
    setSelected(new Set())
    setApplied(false)
    setApplyResult([])
    onClose()
  }

  return (
    <Modal
      title={
        <Space>
          <TeamOutlined />
          <span>Otomatik Gruplama Önerileri</span>
        </Space>
      }
      open={open}
      onCancel={handleClose}
      width={760}
      footer={
        applied ? (
          <Button type="primary" onClick={handleClose}>Kapat</Button>
        ) : (
          <Space>
            <Button onClick={handleClose}>İptal</Button>
            <Button onClick={toggleAll}>
              {selected.size === suggestions.length ? 'Seçimi Kaldır' : 'Tümünü Seç'}
            </Button>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              disabled={selected.size === 0}
              loading={applyMutation.isPending}
              onClick={handleApply}
            >
              {selected.size > 0 ? `${selected.size} Grubu Oluştur` : 'Grup Seç'}
            </Button>
          </Space>
        )
      }
    >
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>
      ) : applied ? (
        <div>
          <Alert
            type="success"
            showIcon
            message={`${applyResult.length} grup başarıyla oluşturuldu`}
            style={{ marginBottom: 16 }}
          />
          {applyResult.map((g) => (
            <Card key={g.id} size="small" style={{ marginBottom: 8 }}>
              <Space>
                <CheckOutlined style={{ color: '#52c41a' }} />
                <Text strong>{g.name}</Text>
                <Text type="secondary">— {g.device_count} cihaz atandı</Text>
              </Space>
            </Card>
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <Empty description="Gruplama için yeterli ortak özellik bulunamadı. Cihazlara site, katman veya topoloji bağlantıları tanımlayın." />
      ) : (
        <div>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic title="Toplam Öneri" value={suggestions.length} prefix={<TeamOutlined />} />
            </Col>
            <Col span={8}>
              <Statistic
                title="Kapsanan Cihaz"
                value={new Set(suggestions.flatMap((s) => s.device_ids)).size}
              />
            </Col>
            <Col span={8}>
              <Statistic title="Seçili" value={selected.size} suffix={`/ ${suggestions.length}`} />
            </Col>
          </Row>

          <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
            {suggestions.map((s, i) => {
              const cfg = TYPE_CONFIG[s.suggestion_type]
              return (
                <Card
                  key={i}
                  size="small"
                  style={{
                    marginBottom: 8,
                    border: selected.has(i) ? '1px solid #1677ff' : undefined,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    const next = new Set(selected)
                    next.has(i) ? next.delete(i) : next.add(i)
                    setSelected(next)
                  }}
                >
                  <Row align="middle" gutter={8} wrap={false}>
                    <Col flex="none">
                      <Checkbox checked={selected.has(i)} onClick={(e) => e.stopPropagation()} onChange={() => {
                        const next = new Set(selected)
                        next.has(i) ? next.delete(i) : next.add(i)
                        setSelected(next)
                      }} />
                    </Col>
                    <Col flex="none" style={{ fontSize: 18, color: `var(--ant-color-${cfg.color})` }}>
                      {cfg.icon}
                    </Col>
                    <Col flex="auto">
                      <Space size={4} wrap>
                        <Text strong>{s.suggested_name}</Text>
                        <Tag color={cfg.color} style={{ fontSize: 11 }}>{cfg.label}</Tag>
                      </Space>
                      <div style={{ marginTop: 2 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{s.description}</Text>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {s.device_names.slice(0, 5).map((n) => (
                          <Tag key={n} style={{ fontSize: 11, marginBottom: 2 }}>{n}</Tag>
                        ))}
                        {s.device_names.length > 5 && (
                          <Tooltip title={s.device_names.slice(5).join(', ')}>
                            <Tag style={{ fontSize: 11 }}>+{s.device_names.length - 5} daha</Tag>
                          </Tooltip>
                        )}
                      </div>
                    </Col>
                    <Col flex="none">
                      <Text strong style={{ fontSize: 20 }}>{s.device_count}</Text>
                      <div><Text type="secondary" style={{ fontSize: 11 }}>cihaz</Text></div>
                    </Col>
                  </Row>
                </Card>
              )
            })}
          </div>
        </div>
      )}
    </Modal>
  )
}
