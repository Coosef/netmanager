"""Multi-provider AI service: Claude, OpenAI, Gemini, Ollama."""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any

import httpx
from sqlalchemy import func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_settings import AISettings
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.core.security import decrypt_credential_safe


SYSTEM_PROMPT = """Sen NetManager ağ yönetim platformunun AI asistanısın.
Kullanıcı sana ağ altyapısı, cihazlar, olaylar ve analizler hakkında sorular soracak.
Kısa, net ve pratik cevaplar ver. Türkçe sorulara Türkçe, İngilizce sorulara İngilizce cevap ver.
Sadece ağ yönetimiyle ilgili konularda yardım et; anlık ağ verisini sana sağlayacağım.

{context}"""


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
) -> dict[str, Any]:
    settings = await _get_or_create_settings(db)
    if not settings.active_provider:
        raise ValueError("AI sağlayıcısı yapılandırılmamış. Lütfen Ayarlar → AI Asistanı bölümünden bir sağlayıcı seçin.")

    context = await build_network_context(db)
    system = SYSTEM_PROMPT.format(context=context)
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
        import google.generativeai as genai
    except ImportError:
        raise RuntimeError("google-generativeai paketi yüklü değil.")

    api_key = decrypt_credential_safe(settings.gemini_api_key_enc)
    if not api_key:
        raise ValueError("Gemini API anahtarı ayarlanmamış.")

    genai.configure(api_key=api_key)
    model_obj = genai.GenerativeModel(
        model_name=settings.gemini_model or "gemini-1.5-pro",
        system_instruction=system,
    )

    history = []
    for m in messages[:-1]:
        role = "user" if m["role"] == "user" else "model"
        history.append({"role": role, "parts": [m["content"]]})

    chat_session = model_obj.start_chat(history=history)
    last_msg = messages[-1]["content"] if messages else ""
    resp = await chat_session.send_message_async(last_msg)
    return {
        "message": resp.text,
        "provider": "gemini",
        "model": settings.gemini_model,
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
