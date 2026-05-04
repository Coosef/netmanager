"""Multi-provider AI service: Claude, OpenAI, Gemini, Ollama."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any

import httpx
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_settings import AISettings
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.playbook import Playbook
from app.models.backup_schedule import BackupSchedule
from app.models.alert_rule import AlertRule
from app.models.config_backup import ConfigBackup
from app.models.config_template import ConfigTemplate
from app.core.security import decrypt_credential_safe


SYSTEM_PROMPT = """Sen NetManager ağ yönetim platformunun AI asistanısın.
Kullanıcı sana ağ altyapısı, cihazlar, olaylar ve analizler hakkında sorular soracak.
Kısa, net ve pratik cevaplar ver. Türkçe sorulara Türkçe, İngilizce sorulara İngilizce cevap ver.
Sadece ağ yönetimiyle ilgili konularda yardım et; anlık ağ verisini sana sağlayacağım.

{context}"""

MODE_PROMPTS: dict[str, str] = {
    "analyze": """
Analiz modundasın. Karmaşık sorular için yanıtını şu markdown başlıkları ile yapılandır (uygunsa):
## 🔍 Analiz Sonucu
## 🎯 Kök Neden
## 📊 Etki
## ⚠️ Risk Seviyesi
## ✅ Önerilen Aksiyonlar
Basit sorularda düz metin yeterli.""",
    "troubleshoot": """
Sorun giderme modundasın. Adım adım komut ve kontrol listesi ver.
Yanıtını şu başlıklarla yapılandır (uygunsa):
## 🛠️ Sorun Tespiti
## 📋 Kontrol Listesi
## 💻 Komutlar
## 🔄 Sonraki Adımlar""",
    "automate": """
Otomasyon modundasın. Sana "NETMANAGER OTOMASYON VARLIĞI" başlığıyla sistemde MEVCUT olan özellikler verildi.
KESİNLİKLE dış betik (Python/Bash/Netmiko/NAPALM), harici araç veya sıfırdan kod yazmayı önerme.
Her öneride "NetManager → [Menü Adı]" formatında nereye gidileceğini söyle.
Mevcut playbook/schedule/rule eksikse, kullanıcıya NetManager'da nasıl oluşturacağını adım adım anlat.
Yanıtını şu başlıklarla yapılandır:
## 🤖 Otomasyon Fırsatı
## 📜 Önerilen Playbook / Kural
## ⚙️ NetManager'da Nasıl Yapılır""",
    "security": """
Güvenlik modundasın. Sana yukarıda "GÜVENLİK DENETİM RAPORU" başlığıyla gerçek sistem verisi verildi.
SADECE bu veriye dayanarak yanıt ver — genel/teorik güvenlik tavsiyesi verme.
Her bulgu için hangi cihazı, olayı veya konumu kastettiğini açıkça belirt.
Herhangi bir cihaz SSH/SNMP ile bağlanmadan, yalnızca pasif veri analizi yaptığını hatırlat.
Yanıtını şu başlıklarla yapılandır:
## 🛡️ Güvenlik Analizi
## 🚨 Tespit Edilen Riskler
## 🔒 Güvenlik Önerileri
## 📌 Acil Aksiyonlar""",
}


