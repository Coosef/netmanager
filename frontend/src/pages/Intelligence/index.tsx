import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge, Button, Card, Col, Progress, Row, Select, Space, Spin,
  Table, Tag, Timeline, Tooltip, Typography,
} from 'antd'
import {
  AlertOutlined, BugOutlined, FireOutlined, RiseOutlined,
  SafetyOutlined, ThunderboltOutlined, ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { intelligenceApi, type AnomalyEvent, type DeviceRiskScore } from '@/api/intelligence'
import { useTheme } from '@/contexts/ThemeContext'

const { Title, Text } = Typography

const RISK_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#f59e0b',
  low:      '#22c55e',
}

const ANOMALY_COLOR: Record<string, string> = {
  mac_anomaly:          '#8b5cf6',
  traffic_spike:        '#f97316',
  vlan_anomaly:         '#3b82f6',
  mac_loop_suspicion:   '#ef4444',
  topology_drift:       '#06b6d4',
  stp_anomaly:          '#f43f5e',
  port_flap:            '#a855f7',
  bgp_anomaly:          '#10b981',
  behavior_anomaly:     '#6366f1',
  loop_detected:        '#dc2626',
}

const ANOMALY_ICON: Record<string, React.ReactNode> = {
  traffic_spike:     <RiseOutlined />,
  mac_loop_suspicion:<AlertOutlined />,
  stp_anomaly:       <ThunderboltOutlined />,
  loop_detected:     <ThunderboltOutlined />,
}

function RiskGauge({ score, level }: { score: number; level: string }) {
  const color = RISK_COLOR[level] || '#64748b'
  return (
    <div style={{ textAlign: 'center' }}>
      <Progress
        type="circle"
        percent={score}
        size={56}
        strokeColor={color}
        format={(p) => <span style={{ fontSize: 13, fontWeight: 700, color }}>{p}</span>}
      />
      <div style={{ marginTop: 4 }}>
        <Tag color={color} style={{ fontSize: 10, margin: 0 }}>{level?.toUpperCase()}</Tag>
      </div>
    </div>
  )
}

