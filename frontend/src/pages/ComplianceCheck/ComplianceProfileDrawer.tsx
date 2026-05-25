// Standart Yönetimi — kullanıcı uyumluluk taraması için kural profillerini
// oluşturup düzenler. Hazır kural kataloğu backend'in
// services/security_audit_service.py BUILTIN_RULES'undan gelir; profil bir
// rule_id listesi (JSONB). is_default=true profili default tarama kullanır.
//
// MVP — sadece built-in toggle. Custom rule (kullanıcı kendi regex pattern'i
// ekler) v2'ye bırakıldı; o iş için ayrı bir UI + backend güvenli pattern
// execution gerekiyor.

import { useState, useEffect, useMemo } from 'react'
import {
  App, Button, Drawer, Form, Input, List, Popconfirm, Space, Switch, Tag, Tooltip,
  Empty, Divider,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined, SaveOutlined, ArrowLeftOutlined,
  CrownOutlined, FilterOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  securityAuditApi, type ComplianceProfile, type BuiltinRule,
} from '@/api/securityAudit'

interface Props {
  open: boolean
  onClose: () => void
}

type Editing = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; profile: ComplianceProfile }

export default function ComplianceProfileDrawer({ open, onClose }: Props) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [view, setView] = useState<Editing>({ kind: 'list' })

  const { data: rules = [] } = useQuery({
    queryKey: ['compliance-rules'],
    queryFn: () => securityAuditApi.listRules().then(r => r.rules),
    staleTime: 600_000,
    enabled: open,
  })
  const { data: profiles = [] } = useQuery({
    queryKey: ['compliance-profiles'],
    queryFn: () => securityAuditApi.listProfiles(),
    enabled: open,
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => securityAuditApi.deleteProfile(id),
    onSuccess: () => {
      message.success('Profil silindi')
      qc.invalidateQueries({ queryKey: ['compliance-profiles'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  // List view
  if (view.kind === 'list') {
    return (
      <Drawer
        open={open} onClose={onClose}
        title={<><FilterOutlined /> Uyumluluk Standartları</>}
        width={520}
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setView({ kind: 'new' })}>Yeni Profil</Button>}
      >
        <p style={{ color: 'var(--fg-2)', fontSize: 12, marginBottom: 16 }}>
          Tarama yaparken hangi kuralların kontrol edileceğini bir profilde toplayın.
          Varsayılan profile <CrownOutlined style={{ color: '#f59e0b' }} /> işaretlidir;
          tarama tetiklenirken profil seçilmezse o kullanılır.
        </p>

        {profiles.length === 0 ? (
          <Empty description={
            <>
              <div>Henüz profil yok</div>
              <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
                İlk profili oluşturduğunuzda &quot;Otomatik Tarama&quot; o profili kullanır.
              </div>
            </>
          } />
        ) : (
          <List
            dataSource={profiles}
            renderItem={(p) => {
              const enabledCount = p.enabled_rule_ids.length
              return (
                <List.Item
                  actions={[
                    <Button key="edit" size="small" icon={<EditOutlined />} onClick={() => setView({ kind: 'edit', profile: p })}>
                      Düzenle
                    </Button>,
                    <Popconfirm key="del"
                      title="Profili sil?"
                      description="Tarama sonuçları silinmez."
                      onConfirm={() => deleteMut.mutate(p.id)}
                      okButtonProps={{ danger: true }}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        {p.is_default && <CrownOutlined style={{ color: '#f59e0b' }} />}
                        <span>{p.name}</span>
                        <Tag color={enabledCount === rules.length ? 'green' : enabledCount === 0 ? 'red' : 'blue'}>
                          {enabledCount} / {rules.length} kural
                        </Tag>
                      </Space>
                    }
                    description={p.description || <span style={{ color: 'var(--fg-3)' }}>—</span>}
                  />
                </List.Item>
              )
            }}
          />
        )}
      </Drawer>
    )
  }

  return (
    <ProfileEditor
      open={open}
      onClose={onClose}
      onBack={() => setView({ kind: 'list' })}
      profile={view.kind === 'edit' ? view.profile : null}
      rules={rules}
    />
  )
}

// ── Sub: profile editor (create / edit) ───────────────────────────────────────
function ProfileEditor({
  open, onClose, onBack, profile, rules,
}: {
  open: boolean
  onClose: () => void
  onBack: () => void
  profile: ComplianceProfile | null
  rules: BuiltinRule[]
}) {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const isEdit = profile !== null

  const [name, setName] = useState(profile?.name || '')
  const [description, setDescription] = useState(profile?.description || '')
  const [enabledSet, setEnabledSet] = useState<Set<string>>(
    new Set(profile?.enabled_rule_ids || rules.map(r => r.id)),
  )
  const [isDefault, setIsDefault] = useState(profile?.is_default ?? false)

  // Yeni profilde rules listesi sonradan gelirse default olarak hepsini seç.
  useEffect(() => {
    if (!isEdit && enabledSet.size === 0 && rules.length > 0) {
      setEnabledSet(new Set(rules.map(r => r.id)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules.length])

  // Sync state when switching profiles in edit mode
  useEffect(() => {
    setName(profile?.name || '')
    setDescription(profile?.description || '')
    setEnabledSet(new Set(profile?.enabled_rule_ids || rules.map(r => r.id)))
    setIsDefault(profile?.is_default ?? false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  const categories = useMemo(() => {
    const byCat: Record<string, BuiltinRule[]> = {}
    for (const r of rules) {
      if (!byCat[r.category]) byCat[r.category] = []
      byCat[r.category].push(r)
    }
    return byCat
  }, [rules])

  const toggle = (id: string) => {
    setEnabledSet((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        enabled_rule_ids: Array.from(enabledSet),
        is_default: isDefault,
      }
      if (!payload.name) throw new Error('Profil adı gerekli')
      return isEdit && profile
        ? securityAuditApi.updateProfile(profile.id, payload)
        : securityAuditApi.createProfile(payload)
    },
    onSuccess: () => {
      message.success(isEdit ? 'Profil güncellendi' : 'Profil oluşturuldu')
      qc.invalidateQueries({ queryKey: ['compliance-profiles'] })
      onBack()
    },
    onError: (e: any) =>
      message.error(e?.response?.data?.detail || e?.message || 'Kayıt başarısız'),
  })

  return (
    <Drawer
      open={open} onClose={onClose}
      title={
        <Space>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack} type="text" />
          {isEdit ? `${profile?.name} Düzenle` : 'Yeni Profil'}
        </Space>
      }
      width={620}
      extra={
        <Space>
          <Button type="primary" icon={<SaveOutlined />}
            loading={saveMut.isPending}
            onClick={() => saveMut.mutate()}>
            Kaydet
          </Button>
        </Space>
      }
    >
      <Form layout="vertical">
        <Form.Item label="Profil Adı" required>
          <Input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="örn. PCI-DSS Asgari, ISO27001 Tam, Kendi Standardımız" />
        </Form.Item>
        <Form.Item label="Açıklama (opsiyonel)">
          <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Bu profilin amacı, hangi denetim çerçevesine karşılık geldiği vs." rows={2} />
        </Form.Item>
        <Form.Item label="Varsayılan Profil">
          <Switch checked={isDefault} onChange={setIsDefault}
            checkedChildren="Evet" unCheckedChildren="Hayır" />
          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--fg-2)' }}>
            Tarama tetiklerken profil seçilmezse bu profil kullanılır.
          </span>
        </Form.Item>
      </Form>

      <Divider style={{ margin: '8px 0 16px' }} />

      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0 }}>Kurallar</h4>
        <Tag color={enabledSet.size === rules.length ? 'green' : enabledSet.size === 0 ? 'red' : 'blue'}>
          {enabledSet.size} / {rules.length} seçili
        </Tag>
        <Space size={4} style={{ marginLeft: 'auto' }}>
          <Button size="small" onClick={() => setEnabledSet(new Set(rules.map(r => r.id)))}>Tümünü Aç</Button>
          <Button size="small" onClick={() => setEnabledSet(new Set())}>Tümünü Kapat</Button>
        </Space>
      </div>

      {Object.entries(categories).map(([cat, items]) => {
        const enabledInCat = items.filter(r => enabledSet.has(r.id)).length
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px',
              background: 'var(--bg-2)', borderRadius: 6,
              fontWeight: 600, fontSize: 12, color: 'var(--fg-1)',
              marginBottom: 4,
            }}>
              <span>{cat}</span>
              <Tag style={{ marginLeft: 'auto', fontSize: 10 }}>
                {enabledInCat}/{items.length}
              </Tag>
            </div>
            {items.map(r => {
              const on = enabledSet.has(r.id)
              return (
                <div key={r.id}
                  onClick={() => toggle(r.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                    background: on ? 'rgba(34,197,94,0.04)' : 'transparent',
                    borderLeft: `3px solid ${on ? '#22c55e' : 'var(--border)'}`,
                  }}>
                  <Switch size="small" checked={on} onClick={(_, e) => { e?.stopPropagation(); toggle(r.id) }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.desc}
                    </div>
                  </div>
                  <Tooltip title={`Skor ağırlığı: ${r.weight}p · Platformlar: ${r.platforms.join(', ')}`}>
                    <Tag style={{ fontFamily: 'monospace', fontSize: 10 }}>{r.weight}p</Tag>
                  </Tooltip>
                </div>
              )
            })}
          </div>
        )
      })}
    </Drawer>
  )
}