async def build_network_context(db: AsyncSession) -> str:
    now = datetime.now(timezone.utc)
    since_24h = now - timedelta(hours=24)

    total_devices = await db.scalar(
        select(func.count(Device.id)).where(Device.is_active == True)
    ) or 0
    online_devices = await db.scalar(
        select(func.count(Device.id)).where(Device.is_active == True, Device.status == "online")
    ) or 0
    offline_devices = await db.scalar(
        select(func.count(Device.id)).where(Device.is_active == True, Device.status == "offline")
    ) or 0

    recent_events_rows = await db.execute(
        select(NetworkEvent.event_type, func.count(NetworkEvent.id).label("cnt"))
        .where(NetworkEvent.created_at >= since_24h)
        .group_by(NetworkEvent.event_type)
        .order_by(desc("cnt"))
        .limit(8)
    )
    event_summary = ", ".join(
        f"{r.event_type}({r.cnt})" for r in recent_events_rows
    ) or "yok"

    last_critical_rows = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.severity.in_(["critical", "high"]), NetworkEvent.created_at >= since_24h)
        .order_by(desc(NetworkEvent.created_at))
        .limit(3)
    )
    critical_lines = []
    for ev in last_critical_rows.scalars():
        ago_min = int((now - ev.created_at.replace(tzinfo=timezone.utc)).total_seconds() / 60)
        critical_lines.append(f"  - {ev.title} ({ago_min} dk önce)")
    critical_text = "\n".join(critical_lines) or "  - yok"

    anomaly_types = ("mac_anomaly", "traffic_spike", "vlan_anomaly", "mac_loop_suspicion", "local_anomaly")
    anomaly_count = await db.scalar(
        select(func.count(NetworkEvent.id))
        .where(NetworkEvent.event_type.in_(anomaly_types), NetworkEvent.created_at >= since_24h)
    ) or 0

    return f"""
=== ANLИК AĞ DURUMU ({now.strftime('%Y-%m-%d %H:%M')} UTC) ===

[CİHAZLAR]
Toplam aktif: {total_devices} | Online: {online_devices} | Offline: {offline_devices}

[SON 24 SAAT OLAYLAR]
Olay tipleri: {event_summary}

[KRİTİK OLAYLAR (son 24s)]
{critical_text}

[ANOMALİLER (son 24s)]
Davranış anomali sayısı: {anomaly_count}
""".strip()


async def build_security_context(db: AsyncSession) -> str:
    """Deep security context — read-only DB queries, no device connections."""
    now = datetime.now(timezone.utc)
    since_24h = now - timedelta(hours=24)
    since_7d  = now - timedelta(days=7)

    # ── 1. Offline devices with full detail ─────────────────────────────────
    offline_rows = await db.execute(
        select(Device)
        .where(Device.is_active == True, Device.status == "offline")
        .order_by(desc(Device.last_seen))
        .limit(15)
    )
    offline_lines = []
    for d in offline_rows.scalars():
        ago = ""
        if d.last_seen:
            mins = int((now - d.last_seen.replace(tzinfo=timezone.utc)).total_seconds() / 60)
            ago = f"{mins}dk önce" if mins < 60 else f"{mins // 60}sa önce"
        location = " | ".join(filter(None, [d.site, d.building, d.floor, d.location]))
        offline_lines.append(
            f"  • {d.hostname} ({d.ip_address}) — son görülme: {ago} | konum: {location or '?'} | katman: {d.layer or '?'} | {d.vendor}"
        )
    offline_text = "\n".join(offline_lines) or "  Tüm cihazlar online"

    # ── 2. Correlation incidents (multi-device correlated events) ────────────
    corr_rows = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.event_type == "correlation_incident", NetworkEvent.created_at >= since_7d)
        .order_by(desc(NetworkEvent.created_at))
        .limit(5)
    )
    corr_lines = []
    for ev in corr_rows.scalars():
        ago_min = int((now - ev.created_at.replace(tzinfo=timezone.utc)).total_seconds() / 60)
        detail = ""
        if ev.details:
            involved = ev.details.get("involved_devices", [])
            if involved:
                detail = f" | İlgili cihazlar: {', '.join(str(h) for h in involved[:6])}"
            reason = ev.details.get("reason", ev.details.get("common_factor", ""))
            if reason:
                detail += f" | Sebep: {reason}"
        corr_lines.append(f"  • [{ago_min}dk] {ev.title}{detail}")
    corr_text = "\n".join(corr_lines) or "  - yok"

    # ── 3. Security-relevant anomaly events with messages ────────────────────
    sec_event_types = (
        "mac_anomaly", "mac_loop_suspicion", "vlan_anomaly",
        "stp_anomaly", "loop_detected", "topology_drift",
        "traffic_spike", "device_flapping", "threshold_alert",
    )
    sec_rows = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.event_type.in_(sec_event_types), NetworkEvent.created_at >= since_24h)
        .order_by(desc(NetworkEvent.created_at))
        .limit(12)
    )
    sec_event_lines = []
    for ev in sec_rows.scalars():
        ago_min = int((now - ev.created_at.replace(tzinfo=timezone.utc)).total_seconds() / 60)
        host = f" @ {ev.device_hostname}" if ev.device_hostname else ""
        msg_snippet = (ev.message or "")[:120]
        sec_event_lines.append(f"  • [{ago_min}dk | {ev.event_type}]{host}: {ev.title} — {msg_snippet}")
    sec_event_text = "\n".join(sec_event_lines) or "  - yok"

    # ── 4. STP / loop events ─────────────────────────────────────────────────
    stp_count = await db.scalar(
        select(func.count(NetworkEvent.id))
        .where(NetworkEvent.event_type.in_(("stp_anomaly", "loop_detected")), NetworkEvent.created_at >= since_24h)
    ) or 0

    # ── 5. Flapping devices (unstable) ───────────────────────────────────────
    flap_rows = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.event_type == "device_flapping", NetworkEvent.created_at >= since_24h)
        .order_by(desc(NetworkEvent.created_at))
        .limit(5)
    )
    flap_lines = [
        f"  • {ev.device_hostname or '?'} — {ev.title}"
        for ev in flap_rows.scalars()
    ]
    flap_text = "\n".join(flap_lines) or "  - yok"

    # ── 6. Devices without SNMP (blind spots) ───────────────────────────────
    no_snmp_count = await db.scalar(
        select(func.count(Device.id))
        .where(Device.is_active == True, Device.snmp_enabled == False)
    ) or 0

    # ── 7. Devices never seen / stale (last_seen > 24h) ─────────────────────
    stale_count = await db.scalar(
        select(func.count(Device.id))
        .where(
            Device.is_active == True,
            Device.status == "offline",
            Device.last_seen < since_24h,
        )
    ) or 0

    return f"""
=== GÜVENLİK DENETİM RAPORU ({now.strftime('%Y-%m-%d %H:%M')} UTC) ===
NOT: Bu veriler tamamen pasif DB sorgusudur — hiçbir cihaza bağlantı yapılmamıştır.

[OFFLİNE CİHAZLAR — DETAY]
{offline_text}

[KORERLASYONLANMİŞ OLAYLAR (son 7 gün)]
{corr_text}

[GÜVENLİK ANOMALİLERİ (son 24s — mac/vlan/stp/loop/flap/traffic)]
{sec_event_text}

[ÖZET RİSK GÖSTERGELERİ]
STP/Loop olayları (24s): {stp_count}
Kararsız cihazlar (flapping, 24s):
{flap_text}
SNMP'siz cihazlar (kör nokta): {no_snmp_count}
24s+ görülmeyen offline cihazlar: {stale_count}
""".strip()


