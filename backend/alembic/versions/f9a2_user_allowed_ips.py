"""users.allowed_ips — per-user IP whitelist (T9 Tur 2 #4)

Revision ID: f9a2userips
Revises: f9a1sysset
Create Date: 2026-05-26

T9 Tur 2 #4 — Per-user IP allowlist (kullanıcı sadece belirli IP/CIDR'lar
dan login yapabilsin). NULL veya boş → kısıt yok (mevcut davranış aynen).

Format: comma-separated CIDR (örn. "10.0.0.0/8, 192.168.1.0/24, 1.2.3.4/32")
- /32 = tek IP; mask yok ise /32 varsayılır
- IPv4 + IPv6 destekli (ipaddress modülü)
- Boş string → kısıt yok (NULL ile aynı davranış)

Auth endpoint (auth.py) login + mfa/verify'da IP check uygular. Eşleşmezse
403 + audit log (login_blocked_ip event).
"""
from alembic import op
import sqlalchemy as sa


revision = "f9a2userips"
down_revision = "f9a1sysset"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("allowed_ips", sa.Text(), nullable=True),
    )


def downgrade():
    op.drop_column("users", "allowed_ips")
