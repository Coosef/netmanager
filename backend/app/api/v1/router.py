from fastapi import APIRouter, Depends

from app.api.v1.endpoints import agents, agent_stream, ai_assistant, alert_rules, api_tokens, approvals, asset_lifecycle, auth, backup_schedules, change_rollouts, config_builder, config_templates, context, credential_profiles, dashboard, devices, diagnostics, driver_templates, escalation, firmware, incidents, intelligence, interfaces, internal, invites, ipam, locations, mac_arp, maintenance_windows, mfa, monitor, notifications, org_admin, password_policy, playbooks, poe, port_control, racks, reports, security_audit, security_policies, services, sla, snmp, super_admin, synthetic, system_settings, tasks, terminal_sessions, topology, topology_twin, users, ws
from app.core.deps import require_feature


# T10 Faz A1 — feature-gate helper. Bir router'ın tüm endpoint'lerine
# org plan kontrolü ekler (modül kapalı → 403). Super-admin bypass
# require_feature içinde. Core modüller (devices/monitor/dashboard/tasks/
# users/settings/reports/audit) gate'lenmez.
def _feat(key: str):
    return [Depends(require_feature(key))]


api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["Auth"])
api_router.include_router(context.router, prefix="/context", tags=["Context"])
api_router.include_router(users.router, prefix="/users", tags=["Users"])
api_router.include_router(mfa.router, prefix="/users", tags=["MFA"])
api_router.include_router(devices.router, prefix="/devices", tags=["Devices"])
api_router.include_router(interfaces.router, prefix="/devices", tags=["Interfaces"])
api_router.include_router(tasks.router, prefix="/tasks", tags=["Tasks"])
api_router.include_router(topology.router, prefix="/topology", tags=["Topology"], dependencies=_feat("topology"))
api_router.include_router(ws.router, prefix="/ws", tags=["WebSocket"])
api_router.include_router(agents.router, prefix="/agents", tags=["Agents"], dependencies=_feat("agents"))
api_router.include_router(agent_stream.router, prefix="/stream", tags=["Streaming"])
api_router.include_router(monitor.router, prefix="/monitor", tags=["Monitor"])
api_router.include_router(reports.router, prefix="/reports", tags=["Reports"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"])
api_router.include_router(playbooks.router, prefix="/playbooks", tags=["Playbooks"])
api_router.include_router(approvals.router, prefix="/approvals", tags=["Approvals"])
api_router.include_router(notifications.router, prefix="/notifications", tags=["Notifications"])
api_router.include_router(mac_arp.router, prefix="/mac-arp", tags=["MAC/ARP"])
api_router.include_router(ipam.router, prefix="/ipam", tags=["IPAM"], dependencies=_feat("ipam"))
api_router.include_router(security_audit.router, prefix="/security-audit", tags=["Security Audit"])
api_router.include_router(asset_lifecycle.router, prefix="/asset-lifecycle", tags=["Asset Lifecycle"])
api_router.include_router(system_settings.router, prefix="/system-settings", tags=["System Settings"])
api_router.include_router(password_policy.router, prefix="/password-policy", tags=["Password Policy"])
api_router.include_router(terminal_sessions.router, prefix="/terminal-sessions", tags=["Terminal Sessions"])
api_router.include_router(port_control.router, prefix="/devices", tags=["Port Control"])
api_router.include_router(diagnostics.router, prefix="/diagnostics", tags=["Diagnostics"])
api_router.include_router(snmp.router, prefix="/snmp", tags=["SNMP"])
api_router.include_router(alert_rules.router, prefix="/alert-rules", tags=["Alert Rules"])
api_router.include_router(maintenance_windows.router, prefix="/maintenance-windows", tags=["Maintenance Windows"])
api_router.include_router(credential_profiles.router, prefix="/credential-profiles", tags=["Credential Profiles"])
api_router.include_router(config_templates.router, prefix="/config-templates", tags=["Config Templates"])
api_router.include_router(change_rollouts.router, prefix="/change-rollouts", tags=["Change Rollouts"], dependencies=_feat("change_management"))
api_router.include_router(config_builder.router, prefix="/config-builder", tags=["Config Builder"], dependencies=_feat("config_builder"))
api_router.include_router(poe.router, prefix="/poe", tags=["PoE / Energy"], dependencies=_feat("poe"))
api_router.include_router(firmware.router, prefix="/firmware", tags=["Firmware"], dependencies=_feat("firmware"))
api_router.include_router(sla.router, prefix="/sla", tags=["SLA"], dependencies=_feat("sla"))
api_router.include_router(synthetic.router, prefix="/synthetic-probes", tags=["Synthetic Probes"], dependencies=_feat("synthetic_probes"))
api_router.include_router(incidents.router, prefix="/incidents", tags=["Incidents"], dependencies=_feat("incidents"))
api_router.include_router(api_tokens.router, prefix="/api-tokens", tags=["API Tokens"])
api_router.include_router(racks.router, prefix="/racks", tags=["Racks"], dependencies=_feat("racks"))
# M6 final drop — legacy /tenants router removed.
api_router.include_router(locations.router, prefix="/locations", tags=["Locations"])
api_router.include_router(backup_schedules.router, prefix="/backup-schedules", tags=["Backup Schedules"])
api_router.include_router(driver_templates.router, prefix="/driver-templates", tags=["Driver Templates"])
api_router.include_router(intelligence.router, prefix="/intelligence", tags=["Intelligence"])
api_router.include_router(services.router, prefix="/services", tags=["Services"])
api_router.include_router(topology_twin.router, prefix="/topology-twin", tags=["Topology Twin"], dependencies=_feat("topology_twin"))
api_router.include_router(ai_assistant.router, prefix="/ai", tags=["AI Assistant"], dependencies=_feat("ai_assistant"))
api_router.include_router(invites.router, prefix="/invites", tags=["Invites"])
api_router.include_router(super_admin.router, prefix="", tags=["Super Admin"])
api_router.include_router(org_admin.router, prefix="", tags=["Org Admin"])
api_router.include_router(internal.router, prefix="/internal", tags=["Internal"])
api_router.include_router(escalation.router, prefix="/escalation-rules", tags=["Escalation"], dependencies=_feat("escalation"))
api_router.include_router(security_policies.router, prefix="/security-policies", tags=["Security Policies"], dependencies=_feat("security_policy"))