async def build_automate_context(db: AsyncSession) -> str:
    """Query existing NetManager automation assets so AI recommends built-in features."""
    now = datetime.now(timezone.utc)
    since_7d = now - timedelta(days=7)

    # ── Playbooks ────────────────────────────────────────────────────────────
    pb_rows = await db.execute(
        select(Playbook).where(Playbook.is_active == True).order_by(Playbook.name).limit(20)
    )
    pb_lines = []
    for pb in pb_rows.scalars():
        trigger = pb.trigger_type
        if trigger == "event" and pb.trigger_event_type:
            trigger = f"olay:{pb.trigger_event_type}"
        elif trigger == "schedule" and pb.is_scheduled:
            trigger = f"zamanlanmış ({pb.schedule_interval_hours}s aralık)"
        step_count = len(pb.steps) if pb.steps else 0
        pb_lines.append(f"  • [{pb.id}] {pb.name} — tetikleyici: {trigger} | {step_count} adım")
    pb_text = "\n".join(pb_lines) or "  Henüz playbook tanımlanmamış."

    # ── Backup schedules ─────────────────────────────────────────────────────
    bs_rows = await db.execute(select(BackupSchedule).order_by(BackupSchedule.name))
    bs_lines = []
    for bs in bs_rows.scalars():
        status = "aktif" if bs.enabled else "devre dışı"
        last = "—"
        if bs.last_run_at:
            mins = int((now - bs.last_run_at.replace(tzinfo=timezone.utc)).total_seconds() / 60)
            last = f"{mins // 60}sa önce" if mins >= 60 else f"{mins}dk önce"
        nxt = "—"
        if bs.next_run_at:
            diff = int((bs.next_run_at.replace(tzinfo=timezone.utc) - now).total_seconds() / 60)
            nxt = f"{diff // 60}sa sonra" if diff >= 60 else f"{diff}dk sonra"
        bs_lines.append(
            f"  • {bs.name} — {status} | {bs.schedule_type} | son: {last} | sıradaki: {nxt} | kapsam: {bs.device_filter}"
        )
    bs_text = "\n".join(bs_lines) or "  Henüz yedekleme takvimi tanımlanmamış."

    # ── Alert rules ──────────────────────────────────────────────────────────
    ar_rows = await db.execute(
        select(AlertRule).where(AlertRule.enabled == True).order_by(AlertRule.name).limit(15)
    )
    ar_lines = []
    for ar in ar_rows.scalars():
        ar_lines.append(f"  • {ar.name} — metrik: {ar.metric} | eşik: {ar.threshold_value} | şiddet: {ar.severity}")
    ar_text = "\n".join(ar_lines) or "  Henüz alert kuralı tanımlanmamış."

    # ── Config templates ─────────────────────────────────────────────────────
    ct_count = await db.scalar(select(func.count(ConfigTemplate.id))) or 0

    # ── Recent backup coverage ───────────────────────────────────────────────
    total_active = await db.scalar(
        select(func.count(Device.id)).where(Device.is_active == True)
    ) or 0
    backed_up_count = await db.scalar(
        select(func.count(func.distinct(ConfigBackup.device_id)))
        .where(ConfigBackup.created_at >= since_7d)
    ) or 0
    no_backup_count = total_active - backed_up_count

    return f"""
=== NETMANAGER OTOMASYON VARLIĞI ===
KURAL: Yanıtlarında yalnızca aşağıda listelenen mevcut sistem özelliklerini öner.
Dış betik (Python/Netmiko/Bash), harici araç veya sıfırdan kod yazmayı kesinlikle önerme.
Her öneride NetManager arayüzünde hangi menüye gidileceğini belirt.

[MEVCUT PLAYBOOK'LAR — /playbooks]
{pb_text}

[YEDEKLEMETAKVİMLERİ — /backups]
{bs_text}
Son 7 günde yedek alınan cihaz: {backed_up_count}/{total_active}
Son 7 günde yedek ALINMAYAN cihaz: {no_backup_count}

[ALERT KURALLARI — /alert-rules]
{ar_text}

[MEVCUT ÖZELLİKLER]
• Config Templates (/config-templates): {ct_count} şablon — toplu konfigürasyon push
• Diagnostics (/diagnostics): ICMP ping, SSH erişim testi, port tarama
• Change Management (/change-management): onay akışlı değişiklik planlama
• Compliance Check (/compliance): kural tabanlı konfigürasyon denetimi
• Security Audit (/security-audit): port güvenlik ve ACL analizi
• SLA Raporu (/sla): uptime ve kesinti takibi
• LLDP Envanteri (/discovery): topoloji keşfi
""".strip()


