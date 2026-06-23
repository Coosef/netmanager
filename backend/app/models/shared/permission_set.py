from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase

# Default empty permission set — deny all.
#
# `agents` was historically a flat {"view", "edit"} pair. The
# location-agent-permissions work expands it into a five-verb catalogue
# that the role-permission UI exposes as the "Agent Yönetimi / Agent
# Management" group:
#
#   view                — list agents in scope, see agent detail.
#   install             — create an agent record + start enrollment.
#                         The location must be in the user's scope.
#   download_installer  — download the installer / script bytes for an
#                         existing agent. Independent of `install` so a
#                         viewer-with-helpdesk role can hand off a
#                         pre-enrolled agent to a field tech without
#                         being able to enroll a new one.
#   update              — change agent metadata / config (rename,
#                         re-assign to another in-scope location, edit
#                         security policy, rotate key). Cannot move to
#                         an out-of-scope location.
#   remove              — soft-delete / deactivate the agent record.
#                         Does NOT remove the agent binary from the
#                         remote host (no remote uninstall support
#                         today; that is future scope).
#
# The legacy `edit` key is retained as a permanent alias in
# PermissionEngine (engine.py: AGENT_PERMISSION_ALIASES) so existing
# permission_set rows that toggle `agents.edit=true` keep granting
# `agents.update` until the migration backfill runs.
#
# P2-CATALOG-A (2026-06-23) — canonical key alignment.
#
# Five new keys were added so the stored payload covers every verb
# that the backend has_permission() catalogue AND the frontend can()
# call sites already reference. Without these keys a call like
# `can('devices', 'connect')` could not find an explicit entry on the
# row and would silently fall back to the role-default map — which
# meant an explicit `devices.ssh = false` operator toggle had no effect
# on the Bilgi Çek button. The new keys close that gap.
#
# devices.create   — POST /devices (admin device add); covered by
#                    backend SYSTEM_ROLE_PERMISSIONS verb device:create.
# devices.connect  — SSH session open / "Bilgi Çek" / test_connection /
#                    run-command; backend verb device:connect.
#                    Semantically distinct from devices.ssh (terminal
#                    SSH allowance) but in practice the two travel
#                    together — the backfill seeds connect = ssh on
#                    every existing row so no operator who previously
#                    enabled SSH loses Bilgi Çek.
# devices.move     — POST /devices/{id}/move-location; backend verb
#                    device:move. Backfill defaults to FALSE for
#                    every existing row except the "Tam Yetki" and
#                    "Org Admin" templates — destructive ownership
#                    transfer that the operator must opt into.
# config_backups.backup  — backend verb config:backup (take a backup).
# config_backups.restore — backend verb config:push when invoked from
#                    the restore endpoint. Backfill seeds backup =
#                    restore = config_backups.edit (operators who
#                    could already edit a backup row could already
#                    trigger both flows; no silent revocation).
#
# The Alembic migration f9ag_canonical_permission_keys.py applies the
# same backfill to every existing permission_set row.
DEFAULT_PERMISSIONS: dict = {
    "modules": {
        "devices":         {"view": False, "create": False, "edit": False,
                            "delete": False, "ssh": False, "connect": False,
                            "move": False},
        "config_backups":  {"view": False, "edit": False, "delete": False,
                            "backup": False, "restore": False},
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
        "agents":          {
            "view":               False,
            "install":            False,
            "download_installer": False,
            "update":             False,
            "remove":             False,
        },
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
