/**
 * Audit Log v2 PR 3 — Resource type → frontend route resolution.
 *
 * Pure utility — UI rendering YOK; route + module/action permission +
 * ikon adı döner. Çağıran AuditResourceLink useAuthStore().can() ile
 * yetki kontrolü yapar ve <Link to={...}> üretir.
 *
 * Resource type listesi (production audit_logs distinct):
 *   device (882) / user (24) / task (22) / ipam (12) / group (10) /
 *   agent (8) / tenant (8) / config_template (6) / security_audit (5) /
 *   organization (5) / terminal_session (4) / asset_lifecycle (3) /
 *   invite_token (1) / ipam_subnet (1) / ipam_zone (1) / compliance_profile (1)
 *
 * Route fallback'leri:
 *   - tenant, group, invite_token, compliance_profile, bilinmeyen → null
 *   - User/task/agent gibi detay route'u olmayanlar → liste sayfasına
 */

export type ResourceIconName =
  | 'device'
  | 'user'
  | 'task'
  | 'agent'
  | 'ipam'
  | 'security'
  | 'terminal'
  | 'lifecycle'
  | 'org'
  | 'template'
  | 'unknown'

export type ResourceRoute = {
  /** Tıklanabilir yol — frontend route'u (React Router) */
  path: string
  /** RBAC modülü; useAuthStore().can(module, action) ile kontrol edilir */
  module: string
  /** RBAC action */
  action: string
  /** UI ikonu için stabil isim (AuditResourceLink çözer) */
  icon: ResourceIconName
  /** Detay route'u var mı (true) vs sadece liste (false) — gelecekte ayrıştırma için */
  hasDetailRoute: boolean
}

/**
 * Resource type → route map.
 *
 * Anahtar `lowercase`. `id` placeholder olmadığında liste route'una düşer.
 *
 * Map'te olmayan veya null `type` için `resolveResourceRoute` null döner;
 * AuditResourceLink fallback olarak düz text + tooltip "Detay sayfası yok"
 * gösterir.
 */
const ROUTE_MAP: Record<string, Omit<ResourceRoute, 'path'> & { template: string }> = {
  // device — detay route'u VAR
  device: {
    template: '/devices/{id}',
    module: 'devices',
    action: 'view',
    icon: 'device',
    hasDetailRoute: true,
  },

  // user — detay yok, liste'ye git
  user: {
    template: '/users',
    module: 'users',
    action: 'view',
    icon: 'user',
    hasDetailRoute: false,
  },

  // task — liste
  task: {
    template: '/tasks',
    module: 'tasks',
    action: 'view',
    icon: 'task',
    hasDetailRoute: false,
  },

  // agent — liste
  agent: {
    template: '/agents',
    module: 'agents',
    action: 'view',
    icon: 'agent',
    hasDetailRoute: false,
  },

  // ipam + alt-tipler
  ipam: {
    template: '/ipam',
    module: 'ipam',
    action: 'view',
    icon: 'ipam',
    hasDetailRoute: false,
  },
  ipam_subnet: {
    template: '/ipam',
    module: 'ipam',
    action: 'view',
    icon: 'ipam',
    hasDetailRoute: false,
  },
  ipam_zone: {
    template: '/ipam',
    module: 'ipam',
    action: 'view',
    icon: 'ipam',
    hasDetailRoute: false,
  },

  // security_audit — sayfa
  security_audit: {
    template: '/security-audit',
    module: 'monitoring',
    action: 'view',
    icon: 'security',
    hasDetailRoute: false,
  },

  // terminal_session — sayfa
  terminal_session: {
    template: '/terminal-sessions',
    module: 'audit_logs',
    action: 'view',
    icon: 'terminal',
    hasDetailRoute: false,
  },

  // asset_lifecycle — sayfa
  asset_lifecycle: {
    template: '/asset-lifecycle',
    module: 'monitoring',
    action: 'view',
    icon: 'lifecycle',
    hasDetailRoute: false,
  },

  // organization — super_admin panel
  organization: {
    template: '/org-admin',
    module: 'org',
    action: 'view',
    icon: 'org',
    hasDetailRoute: false,
  },

  // config_template — App.tsx:319 ile uyumlu
  config_template: {
    template: '/config-templates',
    module: 'driver_templates',
    action: 'view',
    icon: 'template',
    hasDetailRoute: false,
  },

  // tenant / group / invite_token / compliance_profile → route YOK,
  // fallback'e düşer. Map'te bilerek bırakılmadı; resolveResourceRoute
  // null döner ve AuditResourceLink "düz text" davranışı gösterir.
}

/**
 * Resource type → ResourceRoute (id ile path birleşmiş) veya null.
 *
 * @param type — audit_logs.resource_type
 * @param id — audit_logs.resource_id (opsiyonel, detay route'u için)
 *
 * Null/undefined/empty/bilinmeyen type → null fallback (AuditResourceLink
 * düz text gösterir).
 */
export function resolveResourceRoute(
  type: string | null | undefined,
  id: string | null | undefined,
): ResourceRoute | null {
  if (!type || typeof type !== 'string') return null
  const key = type.trim().toLowerCase()
  if (!key) return null
  const entry = ROUTE_MAP[key]
  if (!entry) return null

  // hasDetailRoute=true ise id ile placeholder doldur; id yoksa liste'ye düş
  let path = entry.template
  if (entry.hasDetailRoute) {
    if (id && String(id).trim()) {
      path = entry.template.replace('{id}', encodeURIComponent(String(id)))
    } else {
      // id yoksa detay yapamayız → null fallback
      // Cihaz için id zorunlu; yoksa /devices/ olmaz.
      return null
    }
  }

  return {
    path,
    module: entry.module,
    action: entry.action,
    icon: entry.icon,
    hasDetailRoute: entry.hasDetailRoute,
  }
}

/**
 * Bir resource type'ın map'te olup olmadığını sorar (UI'da "Detay
 * sayfası yok" tooltip'i için kategori ayrımı yapılır):
 *   - inMap=true + path null → id eksikliği (örn. device id yok)
 *   - inMap=false → tip için route hiç tanımlı değil
 */
export function isKnownResourceType(type: string | null | undefined): boolean {
  if (!type || typeof type !== 'string') return false
  const key = type.trim().toLowerCase()
  return !!ROUTE_MAP[key]
}
