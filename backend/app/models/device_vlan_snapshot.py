"""DeviceVlanSnapshot — cihaz başına son taranan VLAN listesi (cache + diff).

T8.4 — VLAN Yönetimi sayfası her açılışta 60+ cihaza paralel SSH atıyordu
(yavaş + switch'lere gereksiz yük). Bu tablo VLAN listesinin SON SNAPSHOT'unu
tutar; sayfa açılışı DB'den okur, kullanıcı "Tümünü Yenile" diyene kadar
SSH atılmaz.

`POST /devices/vlans-refresh` çağrısı geldiğinde:
  1. Paralel SSH çek (asyncio.gather)
  2. Mevcut snapshot ile diff hesapla
  3. Snapshot'u güncelle
  4. Diff payload'u UI'a dön: per-device {added, removed} VLAN id'leri

Tek satır per device (unique constraint device_id). Org/loc Faz 7 RLS ile
otomatik scoped — başka org'un snapshot'unu görmek imkansız.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeviceVlanSnapshot(Base):
    __tablename__ = "device_vlan_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Tam VLAN listesi — interfaces._parse_vlans çıktısı (id/name/status/ports).
    # JSONB; sorgu yapılmaz, sadece read/write.
    vlans: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    fetched_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # SSH error message (cihaz erişilemezse). Snapshot yine yazılır ama
    # vlans=[] + error doludur — UI "—" yerine sebebi göstersin.
    error: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # Faz 7 — RLS isolation
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True, index=True
    )

    __table_args__ = (
        # Her cihaz için en fazla bir snapshot — yeni refresh INSERT yerine
        # ON CONFLICT UPDATE yapılır.
        UniqueConstraint("device_id", name="uq_device_vlan_snapshot_device"),
    )
