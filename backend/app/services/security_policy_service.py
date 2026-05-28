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

from app.models.security_policy import PortSecurityPolicy, SwitchSecurityPolicy

FALLBACK_NAME = "(hardcoded-fallback)"


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
    # 1. v2: per-port override (port_name) — şimdilik yok, imzada bırakıldı.
    pid = getattr(device, "port_security_policy_id", None)
    if pid:
        p = await db.get(PortSecurityPolicy, pid)
        if p is not None:
            return p
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
