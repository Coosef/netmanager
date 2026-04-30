import { useState } from 'react'
import {
  Button, Card, Col, Form, Input, InputNumber, Radio, Row,
  Select, Space, Tag, Typography, Alert, Divider, Spin,
} from 'antd'
import {
  AimOutlined, ApiOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ClockCircleOutlined, CodeOutlined, DeploymentUnitOutlined,
  GlobalOutlined, LaptopOutlined, ReloadOutlined, SearchOutlined,
  WifiOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { diagnosticsApi, type DiagResult, type DiagType } from '@/api/diagnostics'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

const { Text } = Typography

const DIAG_CSS = `
@keyframes diagScanLine {
  0%   { transform: translateY(-100%); opacity: 0; }
  20%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { transform: translateY(100%); opacity: 0; }
}
@keyframes diagResultIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes diagTermBlink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes diagRadar {
  0%   { box-shadow: 0 0 0   0   #3b82f640; }
  50%  { box-shadow: 0 0 20px 6px #3b82f620; }
  100% { box-shadow: 0 0 0   0   #3b82f640; }
}
.diag-type-btn { transition: all 0.15s ease !important; }
.diag-type-btn:hover { transform: translateY(-1px) !important; }
`

const DIAG_TYPES: { value: DiagType; label: string; icon: React.ReactNode; desc: string }[] = [
  { value: 'ping', icon: <WifiOutlined />, label: 'Ping', desc: 'ICMP paket testi, gecikme ve kayıp oranı' },
  { value: 'traceroute', icon: <DeploymentUnitOutlined />, label: 'Traceroute', desc: 'Hedefe giden ağ yolunu gösterir' },
  { value: 'dns', icon: <GlobalOutlined />, label: 'DNS Sorgu', desc: 'Hostname → IP çözümlemesi' },
  { value: 'port_check', icon: <ApiOutlined />, label: 'Port Kontrol', desc: 'TCP port erişilebilirlik testi' },
  { value: 'snmp_get', icon: <DatabaseOutlined />, label: 'SNMP GET', desc: 'OID değerini SNMP ile sorgula' },
]

function mkC(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#94a3b8' : '#64748b',
    dim: isDark ? '#475569' : '#9ca3af',
    primary: '#3b82f6',
    success: '#22c55e',
    danger: '#ef4444',
    warning: '#f59e0b',
  }
}

const QUICK_TARGETS = [
  { label: 'Google DNS', value: '8.8.8.8' },
  { label: 'Cloudflare DNS', value: '1.1.1.1' },
  { label: 'Google', value: 'google.com' },
]

const COMMON_OID_PRESETS = [
  { label: 'sysDescr', value: '1.3.6.1.2.1.1.1.0' },
  { label: 'sysUpTime', value: '1.3.6.1.2.1.1.3.0' },
  { label: 'sysName', value: '1.3.6.1.2.1.1.5.0' },
  { label: 'ifNumber', value: '1.3.6.1.2.1.2.1.0' },
  { label: 'sysLocation', value: '1.3.6.1.2.1.1.6.0' },
  { label: 'sysContact', value: '1.3.6.1.2.1.1.4.0' },
]

const COMMON_PORTS = [
  { label: 'SSH (22)', value: 22 },
  { label: 'HTTP (80)', value: 80 },
  { label: 'HTTPS (443)', value: 443 },
  { label: 'Telnet (23)', value: 23 },
  { label: 'SNMP (161)', value: 161 },
  { label: 'RDP (3389)', value: 3389 },
]

