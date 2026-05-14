"""
Credential key rotation script.

Re-encrypts all Fernet-encrypted secrets from the old key to the new key.
Must be run while the application is stopped or in maintenance mode.

Usage:
  CREDENTIAL_ENCRYPTION_KEY=<new_key> \
  CREDENTIAL_ENCRYPTION_KEY_OLD=<old_key> \
  SYNC_DATABASE_URL=postgresql+psycopg2://... \
  python backend/scripts/rotate_credentials.py [--dry-run]

Requirements:
  - Both CREDENTIAL_ENCRYPTION_KEY (new) and CREDENTIAL_ENCRYPTION_KEY_OLD (old) must be set.
  - A database backup MUST exist before running. The script verifies this via
    --backup-confirmed flag or ROTATION_BACKUP_CONFIRMED=1 env var.
  - --dry-run: reports how many secrets would be rotated without writing.

After successful rotation:
  1. Unset CREDENTIAL_ENCRYPTION_KEY_OLD in your .env / secrets manager.
  2. Restart application services.
"""
import argparse
import os
import sys

# Encrypted field registry: (table, column) pairs
_ENCRYPTED_FIELDS = [
    ("devices", "ssh_password_enc"),
    ("devices", "enable_secret_enc"),
    ("devices", "snmp_community"),
    ("devices", "snmp_v3_auth_passphrase"),
    ("devices", "snmp_v3_priv_passphrase"),
    ("credential_profiles", "ssh_password_enc"),
    ("credential_profiles", "enable_secret_enc"),
    ("credential_profiles", "snmp_community"),
    ("credential_profiles", "snmp_v3_auth_passphrase"),
    ("credential_profiles", "snmp_v3_priv_passphrase"),
    ("ai_settings", "claude_api_key_enc"),
    ("ai_settings", "openai_api_key_enc"),
    ("ai_settings", "gemini_api_key_enc"),
    ("agent_credential_bundles", "agent_aes_key_enc"),
    ("escalation_rules", "webhook_headers"),
]


def _build_fernet(new_key: str, old_key: str):
    from cryptography.fernet import Fernet, MultiFernet
    return MultiFernet([Fernet(new_key.encode()), Fernet(old_key.encode())])


def _rotate(conn, multi, table: str, col: str, dry_run: bool) -> int:
    conn.execute(f"SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != ''")
    rows = conn.fetchall()
    count = 0
    for row_id, value in rows:
        try:
            plaintext = multi.decrypt(value.encode())
        except Exception:
            print(f"  WARN: {table}.{col} id={row_id} — could not decrypt (skipped)", file=sys.stderr)
            continue
        new_ciphertext = multi.encrypt(plaintext).decode()
        if not dry_run:
            conn.execute(
                f"UPDATE {table} SET {col} = %s WHERE id = %s",
                (new_ciphertext, row_id),
            )
        count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description="Rotate Fernet credential encryption key.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be rotated without writing.")
    parser.add_argument("--backup-confirmed", action="store_true",
                        help="Confirm that a database backup has been taken.")
    args = parser.parse_args()

    new_key = os.environ.get("CREDENTIAL_ENCRYPTION_KEY", "")
    old_key = os.environ.get("CREDENTIAL_ENCRYPTION_KEY_OLD", "")
    db_url = os.environ.get("SYNC_DATABASE_URL", "")

    if not new_key:
        print("ERROR: CREDENTIAL_ENCRYPTION_KEY (new key) must be set.", file=sys.stderr)
        sys.exit(1)
    if not old_key:
        print("ERROR: CREDENTIAL_ENCRYPTION_KEY_OLD (old key) must be set.", file=sys.stderr)
        sys.exit(1)
    if not db_url:
        print("ERROR: SYNC_DATABASE_URL must be set.", file=sys.stderr)
        sys.exit(1)

    backup_confirmed = (
        args.backup_confirmed
        or os.environ.get("ROTATION_BACKUP_CONFIRMED", "").strip() in ("1", "true", "yes")
    )
    if not backup_confirmed and not args.dry_run:
        print(
            "ERROR: A database backup is required before key rotation.\n"
            "       Take a backup, then re-run with --backup-confirmed or set ROTATION_BACKUP_CONFIRMED=1.",
            file=sys.stderr,
        )
        sys.exit(1)

    mode = "DRY-RUN" if args.dry_run else "LIVE"
    print(f"[rotate_credentials] mode={mode}")

    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 is required. Install with: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(1)

    # Strip SQLAlchemy driver prefix for raw psycopg2
    raw_url = db_url.replace("postgresql+psycopg2://", "postgresql://")
    conn = psycopg2.connect(raw_url)
    conn.autocommit = False
    cur = conn.cursor()

    multi = _build_fernet(new_key, old_key)

    total = 0
    try:
        for table, col in _ENCRYPTED_FIELDS:
            # Check table/column exists before querying
            cur.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name=%s AND column_name=%s",
                (table, col),
            )
            if not cur.fetchone():
                continue

            count = _rotate(cur, multi, table, col, dry_run=args.dry_run)
            if count:
                print(f"  {table}.{col}: {count} secret(s) {'would be' if args.dry_run else ''} rotated")
            total += count

        if not args.dry_run:
            conn.commit()
            print(f"[rotate_credentials] Committed. Total rotated: {total}")
        else:
            conn.rollback()
            print(f"[rotate_credentials] Dry-run complete. Would rotate: {total} secret(s)")

    except Exception as exc:
        conn.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
