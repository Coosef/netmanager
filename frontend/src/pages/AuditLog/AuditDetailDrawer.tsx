import { Drawer, Descriptions, Collapse, Space, Tag, Typography, Alert } from 'antd'
import { Trans, useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type { AuditLog } from '@/types'
import AuditActionChip from './AuditActionChip'
import AuditDiffViewer from './AuditDiffViewer'
import AuditResourceLink from './AuditResourceLink'
import { formatAuditAction, isSensitiveField, type AuditSummaryTone } from './auditFormatters'

const { Text } = Typography

/**
 * Audit Log v2 PR 2 — Modal → Drawer dönüşümü.
 *
 * 720px genişlik (mobile: 100vw). Header'da AuditActionChip + tarih.
 * Body 3 section:
 *   1. Descriptions — kullanıcı/IP/süre/request_id/UA (mevcut korundu)
 *   2. ÖZET — auditFormatters çıktısı, action-spesifik human-readable
 *   3. DEĞİŞİKLİK — AuditDiffViewer (sadece state varsa)
 *   4. GELIŞMIŞ / Raw Data — Collapse, sensitive alanlar maskelenir
 */

const TONE_TO_ALERT: Record<AuditSummaryTone, 'info' | 'success' | 'warning' | 'error'> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'error',
}

type Props = {
  record: AuditLog | null
  onClose: () => void
}

export default function AuditDetailDrawer({ record, onClose }: Props) {
  const { t } = useTranslation()

  // record null/undefined ise Drawer kapalı render — crash YOK
  const open = !!record

  if (!record) {
    return (
      <Drawer
        open={false}
        onClose={onClose}
        width={720}
        data-testid="audit-detail-drawer"
      />
    )
  }

  const summary = formatAuditAction(record)
  const hasStateChange = !!record.before_state || !!record.after_state
  const hasDetails = record.details && Object.keys(record.details).length > 0

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      destroyOnClose
      data-testid="audit-detail-drawer"
      title={
        <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={8}>
            <AuditActionChip action={record.action} status={record.status} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayjs(record.created_at).format('DD MMM YYYY · HH:mm:ss')}
            </Text>
          </Space>
        </Space>
      }
    >
      {/* ─── Descriptions ─── */}
      <Descriptions
        size="small"
        column={2}
        bordered
        style={{ marginBottom: 16 }}
        data-testid="audit-detail-descriptions"
      >
        <Descriptions.Item label={t('audit.detail.user')}>
          <Space size={4}>
            <Text>{record.username}</Text>
            {record.user_role && (
              <Tag style={{ fontSize: 10, padding: '0 5px' }}>{record.user_role}</Tag>
            )}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.date')}>
          {dayjs(record.created_at).format('DD.MM.YYYY HH:mm:ss')}
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.ip')}>
          <Text copyable style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {record.client_ip || '—'}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.duration')}>
          {record.duration_ms != null ? `${record.duration_ms.toFixed(0)} ms` : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.status')}>
          <Tag color={record.status === 'success' ? 'green' : 'red'}>{record.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.request_id')}>
          <Text copyable style={{ fontFamily: 'monospace', fontSize: 11 }}>
            {record.request_id || '—'}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('audit.detail.client')} span={2}>
          <Text style={{ fontSize: 11, color: 'var(--fg-3)' }}>{record.user_agent || '—'}</Text>
        </Descriptions.Item>
        {/* Audit Log v2 PR 3 — Kaynak satırı (AuditResourceLink). Permission
            + route resolution component'te ele alınır. */}
        <Descriptions.Item label={t('audit.detail.resource')} span={2}>
          <AuditResourceLink
            type={record.resource_type}
            id={record.resource_id}
            name={record.resource_name}
          />
        </Descriptions.Item>
      </Descriptions>

      {/* ─── ÖZET (auditFormatters çıktısı) ─── */}
      <div style={{ marginBottom: 16 }} data-testid="audit-detail-summary">
        <Text strong style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t('audit.detail.summary_title')}
        </Text>
        <Alert
          type={TONE_TO_ALERT[summary.tone]}
          showIcon
          style={{ marginTop: 6 }}
          message={
            <Trans
              i18nKey={summary.i18nKey}
              values={summary.values}
              components={{ b: <strong /> }}
            />
          }
        />
      </div>

      {/* ─── DEĞİŞİKLİK (diff varsa) ─── */}
      {hasStateChange && (
        <div style={{ marginBottom: 16 }} data-testid="audit-detail-diff">
          <Text strong style={{ fontSize: 12, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('audit.detail.diff_title')}
          </Text>
          <div style={{ marginTop: 6 }}>
            <AuditDiffViewer before={record.before_state} after={record.after_state} />
          </div>
        </div>
      )}

      {/* ─── GELIŞMIŞ / Raw Data ─── */}
      {hasDetails && (
        <Collapse
          ghost
          items={[
            {
              key: 'raw',
              label: (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('audit.detail.advanced')}
                </Text>
              ),
              children: (
                <pre
                  data-testid="audit-detail-raw"
                  style={{
                    fontSize: 11,
                    margin: 0,
                    maxHeight: 320,
                    overflow: 'auto',
                    background: '#0f172a',
                    color: '#94a3b8',
                    padding: '10px 14px',
                    borderRadius: 6,
                  }}
                >
                  {maskRawJson(record.details as Record<string, unknown>)}
                </pre>
              ),
            },
          ]}
        />
      )}
    </Drawer>
  )
}

/**
 * Raw JSON gösterirken sensitive alanları ***'la maskeler.
 * details içinde token/password gibi alanlar olabilir — Drawer'da
 * leak olmasın diye top-level + 1-seviye nested taranır.
 */
function maskRawJson(obj: Record<string, unknown> | null | undefined): string {
  if (!obj) return '{}'
  const masked = walkAndMask(obj)
  return JSON.stringify(masked, null, 2)
}

function walkAndMask(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]'  // recursion safety
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => walkAndMask(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveField(k) ? '***' : walkAndMask(v, depth + 1)
    }
    return out
  }
  return value
}
