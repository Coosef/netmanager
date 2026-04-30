"""CRUD for credential profiles — centralized SSH/SNMP credential vault."""
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import encrypt_credential
from app.models.credential_profile import CredentialProfile
from app.models.rotation_policy import RotationPolicy

router = APIRouter()

_MASKED = "••••••••"


def _serialize(p: CredentialProfile, show_names_only: bool = True) -> dict[str, Any]:
    """Return profile dict — credentials are never included in responses."""
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "ssh_username": p.ssh_username,
        "ssh_password_set": bool(p.ssh_password_enc),
        "ssh_port": p.ssh_port,
        "enable_secret_set": bool(p.enable_secret_enc),
        "snmp_enabled": p.snmp_enabled,
        "snmp_community_set": bool(p.snmp_community),
        "snmp_version": p.snmp_version,
        "snmp_port": p.snmp_port,
        "snmp_v3_username": p.snmp_v3_username,
        "snmp_v3_auth_protocol": p.snmp_v3_auth_protocol,
        "snmp_v3_priv_protocol": p.snmp_v3_priv_protocol,
        "snmp_v3_auth_passphrase_set": bool(p.snmp_v3_auth_passphrase),
        "snmp_v3_priv_passphrase_set": bool(p.snmp_v3_priv_passphrase),
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


def _apply_fields(p: CredentialProfile, payload: dict):
    if "name" in payload:
        p.name = payload["name"]
    if "description" in payload:
        p.description = payload.get("description")
    if "ssh_username" in payload:
        p.ssh_username = payload["ssh_username"] or None
    if "ssh_password" in payload and payload["ssh_password"]:
        p.ssh_password_enc = encrypt_credential(payload["ssh_password"])
    if "ssh_port" in payload:
        p.ssh_port = int(payload["ssh_port"] or 22)
    if "enable_secret" in payload and payload["enable_secret"]:
        p.enable_secret_enc = encrypt_credential(payload["enable_secret"])
    elif "enable_secret" in payload and payload["enable_secret"] == "":
        p.enable_secret_enc = None
    if "snmp_enabled" in payload:
        p.snmp_enabled = bool(payload["snmp_enabled"])
    if "snmp_community" in payload:
        p.snmp_community = payload["snmp_community"] or None
    if "snmp_version" in payload:
        p.snmp_version = payload.get("snmp_version", "v2c")
    if "snmp_port" in payload:
        p.snmp_port = int(payload["snmp_port"] or 161)
    if "snmp_v3_username" in payload:
        p.snmp_v3_username = payload["snmp_v3_username"] or None
    if "snmp_v3_auth_protocol" in payload:
        p.snmp_v3_auth_protocol = payload["snmp_v3_auth_protocol"] or None
    if "snmp_v3_priv_protocol" in payload:
        p.snmp_v3_priv_protocol = payload["snmp_v3_priv_protocol"] or None
    if "snmp_v3_auth_passphrase" in payload and payload["snmp_v3_auth_passphrase"]:
        p.snmp_v3_auth_passphrase = encrypt_credential(payload["snmp_v3_auth_passphrase"])
    if "snmp_v3_priv_passphrase" in payload and payload["snmp_v3_priv_passphrase"]:
        p.snmp_v3_priv_passphrase = encrypt_credential(payload["snmp_v3_priv_passphrase"])


