from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text
from app.core.database import Base


class AgentCredentialBundle(Base):
    __tablename__ = "agent_credential_bundles"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(String(32), nullable=False, unique=True, index=True)
    agent_aes_key_enc = Column(Text, nullable=False)  # AES-256 key encrypted with server Fernet key
    bundle_version = Column(Integer, nullable=False, default=1)
    last_refreshed = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    device_count = Column(Integer, nullable=False, default=0)
