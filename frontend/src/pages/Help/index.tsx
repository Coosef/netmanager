import { useState } from 'react'
import { Input, Collapse } from 'antd'
import {
  DashboardOutlined, LaptopOutlined, ApartmentOutlined,
  AlertOutlined, CloudOutlined, ClusterOutlined, BranchesOutlined,
  FileDoneOutlined, LineChartOutlined, SafetyOutlined, ThunderboltOutlined,
  CalendarOutlined, RiseOutlined, RobotOutlined, HddOutlined, BuildOutlined,
  AimOutlined, BarChartOutlined, RadarChartOutlined, QuestionCircleOutlined,
  SearchOutlined, CheckCircleOutlined, UserOutlined, QuestionOutlined,
  TagOutlined, CodeOutlined,
} from '@ant-design/icons'
import { useTheme } from '@/contexts/ThemeContext'
import { useTranslation } from 'react-i18next'

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#0f172a' : '#ffffff',
    bg2:    isDark ? '#1e293b' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#94a3b8' : '#64748b',
    dim:    isDark ? '#475569' : '#94a3b8',
    card:   isDark ? '#1e293b' : '#ffffff',
  }
}

const STEP_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b']

const ROLE_META = [
  { color: '#ef4444', titleKey: 'role_super_admin_title',        descKey: 'role_super_admin_desc' },
  { color: '#f97316', titleKey: 'role_admin_title',              descKey: 'role_admin_desc' },
  { color: '#8b5cf6', titleKey: 'role_org_viewer_title',         descKey: 'role_org_viewer_desc' },
  { color: '#3b82f6', titleKey: 'role_location_manager_title',   descKey: 'role_location_manager_desc' },
  { color: '#06b6d4', titleKey: 'role_location_operator_title',  descKey: 'role_location_operator_desc' },
  { color: '#22c55e', titleKey: 'role_location_viewer_title',    descKey: 'role_location_viewer_desc' },
]

const FAQ_ITEMS = [
  { qKey: 'faq_ssh_q',         aKey: 'faq_ssh_a' },
  { qKey: 'faq_agent_q',       aKey: 'faq_agent_a' },
  { qKey: 'faq_trap_q',        aKey: 'faq_trap_a' },
  { qKey: 'faq_flap_q',        aKey: 'faq_flap_a' },
  { qKey: 'faq_maintenance_q', aKey: 'faq_maintenance_a' },
  { qKey: 'faq_backup_q',      aKey: 'faq_backup_a' },
  { qKey: 'faq_drift_q',       aKey: 'faq_drift_a' },
  { qKey: 'faq_interface_q',   aKey: 'faq_interface_a' },
  { qKey: 'faq_vlan_q',        aKey: 'faq_vlan_a' },
  { qKey: 'faq_snmp_q',        aKey: 'faq_snmp_a' },
  { qKey: 'faq_readonly_q',    aKey: 'faq_readonly_a' },
  { qKey: 'faq_policy_q',      aKey: 'faq_policy_a' },
  { qKey: 'faq_csv_q',         aKey: 'faq_csv_a' },
  { qKey: 'faq_invite_q',      aKey: 'faq_invite_a' },
  { qKey: 'faq_location_q',    aKey: 'faq_location_a' },
]

