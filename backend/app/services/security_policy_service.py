"""T10 Faz C C2 — Security Policy resolver + default yönetimi.

Resolver zinciri (NULL semantic korunur — döndürülen policy'nin alanları NULL ise
ilgili kontrol kapalıdır):

  resolve_switch_policy(db, device):
    1. device.security_policy_id (atanmış switch policy)
    2. org'un is_default=true switch policy'si
    3. hardcoded fallback (kod sabiti, en güvenli baseline)

  resolve_port_policy(db, device, port_name=None):
    1. (v2: per-port override — port_name ile)
    2. device.port_security_policy_id (cihaz-geneli varsayılan port policy)
    3. org'un is_default=true port policy'si
    4. hardcoded fallback

Fallback'ler transient (DB'ye yazılmaz) model örnekleridir; yalnız eşik okuma içindir.
RLS: resolver org-scoped session'da çalışır → org dışı policy görünmez (Faz 7).
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.port_policy_assignment import PortPolicyAssignment
from app.models.security_policy import PortSecurityPolicy, SwitchSecurityPolicy

FALLBACK_NAME = "(hardcoded-fallback)"

# C6c — bu motorun ürettiği NetworkEvent.event_type'ları. UI'da "Politika olayları"
# filtresi (monitor /events?policy_only=true) bu küme üzerinden çalışır. Yeni bir
# event_type eklenirse buraya da eklenmeli (tek kaynak).
POLICY_EVENT_TYPES = ("high_cpu", "high_memory", "mac_flood", "mac_flap")


def _fallback_switch() -> SwitchSecurityPolicy:
    """En güvenli baseline (docx Default'a yakın). Transient — persist edilmez."""
    return SwitchSecurityPolicy(
        name=FALLBACK_NAME, organization_id=None, is_default=False,
        cpu_warning=70, cpu_critical=85,
        memory_warning=80, memory_critical=90,
        temp_warning=55, temp_critical=70,
        offline_timeout_min=5,
        poe_budget_warning_pct=80, poe_budget_critical_pct=95,
        config_change_policy="info",
    )


def _fallback_port() -> PortSecurityPolicy:
    return PortSecurityPolicy(
        name=FALLBACK_NAME, organization_id=None, is_default=False,
        mac_flood_warning=5, mac_flood_critical=10,
        vlan_change_alert_enabled=True, new_mac_alert_enabled=True,
        bandwidth_alert_pct=90,
    )


async def resolve_switch_policy(db: AsyncSession, device) -> SwitchSecurityPolicy:
    pid = getattr(device, "security_policy_id", None)
    if pid:
        p = await db.get(SwitchSecurityPolicy, pid)
        if p is not None:
            return p
    org_id = getattr(device, "organization_id", None)
    if org_id is not None:
        p = (await db.execute(
            select(SwitchSecurityPolicy).where(
                SwitchSecurityPolicy.organization_id == org_id,
                SwitchSecurityPolicy.is_default.is_(True),
            )
        )).scalar_one_or_none()
        if p is not None:
            return p
    return _fallback_switch()


async def resolve_port_policy(
    db: AsyncSession, device, port_name: Optional[str] = None,
) -> PortSecurityPolicy:
    """Port policy resolver — zincir:
      1) PortPolicyAssignment (device_id+port_name)  ← C7.A per-port override
      2) device.port_security_policy_id              (C6b cihaz default)
      3) org is_default=true PortSecurityPolicy       (C2 org default)
      4) hardcoded fallback                           (C2)
    port_name=None ya da assignment yoksa 1. adım atlanır."""
    # 1) Per-port override (C7.A) — port_name + device.id varsa.
    dev_id = getattr(device, "id", None)
    if port_name and dev_id is not None:
        ppa = (await db.execute(
            select(PortPolicyAssignment).where(
                PortPolicyAssignment.device_id == dev_id,
                PortPolicyAssignment.port_name == port_name,
                PortPolicyAssignment.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if ppa is not None:
            p = await db.get(PortSecurityPolicy, ppa.port_security_policy_id)
            if p is not None:
                return p
    # 2) Cihaz-default (C6b).
    pid = getattr(device, "port_security_policy_id", None)
    if pid:
        p = await db.get(PortSecurityPolicy, pid)
        if p is not None:
            return p
    # 3) Org default.
    org_id = getattr(device, "organization_id", None)
    if org_id is not None:
        p = (await db.execute(
            select(PortSecurityPolicy).where(
                PortSecurityPolicy.organization_id == org_id,
                PortSecurityPolicy.is_default.is_(True),
            )
        )).scalar_one_or_none()
        if p is not None:
            return p
    # 4) Fallback.
    return _fallback_port()


async def set_default(db: AsyncSession, model_cls, organization_id: int, policy_id: int) -> None:
    """Bir policy'yi org'un default'u yap — eski default'un flag'ini atomic olarak kaldır
    (partial-unique `WHERE is_default` çakışmasını engeller). Caller commit eder."""
    await db.execute(
        update(model_cls)
        .where(model_cls.organization_id == organization_id, model_cls.is_default.is_(True))
        .values(is_default=False)
    )
    await db.execute(
        update(model_cls)
        .where(model_cls.id == policy_id, model_cls.organization_id == organization_id)
        .values(is_default=True)
    )


def policy_label(policy) -> str:
    """Alarm mesajı etiketi için policy adı: `[policy=<name>]` (C3'te kullanılır)."""
    return getattr(policy, "name", None) or FALLBACK_NAME


# ── C3 — senkron worker (Celery sync task'ları) için varyantlar ──────────────

def resolve_switch_policy_sync(db, device) -> SwitchSecurityPolicy:
    """resolve_switch_policy'nin senkron eşi (SyncSessionLocal). Fleet task'larda
    superadmin context → RLS bypass; org default lookup org_id ile filtrelenir."""
    pid = getattr(device, "security_policy_id", None)
    if pid:
        p = db.get(SwitchSecurityPolicy, pid)
        if p is not None:
            return p
    org_id = getattr(device, "organization_id", None)
    if org_id is not None:
        p = db.execute(
            select(SwitchSecurityPolicy).where(
                SwitchSecurityPolicy.organization_id == org_id,
                SwitchSecurityPolicy.is_default.is_(True),
            )
        ).scalar_one_or_none()
        if p is not None:
            return p
    return _fallback_switch()


def evaluate_switch_health(hostname: str, policy, metrics: dict) -> list[dict]:
    """CPU/Memory eşik değerlendirmesi — saf (DB/SNMP yok). NULL eşik → skip,
    NULL metrik → skip. critical > warning önceliği. Mesaj `[policy=<name>]` etiketli.
    Dönüş: [{metric, event_type, severity, message, details}] (alarm specs)."""
    label = f" [policy={policy_label(policy)}]"
    pname = policy_label(policy)
    out: list[dict] = []

    cpu = metrics.get("cpu_pct")
    if cpu is not None:
        crit = getattr(policy, "cpu_critical", None)
        warn = getattr(policy, "cpu_warning", None)
        if crit is not None and cpu >= crit:
            out.append(dict(metric="cpu", event_type="high_cpu", severity="critical",
                            message=f"{hostname} CPU %{cpu:.0f} (kritik eşik %{crit}){label}",
                            details={"value": cpu, "threshold": crit, "policy": pname}))
        elif warn is not None and cpu >= warn:
            out.append(dict(metric="cpu", event_type="high_cpu", severity="warning",
                            message=f"{hostname} CPU %{cpu:.0f} (uyarı eşik %{warn}){label}",
                            details={"value": cpu, "threshold": warn, "policy": pname}))

    ram = metrics.get("ram_pct")
    if ram is not None:
        crit = getattr(policy, "memory_critical", None)
        warn = getattr(policy, "memory_warning", None)
        if crit is not None and ram >= crit:
            out.append(dict(metric="mem", event_type="high_memory", severity="critical",
                            message=f"{hostname} RAM %{ram:.0f} (kritik eşik %{crit}){label}",
                            details={"value": ram, "threshold": crit, "policy": pname}))
        elif warn is not None and ram >= warn:
            out.append(dict(metric="mem", event_type="high_memory", severity="warning",
                            message=f"{hostname} RAM %{ram:.0f} (uyarı eşik %{warn}){label}",
                            details={"value": ram, "threshold": warn, "policy": pname}))
    return out


def resolve_port_policy_sync(db, device, port_name: Optional[str] = None) -> PortSecurityPolicy:
    """resolve_port_policy'nin senkron eşi. Zincir async ile aynı:
    per-port override → cihaz default → org default → fallback."""
    dev_id = getattr(device, "id", None)
    if port_name and dev_id is not None:
        ppa = db.execute(
            select(PortPolicyAssignment).where(
                PortPolicyAssignment.device_id == dev_id,
                PortPolicyAssignment.port_name == port_name,
                PortPolicyAssignment.deleted_at.is_(None),
            )
        ).scalar_one_or_none()
        if ppa is not None:
            p = db.get(PortSecurityPolicy, ppa.port_security_policy_id)
            if p is not None:
                return p
    pid = getattr(device, "port_security_policy_id", None)
    if pid:
        p = db.get(PortSecurityPolicy, pid)
        if p is not None:
            return p
    org_id = getattr(device, "organization_id", None)
    if org_id is not None:
        p = db.execute(
            select(PortSecurityPolicy).where(
                PortSecurityPolicy.organization_id == org_id,
                PortSecurityPolicy.is_default.is_(True),
            )
        ).scalar_one_or_none()
        if p is not None:
            return p
    return _fallback_port()


import re as _re

# C4a — uplink/trunk port heuristic: docx'teki uplink preset (mac_flood=NULL) niyetini
# v1 device-level granülaritede taklit eder. Bu portlar binlerce MAC taşır → flood false-positive.
# İleride system_settings ile override edilebilir (şimdilik kod sabiti).
_UPLINK_CONTAINS = ("tengigabit", "fortygig", "hundredgig", "port-channel",
                    "trunk", "uplink", "aggregation", "portchannel")
_UPLINK_PREFIX = _re.compile(r"^(te|fo|hu|po|lag|ae|bond)\d")


def is_uplink_port(port_name) -> bool:
    """Port adı uplink/trunk/aggregation paternine uyuyor mu (flood skip için)."""
    if not port_name:
        return False
    n = str(port_name).strip().lower()
    if any(p in n for p in _UPLINK_CONTAINS):
        return True
    return bool(_UPLINK_PREFIX.match(n.replace(" ", "")))


def evaluate_port_flood(hostname: str, port, mac_count: int, policy) -> Optional[dict]:
    """C4a — port başına MAC sayısı eşik değerlendirmesi (saf). NULL eşik → None (skip).
    critical > warning. `[policy=<name>]` etiketli alarm spec döner ya da None."""
    label = f" [policy={policy_label(policy)}]"
    pname = policy_label(policy)
    crit = getattr(policy, "mac_flood_critical", None)
    warn = getattr(policy, "mac_flood_warning", None)
    if crit is not None and mac_count >= crit:
        return dict(event_type="mac_flood", severity="critical",
                    message=f"{hostname} port {port}: {mac_count} MAC (kritik eşik {crit}){label}",
                    details={"port": port, "mac_count": mac_count, "threshold": crit, "policy": pname})
    if warn is not None and mac_count >= warn:
        return dict(event_type="mac_flood", severity="warning",
                    message=f"{hostname} port {port}: {mac_count} MAC (uyarı eşik {warn}){label}",
                    details={"port": port, "mac_count": mac_count, "threshold": warn, "policy": pname})
    return None


def evaluate_mac_flap(redis, policy, org_id, device_id, mac, hostname, port) -> Optional[dict]:
    """C4b — port-transition flap. _collect_device bir MAC'in portu DEĞİŞTİĞİNDE çağırır.
    Redis sayaç (key org/device/mac, TTL=mac_flap_window_min); transition ≥
    mac_flap_min_transitions → flap alarm spec (DRY-RUN öneri; **gerçek shutdown YOK**).
    NULL pencere/eşik → None (kontrol kapalı). Alarm breach'te bir kez (dedup key)."""
    window = getattr(policy, "mac_flap_window_min", None)
    min_tr = getattr(policy, "mac_flap_min_transitions", None)
    if window is None or min_tr is None:
        return None
    key = f"secpol:flap:{org_id}:{device_id}:{mac}"
    try:
        cnt = redis.incr(key)
        if cnt == 1:
            redis.expire(key, int(window) * 60)
    except Exception:  # noqa: BLE001 — Redis yoksa flap takibi sessizce atlanır
        return None
    if cnt < int(min_tr):
        return None
    # Breach'te tek alarm (pencere boyunca dedup).
    alarm_key = f"secpol:flapalarm:{org_id}:{device_id}:{mac}"
    try:
        if redis.exists(alarm_key):
            return None
        redis.setex(alarm_key, int(window) * 60, "1")
    except Exception:  # noqa: BLE001
        pass
    pname = policy_label(policy)
    nth = getattr(policy, "auto_quarantine_on_nth_flap", None)
    return dict(
        event_type="mac_flap", severity="warning",
        message=f"MAC {mac} flapping: {cnt} port değişimi (eşik {min_tr}) [policy={pname}]",
        details={
            "mac": mac, "transitions": cnt, "threshold": int(min_tr), "policy": pname,
            "current_port": port,
            # C4b — DRY-RUN öneri; gerçek shutdown YOK (C5 kill-switch+approval ile gelir).
            "dry_run": True, "suggested_action": "quarantine_port",
            "auto_quarantine_on_nth_flap": nth,
        },
    )


async def security_policy_enabled(db, organization_id) -> bool:
    """security_policy_enabled_sync'in async eşi (async session)."""
    if organization_id is None:
        return True
    from app.core.features import feature_enabled
    from app.models.shared.organization import Organization
    from app.models.shared.plan import Plan
    org = await db.get(Organization, organization_id)
    if org is None or org.plan_id is None:
        return True
    plan = await db.get(Plan, org.plan_id)
    return feature_enabled(plan.features if plan else None, "security_policy")


def security_policy_enabled_sync(db, organization_id) -> bool:
    """org'un planında security_policy feature açık mı (sync). Opt-out: org/plan/feature
    yoksa açık. Task'lar org feature kapalıysa policy check'i atlar (super-admin bypass YOK —
    arka plan task'ı org'un planına uyar)."""
    if organization_id is None:
        return True
    from app.core.features import feature_enabled
    from app.models.shared.organization import Organization
    from app.models.shared.plan import Plan
    org = db.get(Organization, organization_id)
    if org is None or org.plan_id is None:
        return True
    plan = db.get(Plan, org.plan_id)
    return feature_enabled(plan.features if plan else None, "security_policy")