function ResultCard({ result, C }: { result: DiagResult; C: ReturnType<typeof mkC> }) {
  const statusColor = result.success ? C.success : C.danger
  const statusIcon = result.success
    ? <CheckCircleOutlined style={{ color: statusColor, fontSize: 20 }} />
    : <CloseCircleOutlined style={{ color: statusColor, fontSize: 20 }} />

  return (
    <Card
      size="small"
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${statusColor}`,
        borderRadius: 10,
        marginTop: 16,
        animation: 'diagResultIn 0.3s ease-out',
        boxShadow: `0 4px 16px ${statusColor}12`,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        {statusIcon}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong style={{ color: C.text, fontSize: 15 }}>
              {result.type.toUpperCase()} → {result.target}
            </Text>
            <Tag color={result.success ? 'green' : 'red'}>
              {result.success ? 'Başarılı' : 'Başarısız'}
            </Tag>
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
            Kaynak: {result.source_label}
            <span style={{ marginLeft: 12 }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {result.duration_ms}ms
            </span>
            <span style={{ marginLeft: 12 }}>{dayjs(result.ran_at).format('HH:mm:ss')}</span>
          </div>
        </div>
      </div>

      {/* Metrics row for ping */}
      {result.type === 'ping' && (result.extra.rtt_avg_ms != null || result.extra.packet_loss_pct != null) && (
        <Row gutter={12} style={{ marginBottom: 12 }}>
          {result.extra.rtt_avg_ms != null && (
            <Col span={8}>
              <div style={{ background: C.bg2, borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
                <div style={{ color: C.muted, fontSize: 11 }}>Ortalama RTT</div>
                <div style={{ color: C.primary, fontSize: 18, fontWeight: 700 }}>{result.extra.rtt_avg_ms}ms</div>
              </div>
            </Col>
          )}
          {result.extra.packet_loss_pct != null && (
            <Col span={8}>
              <div style={{ background: C.bg2, borderRadius: 6, padding: '8px 12px', textAlign: 'center' }}>
                <div style={{ color: C.muted, fontSize: 11 }}>Paket Kaybı</div>
                <div style={{
                  color: result.extra.packet_loss_pct === 0 ? C.success : result.extra.packet_loss_pct < 50 ? C.warning : C.danger,
                  fontSize: 18, fontWeight: 700,
                }}>
                  %{result.extra.packet_loss_pct}
                </div>
              </div>
            </Col>
          )}
        </Row>
      )}

      {/* DNS resolved IPs */}
      {result.type === 'dns' && result.extra.resolved_ips && result.extra.resolved_ips.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Text style={{ color: C.muted, fontSize: 12, marginRight: 8 }}>Çözümlenen IP'ler:</Text>
          {result.extra.resolved_ips.map((ip) => (
            <Tag key={ip} color="blue" style={{ fontFamily: 'monospace' }}>{ip}</Tag>
          ))}
          {result.extra.reverse_hostname && (
            <Tag color="purple">{result.extra.reverse_hostname}</Tag>
          )}
        </div>
      )}

      {/* SNMP result */}
      {result.type === 'snmp_get' && result.extra.snmp_oid && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tag color="blue" style={{ fontFamily: 'monospace', fontSize: 11 }}>OID: {result.extra.snmp_oid}</Tag>
            {result.extra.snmp_type && <Tag color="purple" style={{ fontSize: 11 }}>{result.extra.snmp_type}</Tag>}
          </div>
          {result.extra.snmp_value != null && (
            <div style={{
              marginTop: 8, padding: '10px 14px',
              background: C.bg2, border: `1px solid ${C.border}`,
              borderRadius: 6, fontFamily: 'monospace', fontSize: 15,
              color: C.text, fontWeight: 600, wordBreak: 'break-all',
            }}>
              {result.extra.snmp_value}
            </div>
          )}
        </div>
      )}

      {/* Raw output */}
      <div>
        <Text style={{ color: C.muted, fontSize: 12 }}><CodeOutlined style={{ marginRight: 4 }} />Çıktı:</Text>
        <pre style={{
          background: '#0f172a',
          color: result.success ? '#d4d4d4' : '#f87171',
          padding: '10px 14px',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'monospace',
          marginTop: 6,
          maxHeight: 300,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {result.output || '(çıktı yok)'}
        </pre>
      </div>
    </Card>
  )
}

export default function DiagnosticsPage() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [form] = Form.useForm()
  const [diagType, setDiagType] = useState<DiagType>('ping')
  const [source, setSource] = useState<'server' | 'device'>('server')
  const [results, setResults] = useState<DiagResult[]>([])

  const { data: devicesData } = useQuery({
    queryKey: ['devices-list-diag', activeSite],
    queryFn: () => devicesApi.list({ limit: 200, site: activeSite || undefined }),
  })
  const devices = devicesData?.items ?? []

  const runMutation = useMutation({
    mutationFn: diagnosticsApi.run,
    onSuccess: (data) => {
      setResults((prev) => [data, ...prev.slice(0, 19)])
    },
  })

  const handleRun = (values: any) => {
    runMutation.mutate({
      type: diagType,
      target: values.target,
      source,
      device_id: source === 'device' ? values.device_id : undefined,
      count: values.count ?? 4,
      port: diagType === 'port_check' ? values.port : undefined,
      timeout: values.timeout ?? 5,
      snmp_oid: diagType === 'snmp_get' ? (values.snmp_oid || '1.3.6.1.2.1.1.1.0') : undefined,
      snmp_community: diagType === 'snmp_get' ? (values.snmp_community || 'public') : undefined,
      snmp_version: diagType === 'snmp_get' ? (values.snmp_version || 'v2c') : undefined,
      snmp_port: diagType === 'snmp_get' ? (values.snmp_port || 161) : undefined,
    })
  }

  const setQuickTarget = (val: string) => form.setFieldValue('target', val)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <style>{DIAG_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark
          ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
          : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', alignItems: 'center', gap: 12,
        animation: isDark ? 'diagRadar 5s ease-in-out infinite' : undefined,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: '#3b82f620', border: '1px solid #3b82f630',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <AimOutlined style={{ color: C.primary, fontSize: 20 }} />
        </div>
        <div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Ağ Tanılama Araçları</div>
          <Text style={{ color: C.muted, fontSize: 12 }}>
            Ping, traceroute, DNS ve port testi — sunucudan veya cihaz üzerinden
          </Text>
        </div>
      </div>

      <Row gutter={[20, 20]}>
        {/* Left panel: form */}
        <Col xs={24} lg={10}>
          <Card
            size="small"
            style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12 }}
          >
            {/* Diagnostic type selector */}
            <div style={{ marginBottom: 16 }}>
              <Text style={{ color: C.muted, fontSize: 12, display: 'block', marginBottom: 8 }}>
                TANILAMA TÜRÜ
              </Text>
              <Row gutter={[8, 8]}>
                {DIAG_TYPES.map((dt) => (
                  <Col span={12} key={dt.value}>
                    <div
                      className="diag-type-btn"
                      onClick={() => setDiagType(dt.value)}
                      style={{
                        background: diagType === dt.value
                          ? isDark ? `${C.primary}20` : `${C.primary}12`
                          : C.bg2,
                        border: `1px solid ${diagType === dt.value ? C.primary + '80' : C.border}`,
                        borderTop: diagType === dt.value ? `2px solid ${C.primary}` : `2px solid transparent`,
                        borderRadius: 8,
                        padding: '10px 12px',
                        cursor: 'pointer',
                        boxShadow: diagType === dt.value && isDark
                          ? `0 4px 16px ${C.primary}20`
                          : undefined,
                      }}
                    >
                      <Space size={6}>
                        <span style={{ color: diagType === dt.value ? C.primary : C.muted, fontSize: 16 }}>
                          {dt.icon}
                        </span>
                        <div>
                          <div style={{ color: diagType === dt.value ? C.primary : C.text, fontSize: 13, fontWeight: 600 }}>
                            {dt.label}
                          </div>
                          <div style={{ color: C.dim, fontSize: 11 }}>{dt.desc}</div>
                        </div>
                      </Space>
                    </div>
                  </Col>
                ))}
              </Row>
            </div>

            <Divider style={{ borderColor: C.border, margin: '12px 0' }} />

            {/* Source selector */}
            <div style={{ marginBottom: 16 }}>
              <Text style={{ color: C.muted, fontSize: 12, display: 'block', marginBottom: 8 }}>
                KAYNAK
              </Text>
              <Radio.Group
                value={source}
                onChange={(e) => setSource(e.target.value)}
                buttonStyle="solid"
                size="small"
                style={{ width: '100%' }}
              >
                <Radio.Button value="server" style={{ width: '50%', textAlign: 'center' }}>
                  <GlobalOutlined style={{ marginRight: 6 }} />Sunucu
                </Radio.Button>
                <Radio.Button value="device" style={{ width: '50%', textAlign: 'center' }}>
                  <LaptopOutlined style={{ marginRight: 6 }} />Cihaz
                </Radio.Button>
              </Radio.Group>
            </div>

            <Form form={form} layout="vertical" onFinish={handleRun} size="small">
              {/* Device picker (only when source=device) */}
              {source === 'device' && (
                <Form.Item name="device_id" label="Kaynak Cihaz" rules={[{ required: true, message: 'Cihaz seçin' }]}>
                  <Select
                    placeholder="Cihaz seçin"
                    showSearch
                    optionFilterProp="label"
                    options={devices.map((d) => ({
                      value: d.id,
                      label: `${d.hostname} (${d.ip_address})`,
                    }))}
                  />
                </Form.Item>
              )}

              {/* Target */}
              <Form.Item name="target" label="Hedef IP / Hostname" rules={[{ required: true, message: 'Hedef girin' }]}>
                <Input
                  prefix={<SearchOutlined style={{ color: C.muted }} />}
                  placeholder="192.168.1.1 veya google.com"
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Item>
              <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {QUICK_TARGETS.map((q) => (
                  <Tag
                    key={q.value}
                    onClick={() => setQuickTarget(q.value)}
                    style={{ cursor: 'pointer', fontSize: 11 }}
                    color="blue"
                  >
                    {q.label}
                  </Tag>
                ))}
              </div>

              {/* Port (only for port_check) */}
              {diagType === 'port_check' && (
                <Row gutter={12}>
                  <Col span={14}>
                    <Form.Item name="port" label="Port" rules={[{ required: true, message: 'Port girin' }]}>
                      <InputNumber style={{ width: '100%' }} placeholder="443" min={1} max={65535} />
                    </Form.Item>
                  </Col>
                  <Col span={10}>
                    <Form.Item label=" ">
                      <Select
                        placeholder="Hızlı seç"
                        onChange={(v) => form.setFieldValue('port', v)}
                        options={COMMON_PORTS}
                        size="small"
                      />
                    </Form.Item>
                  </Col>
                </Row>
              )}

              {/* SNMP GET fields */}
              {diagType === 'snmp_get' && (
                <>
                  <Form.Item name="snmp_oid" label="OID" initialValue="1.3.6.1.2.1.1.1.0" rules={[{ required: true, message: 'OID girin' }]}>
                    <Input placeholder="1.3.6.1.2.1.1.1.0" style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                  <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {COMMON_OID_PRESETS.map((p) => (
                      <Tag
                        key={p.value}
                        onClick={() => form.setFieldValue('snmp_oid', p.value)}
                        style={{ cursor: 'pointer', fontSize: 11 }}
                        color="purple"
                      >
                        {p.label}
                      </Tag>
                    ))}
                  </div>
                  <Row gutter={12}>
                    <Col span={14}>
                      <Form.Item name="snmp_community" label="Community" initialValue="public">
                        <Input placeholder="public" style={{ fontFamily: 'monospace' }} />
                      </Form.Item>
                    </Col>
                    <Col span={10}>
                      <Form.Item name="snmp_version" label="Versiyon" initialValue="v2c">
                        <Select options={[{ value: 'v1', label: 'v1' }, { value: 'v2c', label: 'v2c' }]} />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item name="snmp_port" label="Port" initialValue={161}>
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                </>
              )}

              {/* Ping count */}
              {diagType === 'ping' && (
                <Form.Item name="count" label="Paket Sayısı" initialValue={4}>
                  <InputNumber min={1} max={20} style={{ width: '100%' }} />
                </Form.Item>
              )}

              {/* Timeout */}
              <Form.Item name="timeout" label="Zaman Aşımı (sn)" initialValue={5}>
                <InputNumber min={1} max={30} style={{ width: '100%' }} />
              </Form.Item>

              <Button
                type="primary"
                htmlType="submit"
                loading={runMutation.isPending}
                icon={<AimOutlined />}
                block
                style={{ marginTop: 4 }}
              >
                {runMutation.isPending ? 'Çalışıyor...' : 'Tanılamayı Başlat'}
              </Button>
            </Form>
          </Card>
        </Col>

        {/* Right panel: results */}
        <Col xs={24} lg={14}>
          {runMutation.isPending && (
            <div style={{
              background: isDark
                ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
                : C.bg,
              border: `1px solid ${isDark ? '#3b82f630' : C.border}`,
              borderRadius: 10,
              padding: '40px 32px',
              textAlign: 'center',
              position: 'relative',
              overflow: 'hidden',
            }}>
              {isDark && (
                <div style={{
                  position: 'absolute', top: 0, bottom: 0, width: 2,
                  background: 'linear-gradient(180deg, transparent, #3b82f660, transparent)',
                  animation: 'diagScanLine 2.5s linear infinite',
                  left: '50%', pointerEvents: 'none',
                }} />
              )}
              <Spin size="large" />
              <div style={{ color: C.primary, marginTop: 16, fontFamily: 'monospace', fontSize: 13 }}>
                <span style={{ display: 'inline-block', animation: 'diagTermBlink 1s infinite', marginRight: 4 }}>▌</span>
                {diagType === 'traceroute'
                  ? 'Traceroute çalışıyor (30-60 sn sürebilir)...'
                  : diagType === 'snmp_get'
                    ? 'SNMP GET sorgulanıyor...'
                    : 'Tanılama çalışıyor...'}
              </div>
            </div>
          )}

          {runMutation.isError && (
            <Alert
              type="error"
              message="Tanılama başlatılamadı"
              description={(runMutation.error as any)?.response?.data?.detail || 'Bilinmeyen hata'}
              style={{ marginBottom: 12 }}
            />
          )}

          {results.length === 0 && !runMutation.isPending && (
            <div style={{
              background: isDark
                ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
                : C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              padding: '48px 32px',
              textAlign: 'center',
              position: 'relative', overflow: 'hidden',
            }}>
              {isDark && (
                <div style={{
                  position: 'absolute', inset: 0,
                  backgroundImage: 'radial-gradient(circle, rgba(59,130,246,0.04) 1px, transparent 0)',
                  backgroundSize: '22px 22px',
                  pointerEvents: 'none',
                }} />
              )}
              <AimOutlined style={{ fontSize: 44, color: isDark ? '#3b82f640' : C.dim, marginBottom: 12 }} />
              <div style={{ color: C.muted, fontSize: 14 }}>Sol panelden bir tanılama türü seçip başlatın</div>
              <div style={{ color: C.dim, fontSize: 12, marginTop: 6 }}>Sonuçlar burada görünecek</div>
            </div>
          )}

          {results.map((r, i) => (
            <ResultCard key={i} result={r} C={C} />
          ))}

          {results.length > 0 && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => setResults([])}
                style={{ color: C.muted }}
                type="text"
              >
                Sonuçları Temizle
              </Button>
            </div>
          )}
        </Col>
      </Row>
    </div>
  )
}