const FEATURES = [
  { icon: <DashboardOutlined />,  color: '#3b82f6', titleKey: 'feat_dashboard_title',  descKey: 'feat_dashboard_desc' },
  { icon: <LaptopOutlined />,     color: '#8b5cf6', titleKey: 'feat_devices_title',    descKey: 'feat_devices_desc' },
  { icon: <ApartmentOutlined />,  color: '#06b6d4', titleKey: 'feat_topology_title',   descKey: 'feat_topology_desc' },
  { icon: <RadarChartOutlined />, color: '#8b5cf6', titleKey: 'feat_twin_title',        descKey: 'feat_twin_desc' },
  { icon: <AlertOutlined />,      color: '#ef4444', titleKey: 'feat_monitor_title',    descKey: 'feat_monitor_desc' },
  { icon: <CloudOutlined />,      color: '#10b981', titleKey: 'feat_backups_title',    descKey: 'feat_backups_desc' },
  { icon: <ClusterOutlined />,    color: '#f59e0b', titleKey: 'feat_ipam_title',       descKey: 'feat_ipam_desc' },
  { icon: <BranchesOutlined />,   color: '#6366f1', titleKey: 'feat_vlan_title',       descKey: 'feat_vlan_desc' },
  { icon: <FileDoneOutlined />,   color: '#0ea5e9', titleKey: 'feat_compliance_title', descKey: 'feat_compliance_desc' },
  { icon: <LineChartOutlined />,  color: '#a855f7', titleKey: 'feat_bandwidth_title',  descKey: 'feat_bandwidth_desc' },
  { icon: <SafetyOutlined />,     color: '#ef4444', titleKey: 'feat_security_title',   descKey: 'feat_security_desc' },
  { icon: <ThunderboltOutlined />,color: '#f59e0b', titleKey: 'feat_playbooks_title',  descKey: 'feat_playbooks_desc' },
  { icon: <CalendarOutlined />,   color: '#ec4899', titleKey: 'feat_change_title',     descKey: 'feat_change_desc' },
  { icon: <RiseOutlined />,       color: '#22c55e', titleKey: 'feat_sla_title',        descKey: 'feat_sla_desc' },
  { icon: <RobotOutlined />,      color: '#3b82f6', titleKey: 'feat_agents_title',     descKey: 'feat_agents_desc' },
  { icon: <RobotOutlined />,      color: '#6366f1', titleKey: 'feat_ai_title',         descKey: 'feat_ai_desc' },
  { icon: <TagOutlined />,        color: '#f59e0b', titleKey: 'feat_lifecycle_title',  descKey: 'feat_lifecycle_desc' },
  { icon: <HddOutlined />,        color: '#64748b', titleKey: 'feat_racks_title',      descKey: 'feat_racks_desc' },
  { icon: <BuildOutlined />,      color: '#84cc16', titleKey: 'feat_floor_title',      descKey: 'feat_floor_desc' },
  { icon: <AimOutlined />,        color: '#06b6d4', titleKey: 'feat_diagnostics_title',descKey: 'feat_diagnostics_desc' },
  { icon: <BarChartOutlined />,   color: '#8b5cf6', titleKey: 'feat_reports_title',    descKey: 'feat_reports_desc' },
  { icon: <RadarChartOutlined />, color: '#ef4444', titleKey: 'feat_snmptrap_title',  descKey: 'feat_snmptrap_desc' },
  { icon: <SafetyOutlined />,     color: '#10b981', titleKey: 'feat_maintenance_title', descKey: 'feat_maintenance_desc' },
  { icon: <CodeOutlined />,       color: '#0ea5e9', titleKey: 'feat_terminal_title',  descKey: 'feat_terminal_desc' },
  { icon: <CloudOutlined />,      color: '#64748b', titleKey: 'feat_syslog_title',    descKey: 'feat_syslog_desc' },
]

const QS_STEPS = [
  { titleKey: 'qs_step1_title', descKey: 'qs_step1_desc' },
  { titleKey: 'qs_step2_title', descKey: 'qs_step2_desc' },
  { titleKey: 'qs_step3_title', descKey: 'qs_step3_desc' },
  { titleKey: 'qs_step4_title', descKey: 'qs_step4_desc' },
]