async def _get_or_create_settings(db: AsyncSession) -> AISettings:
    row = await db.get(AISettings, 1)
    if row is None:
        row = AISettings(id=1)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def chat(
    db: AsyncSession,
    messages: list[dict[str, str]],
    mode: str = "analyze",
) -> dict[str, Any]:
    settings = await _get_or_create_settings(db)
    if not settings.active_provider:
        raise ValueError("AI sağlayıcısı yapılandırılmamış. Lütfen Ayarlar → AI Asistanı bölümünden bir sağlayıcı seçin.")

    context = await build_network_context(db)
    if mode == "security":
        sec_context = await build_security_context(db)
        context = context + "\n\n" + sec_context
    elif mode == "automate":
        auto_context = await build_automate_context(db)
        context = context + "\n\n" + auto_context
    system = SYSTEM_PROMPT.format(context=context) + MODE_PROMPTS.get(mode, "")
    provider = settings.active_provider

    if provider == "claude":
        return await _claude_chat(settings, system, messages)
    elif provider == "openai":
        return await _openai_chat(settings, system, messages)
    elif provider == "gemini":
        return await _gemini_chat(settings, system, messages)
    elif provider == "ollama":
        return await _ollama_chat(settings, system, messages)
    else:
        raise ValueError(f"Bilinmeyen sağlayıcı: {provider}")


