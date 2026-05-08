from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase


class UserLocationPerm(SharedBase):
    """
    Maps a user to a permission set, optionally scoped to a specific location.
    location_id = NULL means org-wide default for that user.

    Resolution order: location-specific row → org-wide row (location_id IS NULL) → deny all.
    """
    __tablename__ = "user_location_perms"
    __table_args__ = (
        UniqueConstraint("user_id", "location_id", name="uq_user_location_perm"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # location_id references a row in the tenant schema's locations table.
    # We store it as a plain integer (no FK across schema boundary).
    location_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    permission_set_id: Mapped[int] = mapped_column(
        ForeignKey("permission_sets.id", ondelete="RESTRICT"), nullable=False
    )
    assigned_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
