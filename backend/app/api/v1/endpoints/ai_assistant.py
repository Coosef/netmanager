from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import encrypt_credential, decrypt_credential_safe
from app.models.ai_settings import AISettings
from app.core.deps import get_current_user
from app.services import ai_service

router = APIRouter()

CLAUDE_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]
OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]
GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-pro-preview-05-06", "gemini-1.5-flash", "gemini-1.5-pro"]


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    mode: str = "analyze"


class UpdateAISettings(BaseModel):
    active_provider: Optional[str] = None
    claude_api_key: Optional[str] = None
    claude_model: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = None
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None


async def _get_or_create(db: AsyncSession) -> AISettings:
    row = await db.get(AISettings, 1)
    if row is None:
        row = AISettings(id=1)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.get("/settings")
async def get_ai_settings(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    s = await _get_or_create(db)
    return {
        "active_provider": s.active_provider,
        "claude_model": s.claude_model,
        "claude_configured": bool(s.claude_api_key_enc),
        "openai_model": s.openai_model,
        "openai_configured": bool(s.openai_api_key_enc),
        "gemini_model": s.gemini_model,
        "gemini_configured": bool(s.gemini_api_key_enc),
        "ollama_base_url": s.ollama_base_url,
        "ollama_model": s.ollama_model,
    }


@router.patch("/settings")
async def update_ai_settings(
    payload: UpdateAISettings,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    s = await _get_or_create(db)

    if payload.active_provider is not None:
        s.active_provider = payload.active_provider or None

    if payload.claude_api_key is not None:
        s.claude_api_key_enc = encrypt_credential(payload.claude_api_key) if payload.claude_api_key else None
    if payload.claude_model is not None:
        s.claude_model = payload.claude_model

    if payload.openai_api_key is not None:
        s.openai_api_key_enc = encrypt_credential(payload.openai_api_key) if payload.openai_api_key else None
    if payload.openai_model is not None:
        s.openai_model = payload.openai_model

    if payload.gemini_api_key is not None:
        s.gemini_api_key_enc = encrypt_credential(payload.gemini_api_key) if payload.gemini_api_key else None
    if payload.gemini_model is not None:
        s.gemini_model = payload.gemini_model

    if payload.ollama_base_url is not None:
        s.ollama_base_url = payload.ollama_base_url
    if payload.ollama_model is not None:
        s.ollama_model = payload.ollama_model

    await db.commit()
    return {"ok": True}


@router.post("/chat")
async def ai_chat(
    req: ChatRequest,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
) -> dict[str, Any]:
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        return await ai_service.chat(db, messages, mode=req.mode)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"AI sağlayıcı hatası: {exc}")


@router.get("/providers")
async def list_providers(_=Depends(get_current_user)):
    return {
        "providers": [
            {
                "id": "claude",
                "name": "Anthropic Claude",
                "models": CLAUDE_MODELS,
                "requires_key": True,
            },
            {
                "id": "openai",
                "name": "OpenAI GPT",
                "models": OPENAI_MODELS,
                "requires_key": True,
            },
            {
                "id": "gemini",
                "name": "Google Gemini",
                "models": GEMINI_MODELS,
                "requires_key": True,
            },
            {
                "id": "ollama",
                "name": "Ollama (Yerel)",
                "models": [],
                "requires_key": False,
            },
        ]
    }