async def _claude_chat(settings: AISettings, system: str, messages: list[dict]) -> dict:
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        raise RuntimeError("anthropic paketi yüklü değil. VPS'te 'docker compose up -d --build' çalıştırın.")

    api_key = decrypt_credential_safe(settings.claude_api_key_enc)
    if not api_key:
        raise ValueError("Claude API anahtarı ayarlanmamış.")

    client = AsyncAnthropic(api_key=api_key, timeout=60.0)
    try:
        resp = await client.messages.create(
            model=settings.claude_model or "claude-sonnet-4-6",
            max_tokens=2048,
            system=system,
            messages=messages,
        )
    except Exception as e:
        err_str = str(e)
        if "401" in err_str or "authentication" in err_str.lower() or "invalid" in err_str.lower():
            raise ValueError("Claude API anahtarı geçersiz. Lütfen Ayarlar'dan kontrol edin.")
        raise RuntimeError(f"Claude API hatası: {e}")
    tokens = (resp.usage.input_tokens or 0) + (resp.usage.output_tokens or 0)
    return {
        "message": resp.content[0].text,
        "provider": "claude",
        "model": settings.claude_model,
        "tokens_used": tokens,
    }


async def _openai_chat(settings: AISettings, system: str, messages: list[dict]) -> dict:
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise RuntimeError("openai paketi yüklü değil. VPS'te 'docker compose up -d --build' çalıştırın.")

    api_key = decrypt_credential_safe(settings.openai_api_key_enc)
    if not api_key:
        raise ValueError("OpenAI API anahtarı ayarlanmamış.")

    client = AsyncOpenAI(api_key=api_key, timeout=60.0)
    full_messages = [{"role": "system", "content": system}] + messages
    try:
        resp = await client.chat.completions.create(
            model=settings.openai_model or "gpt-4o",
            messages=full_messages,
            max_tokens=2048,
        )
    except Exception as e:
        err_str = str(e)
        if "401" in err_str or "Incorrect API key" in err_str or "invalid_api_key" in err_str:
            raise ValueError(f"OpenAI API anahtarı geçersiz. Lütfen Ayarlar'dan kontrol edin.")
        if "429" in err_str:
            raise ValueError("OpenAI rate limit aşıldı. Biraz bekleyip tekrar deneyin.")
        raise RuntimeError(f"OpenAI API hatası: {e}")
    return {
        "message": resp.choices[0].message.content,
        "provider": "openai",
        "model": settings.openai_model,
        "tokens_used": resp.usage.total_tokens if resp.usage else 0,
    }


async def _gemini_chat(settings: AISettings, system: str, messages: list[dict]) -> dict:
    try:
        from google import genai
    except ImportError:
        raise RuntimeError("google-genai paketi yüklü değil. VPS'te 'docker compose up -d --build' çalıştırın.")

    api_key = decrypt_credential_safe(settings.gemini_api_key_enc)
    if not api_key:
        raise ValueError("Gemini API anahtarı ayarlanmamış.")

    model_name = settings.gemini_model or "gemini-3-flash-preview"
    client = genai.Client(api_key=api_key)

    # Build a single prompt string — most compatible approach across SDK versions
    parts: list[str] = [system, "---"]
    for m in messages[:-1]:
        label = "Kullanıcı" if m["role"] == "user" else "Asistan"
        parts.append(f"{label}: {m['content']}")
    last = messages[-1]["content"] if messages else ""
    parts.append(f"Kullanıcı: {last}")
    prompt = "\n\n".join(parts)

    try:
        resp = await asyncio.to_thread(
            client.models.generate_content,
            model=model_name,
            contents=prompt,
        )
    except Exception as e:
        err_str = str(e)
        if "401" in err_str or "API_KEY_INVALID" in err_str or "invalid" in err_str.lower():
            raise ValueError("Gemini API anahtarı geçersiz. Lütfen Ayarlar'dan kontrol edin.")
        if "429" in err_str:
            raise ValueError("Gemini rate limit aşıldı. Biraz bekleyip tekrar deneyin.")
        raise RuntimeError(f"Gemini hatası: {err_str[:400]}")

    return {
        "message": resp.text,
        "provider": "gemini",
        "model": model_name,
        "tokens_used": 0,
    }


async def _ollama_chat(settings: AISettings, system: str, messages: list[dict]) -> dict:
    base_url = settings.ollama_base_url or "http://localhost:11434"
    model_name = settings.ollama_model or "llama3.2"

    payload = {
        "model": model_name,
        "messages": [{"role": "system", "content": system}] + messages,
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{base_url}/api/chat", json=payload)
        resp.raise_for_status()
        data = resp.json()

    return {
        "message": data["message"]["content"],
        "provider": "ollama",
        "model": model_name,
        "tokens_used": 0,
    }
