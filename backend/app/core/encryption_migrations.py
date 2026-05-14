"""
Startup data-encryption migration helpers.

No FastAPI/SlowAPI dependencies — importable in unit tests without the full app stack.
Each function is idempotent: already-encrypted values are detected via
_fernet_needs_encryption() and skipped.
"""
from __future__ import annotations


def _fernet_needs_encryption(val: str) -> bool:
    """Return True if val is NOT already a valid Fernet/MultiFernet token."""
    if not val:
        return True
    try:
        from cryptography.fernet import MultiFernet, Fernet
        from app.core.config import settings
        keys = [Fernet(settings.CREDENTIAL_ENCRYPTION_KEY.encode())]
        if settings.CREDENTIAL_ENCRYPTION_KEY_OLD:
            keys.append(Fernet(settings.CREDENTIAL_ENCRYPTION_KEY_OLD.encode()))
        MultiFernet(keys).decrypt(val.encode())
        return False  # already a valid token — skip
    except Exception:
        return True  # plaintext or corrupted — (re-)encrypt


async def _encrypt_existing_snmp_communities(conn) -> None:
    """Encrypt any plaintext SNMP community strings in devices and credential_profiles."""
    from sqlalchemy import text
    from app.core.security import encrypt_credential

    for table in ("devices", "credential_profiles"):
        rows = (await conn.execute(
            text(f"SELECT id, snmp_community FROM {table} WHERE snmp_community IS NOT NULL AND snmp_community != ''")
        )).fetchall()
        for row_id, community in rows:
            if _fernet_needs_encryption(community):
                await conn.execute(
                    text(f"UPDATE {table} SET snmp_community = :enc WHERE id = :id"),
                    {"enc": encrypt_credential(community), "id": row_id},
                )


async def _encrypt_existing_snmpv3_passphrases(conn) -> None:
    """Encrypt any plaintext SNMP v3 passphrases in devices and credential_profiles."""
    from sqlalchemy import text
    from app.core.security import encrypt_credential

    for table, cols in [
        ("devices", ["snmp_v3_auth_passphrase", "snmp_v3_priv_passphrase"]),
        ("credential_profiles", ["snmp_v3_auth_passphrase", "snmp_v3_priv_passphrase"]),
    ]:
        for col in cols:
            rows = (await conn.execute(
                text(f"SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != ''")
            )).fetchall()
            for row_id, value in rows:
                if _fernet_needs_encryption(value):
                    await conn.execute(
                        text(f"UPDATE {table} SET {col} = :enc WHERE id = :id"),
                        {"enc": encrypt_credential(value), "id": row_id},
                    )


async def _encrypt_existing_webhook_headers(conn) -> None:
    """Encrypt any plaintext webhook_headers in escalation_rules."""
    from sqlalchemy import text
    from app.core.security import encrypt_credential

    rows = (await conn.execute(
        text("SELECT id, webhook_headers FROM escalation_rules "
             "WHERE webhook_headers IS NOT NULL AND webhook_headers != ''")
    )).fetchall()
    for row_id, value in rows:
        if _fernet_needs_encryption(value):
            await conn.execute(
                text("UPDATE escalation_rules SET webhook_headers = :enc WHERE id = :id"),
                {"enc": encrypt_credential(value), "id": row_id},
            )