export default function IntelligencePage() {
  const { isDark } = useTheme()
  const [anomalyWindow, setAnomalyWindow] = useState(24)
  const [riskLimit, setRiskLimit] = useState(15)

  const bg      = isDark ? '#030c1e' : '#f0f4f8'
  const cardBg  = isDark ? 'rgba(14,30,56,0.7)' : '#fff'
  const border  = isDark ? '#1a3458' : '#e2e8f0'
  const textPri = isDark ? '#e2e8f0' : '#1e293b'
  const textMut = isDark ? '#64748b' : '#94a3b8'

  const cardStyle = { background: cardBg, border: `1px solid ${border}` }
  const headerStyle = { background: isDark ? 'rgba(14,30,56,0.5)' : '#f8fafc', borderBottom: `1px solid ${border}` }

  const { data: fleet, isLoading: fleetLoading, refetch: refetchFleet } = useQuery({
    queryKey: ['fleet-risk-intel', riskLimit],
    queryFn: () => intelligenceApi.getFleetRisk(riskLimit),
    staleTime: 120_000,
    refetchInterval: 300_000,
  })

  const { data: anomalies, isLoading: anomalyLoading, refetch: refetchAnomalies } = useQuery({
    queryKey: ['anomalies-intel', anomalyWindow],
    queryFn: () => intelligenceApi.getAnomalies(anomalyWindow, 60),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  const { data: rootCause, isLoading: rcLoading, refetch: refetchRc } = useQuery({
    queryKey: ['root-cause-intel', anomalyWindow],
    queryFn: () => intelligenceApi.getRootCauseIncidents(anomalyWindow, 10),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  const riskColumns = [
    {
      title: 'Risk',
      key: 'risk',
      width: 90,
      render: (_: unknown, r: DeviceRiskScore) => <RiskGauge score={r.risk_score} level={r.level} />,
    },
    {
      title: 'Cihaz',
      dataIndex: 'hostname',
      render: (v: string, r: DeviceRiskScore) => (
        <div>
          <Text strong style={{ color: textPri }}>{v}</Text>
          <div style={{ fontSize: 11, color: textMut }}>ID: {r.device_id}</div>
        </div>
      ),
    },
    {
      title: 'Risk Faktörleri',
      key: 'breakdown',
      render: (_: unknown, r: DeviceRiskScore) => (
        <Space wrap size={4}>
          {r.breakdown.uptime_7d?.risk_contribution > 0 && (
            <Tag color="orange" style={{ fontSize: 10 }}>
              Uptime: {r.breakdown.uptime_7d.uptime_pct?.toFixed(1)}%
            </Tag>
          )}
          {r.breakdown.flapping_7d?.risk_contribution > 0 && (
            <Tag color="volcano" style={{ fontSize: 10 }}>
              Flap: {r.breakdown.flapping_7d.flap_count}
            </Tag>
          )}
          {r.breakdown.compliance?.risk_contribution > 0 && (
            <Tag color="red" style={{ fontSize: 10 }}>Uyumsuz</Tag>
          )}
          {r.breakdown.backup?.risk_contribution > 0 && (
            <Tag color="purple" style={{ fontSize: 10 }}>Backup Eski</Tag>
          )}
        </Space>
      ),
    },
  ]

  const summary = fleet?.summary
  const criticalCount  = summary?.critical  || 0
  const highCount      = summary?.high      || 0
  const mediumCount    = summary?.medium    || 0
  const avgRisk        = summary?.avg_risk_score || 0

  return (
    <div style={{ padding: '20px 24px', background: bg, minHeight: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0, color: textPri }}>
            <BugOutlined style={{ marginRight: 8, color: '#3b82f6' }} />
            Ağ Analitik & Intelligence
          </Title>
          <Text style={{ color: textMut, fontSize: 13 }}>
            Fleet risk, anomali tespiti ve root cause analizi
          </Text>
        </div>
        <Space>
          <Select
            value={anomalyWindow}
            onChange={setAnomalyWindow}
            size="small"
            style={{ width: 120 }}
            options={[
              { label: 'Son 6 saat', value: 6 },
              { label: 'Son 24 saat', value: 24 },
              { label: 'Son 48 saat', value: 48 },
              { label: 'Son 7 gün', value: 168 },
            ]}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => { refetchFleet(); refetchAnomalies(); refetchRc() }}
          >
            Yenile
          </Button>
        </Space>
      </div>

      {/* Fleet Risk Summary */}
      {fleetLoading ? <Spin /> : summary && (
        <Row gutter={12} style={{ marginBottom: 20 }}>
          {[
            { label: 'Kritik Cihaz', value: criticalCount, color: '#ef4444', icon: <FireOutlined /> },
            { label: 'Yüksek Risk', value: highCount,      color: '#f97316', icon: <AlertOutlined /> },
            { label: 'Orta Risk',   value: mediumCount,    color: '#f59e0b', icon: <SafetyOutlined /> },
            { label: 'Ort. Risk Skoru', value: avgRisk,    color: '#3b82f6', icon: <RiseOutlined /> },
          ].map((s) => (
            <Col key={s.label} span={6}>
              <Card size="small" style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 24, color: s.color }}>{s.icon}</div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: textMut }}>{s.label}</div>
                  </div>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Row gutter={16}>
        {/* Top Risky Devices */}
        <Col span={14}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: textPri }}>
                  <FireOutlined style={{ color: '#ef4444', marginRight: 6 }} />
                  En Riskli Cihazlar
                </span>
                <Select
                  value={riskLimit}
                  onChange={setRiskLimit}
                  size="small"
                  style={{ width: 80 }}
                  options={[
                    { label: 'Top 10', value: 10 },
                    { label: 'Top 15', value: 15 },
                    { label: 'Top 25', value: 25 },
                  ]}
                />
              </div>
            }
            style={cardStyle}
            styles={{ header: headerStyle }}
          >
            {fleetLoading ? <Spin /> : (
              <Table
                dataSource={fleet?.top_risky || []}
                columns={riskColumns}
                rowKey="device_id"
                size="small"
                pagination={{ pageSize: 10, size: 'small' }}
              />
            )}
          </Card>
        </Col>

        {/* Anomaly Feed + Root Cause */}
        <Col span={10}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Anomaly Type Breakdown */}
            {!anomalyLoading && anomalies && anomalies.total > 0 && (
              <Card
                title={<span style={{ color: textPri }}>
                  <AlertOutlined style={{ color: '#f59e0b', marginRight: 6 }} />
                  Anomali Dağılımı ({anomalies.total})
                </span>}
                size="small"
                style={cardStyle}
                styles={{ header: headerStyle }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {Object.entries(anomalies.counts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([type, cnt]) => (
                      <div key={type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Tag
                          color={ANOMALY_COLOR[type] || '#64748b'}
                          icon={ANOMALY_ICON[type]}
                          style={{ fontSize: 11, margin: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {type.replace(/_/g, ' ')}
                        </Tag>
                        <Badge count={cnt} color={ANOMALY_COLOR[type] || '#64748b'} />
                      </div>
                    ))}
                </div>
              </Card>
            )}

            {/* Recent Anomalies Timeline */}
            <Card
              title={<span style={{ color: textPri }}>
                <ThunderboltOutlined style={{ color: '#8b5cf6', marginRight: 6 }} />
                Son Anomaliler
              </span>}
              size="small"
              style={cardStyle}
              styles={{ header: headerStyle }}
            >
              {anomalyLoading ? <Spin /> : !anomalies || anomalies.events.length === 0 ? (
                <Text style={{ color: textMut, fontSize: 12 }}>Bu dönemde anomali yok</Text>
              ) : (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  <Timeline
                    items={(anomalies.events as AnomalyEvent[]).slice(0, 15).map((e) => ({
                      color: ANOMALY_COLOR[e.event_type] || '#64748b',
                      children: (
                        <div style={{ marginBottom: 2 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <Text strong style={{ fontSize: 12, color: textPri }}>{e.title}</Text>
                            <Text style={{ fontSize: 10, color: textMut, whiteSpace: 'nowrap', marginLeft: 8 }}>
                              {dayjs(e.ts).fromNow()}
                            </Text>
                          </div>
                          {e.device_hostname && (
                            <Text style={{ fontSize: 11, color: textMut }}>{e.device_hostname}</Text>
                          )}
                        </div>
                      ),
                    }))}
                  />
                </div>
              )}
            </Card>

            {/* Root Cause Incidents */}
            {!rcLoading && rootCause && rootCause.total > 0 && (
              <Card
                title={<span style={{ color: textPri }}>
                  <BugOutlined style={{ color: '#ef4444', marginRight: 6 }} />
                  Root Cause Olaylar ({rootCause.total})
                </span>}
                size="small"
                style={cardStyle}
                styles={{ header: headerStyle }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {rootCause.incidents.slice(0, 5).map((inc) => (
                    <div
                      key={inc.root_device_id}
                      style={{
                        padding: '8px 10px', borderRadius: 6,
                        background: isDark ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.04)',
                        border: `1px solid rgba(239,68,68,0.2)`,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <Text strong style={{ fontSize: 12, color: '#ef4444' }}>{inc.title}</Text>
                        <Tooltip title={`${inc.affected_devices.length} cihaz etkilendi`}>
                          <Badge count={inc.affected_devices.length} color="#ef4444" />
                        </Tooltip>
                      </div>
                      {inc.affected_devices.slice(0, 3).map((d) => (
                        <Tag key={d.id} style={{ fontSize: 10, marginTop: 3 }}>{d.hostname}</Tag>
                      ))}
                      {inc.affected_devices.length > 3 && (
                        <Text style={{ fontSize: 10, color: textMut }}>+{inc.affected_devices.length - 3} daha</Text>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </Col>
      </Row>
    </div>
  )
}
