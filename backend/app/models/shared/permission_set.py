from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase

# Default empty permission set — deny all
DEFAULT_PERMISSIONS: dict = {
    "modules": {
        "devices":         {"view": False, "edit": False, "delete": False, "ssh": False},
        "config_backups":  {"view": False, "edit": False, "delete": False},
        "tasks":           {"view": False, "create": False, "cancel": False},
        "playbooks":       {"view": False, "run": False, "edit": False, "delete": False},
        "topology":        {"view": False},
        "monitoring":      {"view": False},
        "ipam":            {"view": False, "edit": False, "delete": False},
        "audit_logs":      {"view": False},
        "reports":         {"view": False},
        "users":           {"view": False, "edit": False, "delete": False, "invite": False},
        "locations":       {"view": False, "edit": False, "delete": False},
        "settings":        {"view": False, "edit": False},
        "agents":          {"view": False, "edit": False},
        "driver_templates":{"view": False, "edit": False},
    }
}


class PermissionSet(SharedBase):
    __tablename__ = "permission_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)

    # NULL org_id → global template (created by super_admin, read-only for orgs)
    org_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # If cloned from a global template, track the source
    cloned_from_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("permission_sets.id", ondelete="SET NULL"), nullable=True
    )
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    permissions: Mapped[dict] = mapped_column(JSON, default=lambda: dict(DEFAULT_PERMISSIONS))

    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
