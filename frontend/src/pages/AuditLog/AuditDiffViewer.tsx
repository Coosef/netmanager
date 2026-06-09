import { useState } from 'react'
import { Empty, Switch, Space, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  PlusOutlined,
  EditOutlined,
  MinusOutlined,
} from '@ant-design/icons'
import { isSensitiveField, maskedDisplayValue } from './auditFormatters'

/**
 * Audit Log v2 PR 2 — Field-level before/after diff viewer.
 *
 * Mevcut inline StateDiff'in evrimi:
 *   - added / changed / removed sayaçları (chip)
 *   - Nested object/array için güvenli pretty render (maskedDisplayValue)
 *   - Uzun değerler için truncate/ellipsis
 *   - "Sadece değişenleri göster" toggle
 *   - Sensitive field maskeleme (password/token/key/secret → ***)
 *   - Boş diff için anlamlı empty state
 */

export type DiffKind = 'added' | 'changed' | 'removed' | 'same'

export type DiffRow = {
  key: string
  before: unknown
  after: unknown
  kind: DiffKind
  /** Hassas alan ise true — UI'da değer ***'la maskelenir */
  sensitive: boolean
}

export type DiffSummary = {
  added: number
  changed: number
  removed: number
  rows: DiffRow[]
}

/**
 * Pure helper: before/after objelerinden DiffSummary üretir.
 * before_state veya after_state null/undefined olabilir; tek taraflı
 * diff'lerde added (after sadece) veya removed (before sadece) çıkar.
 */
export function computeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): DiffSummary {
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort()

  const rows: DiffRow[] = []
  let added = 0, changed = 0, removed = 0

  for (const key of keys) {
    const hasBefore = Object.prototype.hasOwnProperty.call(b, key)
    const hasAfter = Object.prototype.hasOwnProperty.call(a, key)
    let kind: DiffKind = 'same'

    if (hasBefore && !hasAfter) {
      kind = 'removed'
      removed++
    } else if (!hasBefore && hasAfter) {
      kind = 'added'
      added++
    } else if (hasBefore && hasAfter) {
      if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
        kind = 'changed'
        changed++
      }
    }

    rows.push({
      key,
      before: b[key],
      after: a[key],
      kind,
      sensitive: isSensitiveField(key),
    })
  }

  return { added, changed, removed, rows }
}

// ─── Render styling ─────────────────────────────────────────────────────────

const KIND_COLOR: Record<DiffKind, string> = {
  added:   '#22c55e',
  changed: '#f59e0b',
  removed: '#ef4444',
  same:    '#64748b',
}

const KIND_ICON: Record<DiffKind, React.ReactNode> = {
  added:   <PlusOutlined />,
  changed: <EditOutlined />,
  removed: <MinusOutlined />,
  same:    null,
}

// ─── Component ──────────────────────────────────────────────────────────────

type Props = {
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

export default function AuditDiffViewer({ before, after }: Props) {
  const { t } = useTranslation()
  const [onlyChanged, setOnlyChanged] = useState(true)

  // Empty state — hiç state yok
  if (!before && !after) {
    return (
      <div data-testid="audit-diff-empty" style={{ padding: 24 }}>
        <Empty
          description={t('audit.diff.no_state')}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    )
  }

  const summary = computeDiff(before, after)
  const visibleRows = onlyChanged
    ? summary.rows.filter((r) => r.kind !== 'same')
    : summary.rows

  // Hiç değişiklik yoksa farklı empty state
  if (summary.added + summary.changed + summary.removed === 0) {
    return (
      <div data-testid="audit-diff-no-change" style={{ padding: 24 }}>
        <Empty
          description={t('audit.diff.no_change')}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    )
  }

  return (
    <div data-testid="audit-diff-viewer">
      {/* Counters + toggle */}
      <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Space size={6}>
          {summary.added > 0 && (
            <Tag color="green" data-testid="audit-diff-counter-added">
              <PlusOutlined /> {t('audit.diff.count_added', { n: summary.added })}
            </Tag>
          )}
          {summary.changed > 0 && (
            <Tag color="orange" data-testid="audit-diff-counter-changed">
              <EditOutlined /> {t('audit.diff.count_changed', { n: summary.changed })}
            </Tag>
          )}
          {summary.removed > 0 && (
            <Tag color="red" data-testid="audit-diff-counter-removed">
              <MinusOutlined /> {t('audit.diff.count_removed', { n: summary.removed })}
            </Tag>
          )}
        </Space>
        <Space size={6}>
          <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            {t('audit.diff.only_changed')}
          </span>
          <Switch
            size="small"
            checked={onlyChanged}
            onChange={setOnlyChanged}
            data-testid="audit-diff-only-changed-toggle"
          />
        </Space>
      </Space>

      {/* Diff table */}
      <div
        style={{
          border: '1px solid var(--line-soft)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg-1)' }}>
              <th style={{ width: 24, padding: '6px 8px', textAlign: 'left' }} />
              <th style={{ width: 180, padding: '6px 8px', textAlign: 'left', color: 'var(--fg-3)' }}>
                {t('audit.diff.col_field')}
              </th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--fg-3)' }}>
                {t('audit.diff.col_before')}
              </th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--fg-3)' }}>
                {t('audit.diff.col_after')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.key}
                data-testid={`audit-diff-row-${row.key}`}
                data-kind={row.kind}
                style={{ borderTop: '1px solid var(--line-soft)' }}
              >
                <td style={{ padding: '4px 6px', color: KIND_COLOR[row.kind], textAlign: 'center' }}>
                  {KIND_ICON[row.kind]}
                </td>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace', color: 'var(--fg-2)' }}>
                  {row.key}
                  {row.sensitive && (
                    <Tag color="default" style={{ marginLeft: 6, fontSize: 10, padding: '0 4px' }}>
                      {t('audit.diff.sensitive_badge')}
                    </Tag>
                  )}
                </td>
                <DiffCell value={row.before} fieldName={row.key} highlight={row.kind !== 'same'} />
                <DiffCell value={row.after} fieldName={row.key} highlight={row.kind !== 'same'} kind={row.kind} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DiffCell({
  value,
  fieldName,
  highlight,
  kind,
}: {
  value: unknown
  fieldName: string
  highlight: boolean
  kind?: DiffKind
}) {
  // maskedDisplayValue zaten sensitive + nested + truncate yapıyor
  const display = maskedDisplayValue(fieldName, value)
  return (
    <td
      style={{
        padding: '4px 8px',
        fontFamily: 'monospace',
        fontSize: 11,
        color: highlight && kind === 'added' ? '#22c55e'
             : highlight && kind === 'removed' ? '#ef4444'
             : highlight ? 'var(--fg-1)'
             : 'var(--fg-3)',
        wordBreak: 'break-all',
        maxWidth: 280,
      }}
    >
      {display}
    </td>
  )
}
