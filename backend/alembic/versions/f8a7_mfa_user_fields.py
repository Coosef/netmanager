"""MFA — add per-user TOTP enrollment + recovery code columns

First cut covers RFC 6238 TOTP (Google Authenticator / Microsoft Auth /
Authy / 1Password). Per-user columns on `users`:

  mfa_enabled         BOOL    NOT NULL DEFAULT FALSE — gate
  mfa_totp_secret     STR     NULL — Fernet-encrypted base32 secret
  mfa_pending_secret  STR     NULL — set during enroll, promoted on confirm
  mfa_methods         STR(64) NULL — CSV ('totp', 'totp,email', …)
  mfa_recovery_codes  JSONB   NULL — list[str] of bcrypt hashes (single-use)
  mfa_enrolled_at     TSTZ    NULL — wall clock of last successful enrolment

Email + SMS land later as additional values in mfa_methods. We do NOT
backfill mfa_enabled — existing accounts stay MFA-off until each user
opts in from Settings.

Revision ID: f8a7mfauserfields
Revises: f8a6auditpermissivewrites
Create Date: 2026-05-23
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "f8a7mfauserfields"
down_revision = "f8a6auditpermissivewrites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # nullable + DEFAULT FALSE so the column add is metadata-only on the
    # existing rows (no rewrite). is_active follows the same pattern.
    op.add_column(
        "users",
        sa.Column(
            "mfa_enabled", sa.Boolean(),
            nullable=False, server_default=sa.false(),
        ),
    )
    op.add_column("users", sa.Column("mfa_totp_secret", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("mfa_pending_secret", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("mfa_methods", sa.String(64), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "mfa_recovery_codes", JSONB().with_variant(sa.JSON(), "sqlite"),
            nullable=True,
        ),
    )
    op.add_column(
        "users",
        sa.Column("mfa_enrolled_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Drop the server_default — model carries the Python default; the DB
    # default was a one-shot to make the NOT NULL addition cheap.
    op.alter_column("users", "mfa_enabled", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "mfa_enrolled_at")
    op.drop_column("users", "mfa_recovery_codes")
    op.drop_column("users", "mfa_methods")
    op.drop_column("users", "mfa_pending_secret")
    op.drop_column("users", "mfa_totp_secret")
    op.drop_column("users", "mfa_enabled")
