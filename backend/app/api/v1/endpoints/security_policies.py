"""T10 Faz C C2 — Security Policy CRUD (switch + port).

Router `require_feature("security_policy")` ile gate'li (kapalı org → 403, router.py).
RLS org-scoped (ScopedDb) → liste/okuma yalnız org'un policy'leri; yazma org_admin+.
Alan allowlist'i model kolonlarından türetilir (NULL semantic: gönderilmeyen alan NULL kalır).
`is_default=true` set edilince eski default flag'i atomic kaldırılır (partial-unique).
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import ScopedDb, CurrentUser
from app.models.security_policy import PortSecurityPolicy, SwitchSecurityPolicy
from app.services import security_policy_service as svc
from app.services.audit_service import log_action

router = APIRouter()

_SEVERITY = {"info", "warning", "critical"}
_CONFIG_CHANGE = {"info", "require_ack", "auto_ack"}
_RESERVED = {"id", "organization_id", "created_at", "updated_at"}


def _allowed(model_cls) -> set[str]:
    return {c.name for c in model_cls.__table__.columns} - _RESERVED


def _validate(model_cls, body: dict, *, is_create: bool) -> None:
    allowed = _allowed(model_cls)
    unknown = set(body) - allowed
    if unknown:
        raise HTTPException(400, f"Bilinmeyen alan(lar): {', '.join(sorted(unknown))}")
    if is_create and not (body.get("name") or "").strip():
        raise HTTPException(400, "name zorunlu")
    # severity alanları enum kontrolü (NULL serbest)
    for key, val in body.items():
        if val is None:
            continue
        if key.endswith("_severity") and val not in _SEVERITY:
            raise HTTPException(400, f"{key} ∈ {sorted(_SEVERITY)} olmalı (veya null)")
    if body.get("config_change_policy") not in (None, *_CONFIG_CHANGE):
        raise HTTPException(400, f"config_change_policy ∈ {sorted(_CONFIG_CHANGE)} olmalı")


def _serialize(p) -> dict:
    out: dict[str, Any] = {}
    for c in p.__table__.columns:
        v = getattr(p, c.name)
        out[c.name] = v.isoformat() if c.name in ("created_at", "updated_at") and v else v
    return out


def _require_org_admin(user) -> None:
    if not (getattr(user, "is_super_admin", False) or getattr(user, "is_org_admin", False)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Yetersiz yetki — org_admin / super_admin")


def _make_crud(model_cls, prefix: str, audit_kind: str):
    """switch + port için aynı CRUD setini üretir."""

    @router.get(f"/{prefix}", response_model=list)
    async def _list(db: ScopedDb, _: CurrentUser = None):
        rows = (await db.execute(select(model_cls).order_by(model_cls.id))).scalars().all()
        return [_serialize(p) for p in rows]

    @router.get(f"/{prefix}/{{pid}}", response_model=dict)
    async def _get(pid: int, db: ScopedDb, _: CurrentUser = None):
        p = await db.get(model_cls, pid)
        if p is None:
            raise HTTPException(404, "Policy bulunamadı")
        return _serialize(p)

    @router.post(f"/{prefix}", response_model=dict, status_code=201)
    async def _create(request: Request, db: ScopedDb, current_user: CurrentUser = None):
        _require_org_admin(current_user)
        body = await request.json()
        _validate(model_cls, body, is_create=True)
        make_default = bool(body.pop("is_default", False))
        p = model_cls(**body)  # organization_id _scoping hook'tan damgalanır
        db.add(p)
        await db.flush()
        if make_default:
            await svc.set_default(db, model_cls, p.organization_id, p.id)
        await db.commit()
        await db.refresh(p)
        await log_action(db, current_user, f"{audit_kind}_created",
                         resource_type=audit_kind, resource_id=p.id, resource_name=p.name,
                         request=request)
        return _serialize(p)

    @router.put(f"/{prefix}/{{pid}}", response_model=dict)
    async def _update(pid: int, request: Request, db: ScopedDb, current_user: CurrentUser = None):
        _require_org_admin(current_user)
        p = await db.get(model_cls, pid)
        if p is None:
            raise HTTPException(404, "Policy bulunamadı")
        body = await request.json()
        _validate(model_cls, body, is_create=False)
        make_default = body.pop("is_default", None)
        for k, v in body.items():
            setattr(p, k, v)
        if make_default is True:
            await svc.set_default(db, model_cls, p.organization_id, p.id)
        elif make_default is False:
            p.is_default = False
        await db.commit()
        await db.refresh(p)
        await log_action(db, current_user, f"{audit_kind}_updated",
                         resource_type=audit_kind, resource_id=p.id, resource_name=p.name,
                         request=request)
        return _serialize(p)

    @router.delete(f"/{prefix}/{{pid}}", status_code=204)
    async def _delete(pid: int, request: Request, db: ScopedDb, current_user: CurrentUser = None):
        _require_org_admin(current_user)
        p = await db.get(model_cls, pid)
        if p is None:
            raise HTTPException(404, "Policy bulunamadı")
        name = p.name
        await db.delete(p)
        await db.commit()
        await log_action(db, current_user, f"{audit_kind}_deleted",
                         resource_type=audit_kind, resource_id=pid, resource_name=name,
                         request=request)
        return None

    @router.post(f"/{prefix}/{{pid}}/set-default", response_model=dict)
    async def _set_default(pid: int, request: Request, db: ScopedDb, current_user: CurrentUser = None):
        _require_org_admin(current_user)
        p = await db.get(model_cls, pid)
        if p is None:
            raise HTTPException(404, "Policy bulunamadı")
        await svc.set_default(db, model_cls, p.organization_id, pid)
        await db.commit()
        await log_action(db, current_user, f"{audit_kind}_set_default",
                         resource_type=audit_kind, resource_id=pid, resource_name=p.name,
                         request=request)
        return {"id": pid, "is_default": True}


_make_crud(SwitchSecurityPolicy, "switch", "switch_security_policy")
_make_crud(PortSecurityPolicy, "port", "port_security_policy")