export default function HelpPage() {
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const C = mkC(isDark)
  const [search, setSearch] = useState('')

  const q = search.toLowerCase().trim()
  const filteredFeatures = FEATURES.filter((f) =>
    !q ||
    t(`help.${f.titleKey}`).toLowerCase().includes(q) ||
    t(`help.${f.descKey}`).toLowerCase().includes(q)
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Hero */}
      <div style={{
        background: isDark
          ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)'
          : 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
        border: `1px solid ${isDark ? '#3b82f620' : '#bfdbfe'}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 14,
        padding: '24px 28px',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        flexWrap: 'wrap',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, flexShrink: 0,
          background: '#3b82f620',
          border: '1px solid #3b82f630',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <QuestionCircleOutlined style={{ color: '#3b82f6', fontSize: 26 }} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 22, lineHeight: 1.2 }}>
            {t('help.title')}
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
            {t('help.subtitle')}
          </div>
        </div>
        <Input
          prefix={<SearchOutlined style={{ color: C.dim }} />}
          placeholder={t('help.search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{
            width: 260, borderRadius: 8,
            background: isDark ? '#0e1e38' : '#f1f5f9',
            border: `1px solid ${C.border}`,
            color: C.text,
          }}
        />
      </div>

      {/* Quick Start — only show when not searching */}
      {!q && (
        <section>
          <SectionLabel label={t('help.section_quickstart')} isDark={isDark} C={C} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, marginTop: 10 }}>
            {QS_STEPS.map((step, i) => (
              <div key={i} style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderTop: `3px solid ${STEP_COLORS[i]}`,
                borderRadius: 10,
                padding: '16px 18px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 8,
                    background: `${STEP_COLORS[i]}20`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    <CheckCircleOutlined style={{ color: STEP_COLORS[i], fontSize: 14 }} />
                  </div>
                  <span style={{ color: STEP_COLORS[i], fontWeight: 700, fontSize: 13 }}>
                    {t(`help.${step.titleKey}`)}
                  </span>
                </div>
                <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
                  {t(`help.${step.descKey}`)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Features */}
      <section>
        <SectionLabel label={t('help.section_features')} isDark={isDark} C={C} />
        {filteredFeatures.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
            <RadarChartOutlined style={{ fontSize: 28, marginBottom: 8, display: 'block' }} />
            No results found
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, marginTop: 10 }}>
            {filteredFeatures.map((feat, i) => (
              <FeatureCard key={i} feat={feat} isDark={isDark} C={C} t={t} />
            ))}
          </div>
        )}
      </section>

      {/* Roles — only show when not searching */}
      {!q && (
        <section>
          <SectionLabel label={t('help.section_roles')} isDark={isDark} C={C} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginTop: 10 }}>
            {ROLE_META.map((role, i) => (
              <div key={i} style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderLeft: `4px solid ${role.color}`,
                borderRadius: 10,
                padding: '14px 16px',
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: `${role.color}20`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <UserOutlined style={{ color: role.color, fontSize: 14 }} />
                </div>
                <div>
                  <div style={{ color: role.color, fontWeight: 700, fontSize: 13 }}>
                    {t(`help.${role.titleKey}`)}
                  </div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                    {t(`help.${role.descKey}`)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* FAQ — only show when not searching */}
      {!q && (
        <section>
          <SectionLabel label={t('help.section_faq')} isDark={isDark} C={C} />
          <Collapse
            style={{ marginTop: 10, background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 10 }}
            items={FAQ_ITEMS.map((item, i) => ({
              key: i,
              label: (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <QuestionOutlined style={{ color: '#3b82f6', fontSize: 13 }} />
                  <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>
                    {t(`help.${item.qKey}`)}
                  </span>
                </div>
              ),
              children: (
                <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.7, paddingLeft: 22 }}>
                  {t(`help.${item.aKey}`)}
                </div>
              ),
              style: {
                background: isDark ? '#1e293b' : '#ffffff',
                borderColor: C.border,
              },
            }))}
          />
        </section>
      )}
    </div>
  )
}

function SectionLabel({ label, isDark, C }: { label: string; isDark: boolean; C: ReturnType<typeof mkC> }) {
  return (
    <div style={{
      color: isDark ? '#3b82f6' : '#64748b',
      fontSize: 11, fontWeight: 700,
      letterSpacing: '0.1em',
      paddingBottom: 6,
      borderBottom: `1px solid ${C.border}`,
    }}>
      {label}
    </div>
  )
}

function FeatureCard({
  feat, isDark, C, t,
}: {
  feat: typeof FEATURES[0];
  isDark: boolean;
  C: ReturnType<typeof mkC>;
  t: (key: string) => string;
}) {
  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      transition: 'border-color 0.15s',
    }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = feat.color + '60' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = isDark ? '#334155' : '#e2e8f0' }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 9, flexShrink: 0,
        background: `${feat.color}18`,
        border: `1px solid ${feat.color}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, color: feat.color,
      }}>
        {feat.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>
          {t(`help.${feat.titleKey}`)}
        </div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>
          {t(`help.${feat.descKey}`)}
        </div>
      </div>
    </div>
  )
}