@router.get("")
async def list_profiles(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(CredentialProfile).order_by(CredentialProfile.name))
    return [_serialize(p) for p in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_profile(
    payload: dict,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    if not payload.get("name"):
        raise HTTPException(status_code=422, detail="name is required")

    existing = await db.execute(
        select(CredentialProfile).where(CredentialProfile.name == payload["name"])
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="A profile with this name already exists")

    p = CredentialProfile(created_by=getattr(current_user, "id", None))
    _apply_fields(p, payload)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _serialize(p)


@router.patch("/{profile_id}")
async def update_profile(
    profile_id: int,
    payload: dict,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(CredentialProfile).where(CredentialProfile.id == profile_id))
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Not found")

    if "name" in payload and payload["name"] != p.name:
        dup = await db.execute(
            select(CredentialProfile).where(CredentialProfile.name == payload["name"])
        )
        if dup.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="A profile with this name already exists")

    _apply_fields(p, payload)
    await db.commit()
    await db.refresh(p)
    return _serialize(p)


# ── Rotation Policy ──────────────────────────────────────────────────────────

def _serialize_policy(p: RotationPolicy) -> dict:
    return {
        "id": p.id,
        "credential_profile_id": p.credential_profile_id,
        "interval_days": p.interval_days,
        "is_active": p.is_active,
        "status": p.status,
        "last_rotated_at": p.last_rotated_at.isoformat() if p.last_rotated_at else None,
        "next_rotate_at": p.next_rotate_at.isoformat() if p.next_rotate_at else None,
        "last_result": p.last_result,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


@router.get("/{profile_id}/rotation-policy")
async def get_rotation_policy(
    profile_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RotationPolicy).where(RotationPolicy.credential_profile_id == profile_id)
    )
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="No rotation policy for this profile")
    return _serialize_policy(p)


@router.post("/{profile_id}/rotation-policy", status_code=201)
async def create_rotation_policy(
    profile_id: int,
    payload: dict,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    profile = await db.get(CredentialProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    existing = (await db.execute(
        select(RotationPolicy).where(RotationPolicy.credential_profile_id == profile_id)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Rotation policy already exists")

    interval_days = int(payload.get("interval_days", 90))
    now = datetime.now(timezone.utc)
    p = RotationPolicy(
        credential_profile_id=profile_id,
        interval_days=interval_days,
        is_active=bool(payload.get("is_active", True)),
        next_rotate_at=now + timedelta(days=interval_days),
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _serialize_policy(p)


@router.patch("/{profile_id}/rotation-policy")
async def update_rotation_policy(
    profile_id: int,
    payload: dict,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RotationPolicy).where(RotationPolicy.credential_profile_id == profile_id)
    )
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Not found")

    if "interval_days" in payload:
        p.interval_days = int(payload["interval_days"])
        # Recalculate next_rotate_at from last rotation or now
        base = p.last_rotated_at or datetime.now(timezone.utc)
        p.next_rotate_at = base + timedelta(days=p.interval_days)
    if "is_active" in payload:
        p.is_active = bool(payload["is_active"])

    await db.commit()
    await db.refresh(p)
    return _serialize_policy(p)


@router.delete("/{profile_id}/rotation-policy", status_code=204)
async def delete_rotation_policy(
    profile_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RotationPolicy).where(RotationPolicy.credential_profile_id == profile_id)
    )
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Not found")
    await db.delete(p)
    await db.commit()


@router.post("/{profile_id}/rotate-now")
async def rotate_now(
    profile_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Trigger an immediate manual credential rotation for a profile."""
    profile = await db.get(CredentialProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    result = await db.execute(
        select(RotationPolicy).where(RotationPolicy.credential_profile_id == profile_id)
    )
    policy = result.scalar_one_or_none()
    if not policy:
        raise HTTPException(status_code=404, detail="No rotation policy configured for this profile")
    if policy.status == "running":
        raise HTTPException(status_code=409, detail="A rotation is already in progress")

    from app.workers.tasks.rotation_tasks import rotate_profile
    rotate_profile.delay(policy.id)
    return {"message": "Rotation started", "policy_id": policy.id}


@router.get("/rotation-policies/all")
async def list_all_rotation_policies(
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """List all rotation policies with profile name for the Settings dashboard."""
    result = await db.execute(select(RotationPolicy))
    policies = result.scalars().all()

    out = []
    for p in policies:
        profile = await db.get(CredentialProfile, p.credential_profile_id)
        row = _serialize_policy(p)
        row["profile_name"] = profile.name if profile else f"Profile #{p.credential_profile_id}"
        out.append(row)
    return out


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_profile(
    profile_id: int,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(CredentialProfile).where(CredentialProfile.id == profile_id))
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Not found")

    # Check if any devices reference this profile
    from sqlalchemy import text
    usage = await db.execute(
        text("SELECT COUNT(*) FROM devices WHERE credential_profile_id = :pid"),
        {"pid": profile_id},
    )
    count = usage.scalar()
    if count and count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Profile is used by {count} device(s). Remove association first.",
        )

    await db.delete(p)
    await db.commit()
