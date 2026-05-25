// Event explainer — eski Monitor sayfasından (pre-T8.4) korunmuş; her
// olay tipi için "ne oldu / detay / öneri / komut / ilgili sayfa
// linkleri" üretir. NocMonitor'ın EventDetailModal'ı bunu kullanır.
import type React from 'react'
import { Tag, Space, Tooltip, Typography } from 'antd'
import {
  AlertOutlined, ApartmentOutlined, ApiOutlined, BranchesOutlined,
  CodeOutlined, DatabaseOutlined, DisconnectOutlined, ExclamationCircleOutlined,
  LineChartOutlined, RobotOutlined, SyncOutlined, TableOutlined, WarningOutlined,
} from '@ant-design/icons'
import type { NetworkEvent } from '@/api/monitor'

const { Text } = Typography

export const TYPE_LABELS: Record<string, string> = {
  device_offline:        'Cihaz Offline',
  device_online:         'Cihaz Online',
  stp_anomaly:           'STP Anomali',
  loop_detected:         'Loop Tespit',
  port_change:           'Port Değişimi',
  new_device_connected:  'Yeni Cihaz Bağlandı',
  threshold_alert:       'Eşik Alarmı (SNMP)',
  high_cpu:              'Yüksek CPU',
  config_change:         'Config Değişimi',
  config_drift:          'Config Drift',
  backup_failure:        'Yedek Hatası',
  rotation_failure:      'Credential Rotasyon Hatası',
  topology_drift:        'Topoloji Drift',
  mac_loop_suspicion:    'MAC Döngü Şüphesi',
  mac_anomaly:           'MAC Anomalisi',
  traffic_spike:         'Trafik Artışı',
  vlan_anomaly:          'VLAN Anomalisi',
  device_flapping:       'Cihaz Flapping',
  agent_outage:          'Agent Kesintisi',
  correlation_incident:  'Kök Neden Analizi',
  security_audit_critical: 'Güvenlik Uyumu Kritik',
  playbook_failure:      'Playbook Hatası',
  lifecycle_alert:       'Lifecycle Uyarısı',
  rollout_failure:       'Config Rollout Hatası',
  sla_breach:            'SLA İhlali',
  local_anomaly:         'Agent-Lokal Anomali',
}

// ── Event detail modal helpers ────────────────────────────────────────────────

export interface EventDetail {
  icon: React.ReactNode
  what: string                           // 1-line explanation
  rows: { label: string; value: React.ReactNode }[]  // key-value detail rows
  links: { label: string; path: string; icon: React.ReactNode }[]
}

export function buildEventDetail(ev: NetworkEvent): EventDetail {
  const d = (ev.details || {}) as Record<string, any>
  const devSearch = ev.device_hostname
    ? `/devices?search=${encodeURIComponent(ev.device_hostname)}`
    : '/devices'

  switch (ev.event_type) {
    case 'mac_loop_suspicion': {
      const ports: string[] = Array.isArray(d.ports) ? d.ports : []
      const portList = ports.length > 0
        ? ports.map((p: string, i: number) => (
            <Tag key={i} color="volcano" style={{ marginBottom: 2 }}>{p}</Tag>
          ))
        : <Tag color="red">{d.port_count ?? '—'} farklı port</Tag>
      const actionTip = ports.length >= 2
        ? `"${ports[0]}" veya "${ports[1]}" portunu geçici olarak devre dışı bırakın, döngü kırılır.`
        : 'Spanning Tree durumunu ve port bağlantılarını kontrol edin.'
      return {
        icon: <SyncOutlined style={{ color: '#faad14' }} />,
        what: 'Aynı MAC adresi aynı cihazda birden fazla portta görüldü — büyük olasılıkla ağ döngüsü.',
        rows: [
          { label: 'Cihaz',      value: <Tag color="geekblue">{d.device ?? ev.device_hostname ?? '—'}</Tag> },
          { label: 'MAC Adresi', value: <Tag color="orange">{d.mac ?? '—'}</Tag> },
          { label: 'Etkilenen Portlar', value: <Space wrap size={4}>{portList}</Space> },
          { label: 'Öneri', value: actionTip },
          { label: 'Komut', value: (
            <Text code style={{ fontSize: 11 }}>
              show mac address-table address {d.mac ?? '<MAC>'}
            </Text>
          )},
        ],
        links: [
          { label: 'MAC / ARP Tablosu', path: '/mac-arp',  icon: <TableOutlined /> },
          { label: 'Cihaza Git',        path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',          path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }
    }

    case 'loop_detected':
    case 'stp_anomaly':
      return {
        icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
        what: ev.event_type === 'stp_anomaly'
          ? 'Spanning Tree anomalisi tespit edildi — port döngüsü veya topoloji değişimi olabilir.'
          : 'Cihaz log\'unda döngü/flap pattern\'i bulundu.',
        rows: [
          { label: 'Pattern', value: d.pattern ? <Tag color="red">{d.pattern}</Tag> : '—' },
          ...(d.snippet ? [{ label: 'Log Satırı', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {String(d.snippet).slice(0, 400)}
            </Text>
          )}] : []),
          { label: 'Öneri', value: 'Terminal\'den "show spanning-tree" çalıştırın ve port durumlarını inceleyin.' },
        ],
        links: [
          { label: 'Cihaza Git',  path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',    path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'device_offline':
      return {
        icon: <DisconnectOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Cihaza SSH bağlantısı kurulamıyor — erişilemiyor olabilir.',
        rows: [
          { label: 'Hata', value: ev.message || '—' },
          { label: 'Öneri', value: 'Güç kaynağını, kablo bağlantısını ve routing\'i kontrol edin.' },
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',   path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'device_flapping':
      return {
        icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Cihaz kısa sürede defalarca online/offline döngüsüne giriyor.',
        rows: [
          { label: 'Detay', value: ev.message || '—' },
          { label: 'Öneri', value: 'Güç kaynağı, NIC veya uplink kablosunu kontrol edin. Bireysel olaylar bastırılmış olabilir.' },
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    case 'agent_outage':
      return {
        icon: <RobotOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Proxy agent bağlantısı kesildi — aynı segmentteki cihazlar etkileniyor.',
        rows: [
          { label: 'Detay', value: ev.message || '—' },
          { label: 'Öneri', value: 'Agent servisini yeniden başlatın veya agent\'ın ağ bağlantısını kontrol edin.' },
        ],
        links: [
          { label: 'Agent Yönetimi', path: '/agents', icon: <RobotOutlined /> },
          { label: 'Topoloji',       path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'correlation_incident':
      return {
        icon: <ApartmentOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Kök neden analizi: tek cihaz arızası cascade etkisi yarattı.',
        rows: [
          { label: 'Etkilenen Cihaz Sayısı', value: <Tag color="red">{d.affected_count ?? '—'}</Tag> },
          ...(d.affected_devices?.length ? [{ label: 'Etkilenen Cihazlar', value: (
            <Space wrap size={4}>
              {(d.affected_devices as any[]).map((x: any) => (
                <Tag key={x.id} color="orange">{x.hostname}</Tag>
              ))}
            </Space>
          )}] : []),
          { label: 'Öneri', value: 'Topoloji haritasında kök cihazdan itibaren cascade\'i takip edin.' },
        ],
        links: [
          { label: 'Topoloji',    path: '/topology', icon: <ApartmentOutlined /> },
          { label: 'Kök Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    case 'mac_anomaly':
      return {
        icon: <TableOutlined style={{ color: '#faad14' }} />,
        what: 'MAC tablosu boyutu normalin çok üstünde — olağandışı trafik veya MAC flood saldırısı olabilir.',
        rows: [
          { label: 'Şu Anki MAC Sayısı', value: <Tag color="red">{d.current ?? '—'}</Tag> },
          { label: 'Normal Baseline',    value: <Tag color="blue">{d.baseline ?? '—'}</Tag> },
          { label: 'Öneri',              value: 'MAC/ARP tablosunu inceleyin, port güvenliği (port-security) konfigürasyonunu kontrol edin.' },
        ],
        links: [
          { label: 'MAC / ARP Tablosu', path: '/mac-arp', icon: <TableOutlined /> },
          { label: 'Cihaza Git',        path: devSearch,  icon: <ApiOutlined /> },
        ],
      }

    case 'traffic_spike':
      return {
        icon: <LineChartOutlined style={{ color: '#faad14' }} />,
        what: `${d.direction === 'gelen' ? 'Gelen' : 'Giden'} trafik baseline'ın 2 katına ulaştı.`,
        rows: [
          { label: 'Yön',      value: <Tag>{d.direction === 'gelen' ? '↓ Gelen' : '↑ Giden'}</Tag> },
          { label: 'Kullanım', value: <Tag color="red">%{d.current_pct ?? '—'}</Tag> },
          { label: 'Baseline', value: <Tag color="blue">%{d.baseline_pct ?? '—'}</Tag> },
          { label: 'Öneri',    value: 'Bant genişliği grafiğini inceleyip trafik kaynağını belirleyin.' },
        ],
        links: [
          { label: 'Bant Genişliği', path: '/bandwidth', icon: <LineChartOutlined /> },
          { label: 'Cihaza Git',     path: devSearch,    icon: <ApiOutlined /> },
        ],
      }

    case 'vlan_anomaly':
      return {
        icon: <BranchesOutlined style={{ color: '#faad14' }} />,
        what: 'Cihazda daha önce görülmemiş VLAN\'lar tespit edildi.',
        rows: [
          { label: 'Yeni VLAN\'lar', value: (
            <Space wrap size={4}>
              {(d.new_vlans || []).map((v: number) => <Tag key={v} color="orange">VLAN {v}</Tag>)}
            </Space>
          )},
          { label: 'Bilinen VLAN\'lar', value: (
            <Space wrap size={4}>
              {(d.known_vlans || []).slice(0, 10).map((v: number) => <Tag key={v}>{v}</Tag>)}
              {(d.known_vlans || []).length > 10 && <Tag>+{(d.known_vlans || []).length - 10}</Tag>}
            </Space>
          )},
          { label: 'Öneri', value: 'Yetkisiz VLAN eklenip eklenmediğini kontrol edin.' },
        ],
        links: [
          { label: 'VLAN Yönetimi', path: '/vlan',    icon: <BranchesOutlined /> },
          { label: 'Cihaza Git',    path: devSearch,  icon: <ApiOutlined /> },
        ],
      }

    case 'port_change':
      return {
        icon: <DisconnectOutlined style={{ color: '#faad14' }} />,
        what: 'Port durum değişikliği log\'da tespit edildi.',
        rows: [
          { label: 'Log Satırı', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {d.log_line || ev.message || '—'}
            </Text>
          )},
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    case 'threshold_alert':
      return {
        icon: <WarningOutlined style={{ color: '#f59e0b' }} />,
        what: `SNMP eşiği ihlali: ${d.rule_name ?? 'kural'} — ${d.if_name ?? 'interface'} üzerinde ${d.metric ?? 'metrik'} eşiği aşıldı.`,
        rows: [
          { label: 'Kural',       value: <Tag color="orange">{d.rule_name ?? '—'}</Tag> },
          { label: 'Interface',   value: <Tag color="geekblue">{d.if_name ?? '—'}</Tag> },
          { label: 'Metrik',      value: d.metric ?? '—' },
          { label: 'Değer',       value: <Tag color="red">{d.value != null ? `${d.value}${d.unit ?? ''}` : '—'}</Tag> },
          { label: 'Eşik',        value: d.threshold != null ? `${d.threshold}${d.unit ?? ''}` : '—' },
          { label: 'Ardışık İhlal', value: d.consecutive_count ? `${d.consecutive_count} poll` : '—' },
        ],
        links: [
          { label: 'Alert Kuralları', path: '/alert-rules', icon: <WarningOutlined /> },
          { label: 'Bant Genişliği',  path: '/bandwidth',   icon: <LineChartOutlined /> },
          { label: 'Cihaza Git',      path: devSearch,       icon: <ApiOutlined /> },
        ],
      }

    case 'config_drift':
      return {
        icon: <CodeOutlined style={{ color: '#f59e0b' }} />,
        what: 'Cihazın mevcut konfigürasyonu altın baseline\'dan saptı.',
        rows: [
          { label: 'Eklenen Satır',  value: d.lines_added   != null ? <Tag color="green">+{d.lines_added}</Tag>  : '—' },
          { label: 'Silinen Satır',  value: d.lines_removed != null ? <Tag color="red">−{d.lines_removed}</Tag> : '—' },
          { label: 'Öneri', value: 'Config Drift sayfasında farkı inceleyin ve gerekirse yapılandırmayı sıfırlayın.' },
        ],
        links: [
          { label: 'Config Drift', path: '/config-drift', icon: <CodeOutlined /> },
          { label: 'Cihaza Git',   path: devSearch,        icon: <ApiOutlined /> },
        ],
      }

    case 'topology_drift':
      return {
        icon: <ApartmentOutlined style={{ color: '#06b6d4' }} />,
        what: 'Ağ topolojisi altın baseline\'dan saptı — bağlantı eklendi veya kaldırıldı.',
        rows: [
          { label: 'Eklenen Bağlantı',  value: d.added_count   ? <Tag color="green">+{d.added_count}</Tag>  : '0' },
          { label: 'Silinen Bağlantı',  value: d.removed_count ? <Tag color="red">−{d.removed_count}</Tag> : '0' },
          { label: 'Baseline',          value: d.golden_name ?? '—' },
        ],
        links: [
          { label: 'Topoloji Twin', path: '/topology-twin', icon: <ApartmentOutlined /> },
          { label: 'Topoloji',      path: '/topology',      icon: <ApartmentOutlined /> },
        ],
      }

    case 'backup_failure':
      return {
        icon: <DatabaseOutlined style={{ color: '#ef4444' }} />,
        what: `${d.failed ?? '?'} cihazın yedeklemesi başarısız oldu.`,
        rows: [
          { label: 'Başarılı',   value: d.completed ?? '—' },
          { label: 'Başarısız',  value: <Tag color="red">{d.failed ?? '—'}</Tag> },
          ...(d.failed_devices?.length ? [{
            label: 'Başarısız Cihazlar',
            value: (
              <Space wrap size={4}>
                {(d.failed_devices as string[]).map((h: string) => <Tag key={h} color="red">{h}</Tag>)}
              </Space>
            ),
          }] : []),
        ],
        links: [
          { label: 'Yedekleme Merkezi', path: '/backups', icon: <DatabaseOutlined /> },
        ],
      }

    case 'rotation_failure':
      return {
        icon: <WarningOutlined style={{ color: '#ef4444' }} />,
        what: `Credential rotasyon hatası: ${d.failed_count ?? '?'} cihaz başarısız.`,
        rows: [
          { label: 'Politika ID',    value: d.policy_id ?? '—' },
          { label: 'Başarısız',      value: <Tag color="red">{d.failed_count ?? '—'}</Tag> },
          ...(d.failed_devices?.length ? [{
            label: 'Başarısız Cihazlar',
            value: (
              <Space wrap size={4}>
                {(d.failed_devices as any[]).slice(0, 5).map((r: any) => (
                  <Tag key={r.hostname} color="red">{r.hostname}</Tag>
                ))}
              </Space>
            ),
          }] : []),
        ],
        links: [
          { label: 'Ayarlar (Credentials)', path: '/settings', icon: <WarningOutlined /> },
        ],
      }

    case 'security_audit_critical': {
      const devices: any[] = Array.isArray(d.devices) ? d.devices : []
      return {
        icon: <ExclamationCircleOutlined style={{ color: '#ef4444' }} />,
        what: `Haftalık güvenlik taramasında ${d.critical_count ?? devices.length} cihazda kritik uyum skoru tespit edildi.`,
        rows: [
          { label: 'Kritik Cihaz Sayısı', value: <Tag color="red">{d.critical_count ?? '—'}</Tag> },
          ...(devices.length > 0 ? [{
            label: 'Cihazlar',
            value: (
              <Space wrap size={4}>
                {devices.slice(0, 8).map((c: any) => (
                  <Tooltip key={c.hostname} title={`Skor: ${c.score}/100 — Not: ${c.grade}`}>
                    <Tag color={c.grade === 'F' ? 'red' : 'orange'}>{c.hostname}</Tag>
                  </Tooltip>
                ))}
              </Space>
            ),
          }] : []),
        ],
        links: [
          { label: 'Güvenlik Denetimi', path: '/security-audit', icon: <ExclamationCircleOutlined /> },
        ],
      }
    }

    case 'playbook_failure': {
      const failedHosts: string[] = Array.isArray(d.failed_hosts) ? d.failed_hosts : []
      return {
        icon: <RobotOutlined style={{ color: '#ef4444' }} />,
        what: `"${d.playbook_name ?? 'Playbook'}" çalıştırmasında ${d.failed_count ?? '?'} cihaz başarısız oldu.`,
        rows: [
          { label: 'Playbook',       value: d.playbook_name ?? '—' },
          { label: 'Çalıştırma ID',  value: d.run_id ?? '—' },
          { label: 'Başarısız',      value: <Tag color="red">{d.failed_count ?? '—'}</Tag> },
          ...(failedHosts.length > 0 ? [{
            label: 'Başarısız Cihazlar',
            value: (
              <Space wrap size={4}>
                {failedHosts.slice(0, 8).map((h: string) => (
                  <Tag key={h} color="red">{h}</Tag>
                ))}
              </Space>
            ),
          }] : []),
        ],
        links: [
          { label: 'Playbook Çalıştırmaları', path: '/playbooks', icon: <RobotOutlined /> },
        ],
      }
    }

    case 'lifecycle_alert': {
      const alertList: string[] = Array.isArray(d.alerts) ? d.alerts : []
      return {
        icon: <WarningOutlined style={{ color: '#f59e0b' }} />,
        what: `${d.alert_count ?? alertList.length} cihazda garanti/EOL/EOS tarihleri yaklaşıyor.`,
        rows: [
          { label: 'Uyarı Sayısı', value: <Tag color="orange">{d.alert_count ?? '—'}</Tag> },
          ...(alertList.length > 0 ? [{
            label: 'Detaylar',
            value: (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {alertList.slice(0, 8).map((a: string, i: number) => <li key={i}>{a}</li>)}
              </ul>
            ),
          }] : []),
        ],
        links: [
          { label: 'Asset Lifecycle', path: '/lifecycle', icon: <DatabaseOutlined /> },
        ],
      }
    }

    case 'sla_breach': {
      const breaches: any[] = Array.isArray(d.breaches) ? d.breaches : []
      return {
        icon: <WarningOutlined style={{ color: '#f59e0b' }} />,
        what: `${d.breach_count ?? breaches.length} cihaz SLA hedefinin altında uptime'a sahip.`,
        rows: [
          { label: 'İhlal Sayısı', value: <Tag color="orange">{d.breach_count ?? '—'}</Tag> },
          ...(breaches.length > 0 ? [{
            label: 'Detaylar',
            value: (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {breaches.slice(0, 6).map((b: any, i: number) => (
                  <li key={i}>
                    <strong>{b.hostname}</strong>: {b.uptime_pct?.toFixed(2)}% (hedef: {b.target_pct}%, {b.window_days}g)
                  </li>
                ))}
              </ul>
            ),
          }] : []),
        ],
        links: [
          { label: 'SLA Raporu', path: '/sla', icon: <LineChartOutlined /> },
        ],
      }
    }

    case 'rollout_failure': {
      const failedHosts: string[] = Array.isArray(d.failed_hosts) ? d.failed_hosts : []
      return {
        icon: <CodeOutlined style={{ color: '#ef4444' }} />,
        what: `"${d.rollout_name ?? 'Config Rollout'}" sırasında ${d.failed_count ?? '?'} cihaza uygulama başarısız oldu.`,
        rows: [
          { label: 'Rollout',        value: d.rollout_name ?? '—' },
          { label: 'Rollout ID',     value: d.rollout_id ?? '—' },
          { label: 'Başarısız',      value: <Tag color="red">{d.failed_count ?? '—'}</Tag> },
          ...(failedHosts.length > 0 ? [{
            label: 'Başarısız Cihazlar',
            value: (
              <Space wrap size={4}>
                {failedHosts.slice(0, 8).map((h: string) => (
                  <Tag key={h} color="red">{h}</Tag>
                ))}
              </Space>
            ),
          }] : []),
        ],
        links: [
          { label: 'Config Rollout', path: '/change-management', icon: <CodeOutlined /> },
        ],
      }
    }

    case 'local_anomaly': {
      // Agent tarafından gönderilen local anomaly. Agent kendi taraflı bir
      // davranış değişikliği (örn. high_ssh_failure_rate) tespit edip
      // backend'e iletiyor. Cihaz bağımsız — agent geneline ait.
      const sub = (d.anomaly_type || ev.title || '').toLowerCase()
      const failRate = typeof d.fail_rate === 'number' ? d.fail_rate : null
      const failPct = failRate != null ? Math.round(failRate * 100) : null
      const windowSize = d.window_size ?? null

      let what = 'Agent tarafında bir lokal anomali tespit edildi.'
      let reasonRow: { label: string; value: React.ReactNode } | null = null
      let suggestion = 'Agent log\'larını ve hedeflediği cihazların erişilebilirliğini kontrol edin.'

      if (sub.includes('ssh') || sub.includes('high_ssh')) {
        what = 'Bu agent üzerinden dispatch edilen SON komutların büyük çoğunluğu BAŞARISIZ döndü. ' +
               'Genellikle hedef cihaz(lar)a SSH ile ulaşılamadığında oluşur — credential, ' +
               'network reach veya cihaz offline kaynaklı.'
        reasonRow = {
          label: 'Olası Neden', value: (
            <Text style={{ fontSize: 12 }}>
              • Hedef cihaz(lar) offline veya SSH portu engelli<br/>
              • Credential profili güncel değil (şifre değişti)<br/>
              • Agent ile cihaz arasında ağ kesintisi<br/>
              • Cihazda max SSH session limiti dolu
            </Text>
          ),
        }
        suggestion = 'Agentin son komut log\'larını incele (Agentlar sayfası). ' +
                     'Hedef cihazların ping/SSH testini yap. Credential rotasyonu son zamanlarda ' +
                     'yapıldıysa Kimlik Profilleri\'nden doğrula.'
      } else if (sub.includes('packet_loss') || sub.includes('ping_fail')) {
        what = 'Agent tarafı ping/ICMP probe\'unda yüksek paket kaybı algıladı.'
        suggestion = 'Hedef cihazın MTU, firewall ve link durumunu kontrol edin.'
      }

      return {
        icon: <RobotOutlined style={{ color: '#f59e0b' }} />,
        what,
        rows: [
          { label: 'Agent ID', value: <Tag color="geekblue" style={{ fontFamily: 'monospace' }}>{d.agent_id ?? '—'}</Tag> },
          { label: 'Anomali Türü', value: <Tag color="orange" style={{ fontFamily: 'monospace' }}>{d.anomaly_type ?? 'local_anomaly'}</Tag> },
          ...(failPct != null ? [{
            label: 'Başarısız Oran', value: (
              <Tag color={failPct >= 80 ? 'red' : failPct >= 50 ? 'orange' : 'gold'}>
                %{failPct}{windowSize ? ` (son ${windowSize} komut)` : ''}
              </Tag>
            ),
          }] : []),
          ...(reasonRow ? [reasonRow] : []),
          { label: 'Mesaj', value: ev.message ?? '—' },
          { label: 'Öneri', value: suggestion },
        ],
        links: [
          { label: 'Agentlar', path: '/agents', icon: <RobotOutlined /> },
          { label: 'Kimlik Profilleri', path: '/settings?tab=credentials', icon: <DatabaseOutlined /> },
        ],
      }
    }

    default:
      return {
        icon: <AlertOutlined style={{ color: '#faad14' }} />,
        what: ev.message || 'Detay için ilgili sayfaları kontrol edin.',
        rows: [
          ...(ev.message ? [{ label: 'Mesaj', value: ev.message }] : []),
          ...(Object.keys(d).length > 0 ? [{ label: 'Detaylar', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(d, null, 2)}
            </Text>
          )}] : []),
        ],
        links: [
          ...(ev.device_hostname ? [{ label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> }] : []),
        ],
      }
  }
}
