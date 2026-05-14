"""
Faz 5D Secret Encryption tests.

Covers:
  - MultiFernet key rotation (encrypt/decrypt with primary and secondary key)
  - _fernet_needs_encryption idempotency guard
  - webhook_headers encrypt/decrypt flow (escalation endpoint + sender)
  - SNMP v3 passphrase startup migration
  - decrypt_credential_safe backward compatibility
"""
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _generate_fernet_key() -> str:
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode()


def _make_fernet(key: str):
    from cryptography.fernet import Fernet
    return Fernet(key.encode())


# ─────────────────────────────────────────────────────────────────────────────
# G3 — MultiFernet key rotation
# ─────────────────────────────────────────────────────────────────────────────

class TestMultiFernetRotation(unittest.TestCase):
    def setUp(self):
        self.primary_key = _generate_fernet_key()
        self.old_key = _generate_fernet_key()

    def _get_multi(self, primary: str, old: str = ""):
        """Build a MultiFernet the same way security.py does."""
        from cryptography.fernet import Fernet, MultiFernet
        keys = [Fernet(primary.encode())]
        if old:
            keys.append(Fernet(old.encode()))
        return MultiFernet(keys)

    def test_encrypt_uses_primary_key(self):
        """Encrypted token must be decryptable with primary key alone."""
        multi = self._get_multi(self.primary_key, self.old_key)
        token = multi.encrypt(b"secret").decode()
        # Primary key alone decrypts successfully
        plain = _make_fernet(self.primary_key).decrypt(token.encode())
        self.assertEqual(plain, b"secret")

    def test_decrypt_accepts_old_key_during_rotation(self):
        """Token encrypted with old key must be decryptable via MultiFernet."""
        old_token = _make_fernet(self.old_key).encrypt(b"legacy").decode()
        multi = self._get_multi(self.primary_key, self.old_key)
        plain = multi.decrypt(old_token.encode())
        self.assertEqual(plain, b"legacy")

    def test_decrypt_accepts_new_key(self):
        """Token encrypted with new key must be decryptable via MultiFernet."""
        multi = self._get_multi(self.primary_key, self.old_key)
        new_token = multi.encrypt(b"fresh").decode()
        plain = multi.decrypt(new_token.encode())
        self.assertEqual(plain, b"fresh")

    def test_old_key_only_cannot_decrypt_new_token(self):
        """Token encrypted with new key must NOT be decryptable by old key alone."""
        from cryptography.fernet import InvalidToken
        multi = self._get_multi(self.primary_key, self.old_key)
        new_token = multi.encrypt(b"fresh").decode()
        with self.assertRaises((InvalidToken, Exception)):
            _make_fernet(self.old_key).decrypt(new_token.encode())

    def test_security_module_uses_multifernet(self):
        """security._get_fernet() returns MultiFernet when OLD key is set."""
        import importlib
        with patch.dict(os.environ, {
            "CREDENTIAL_ENCRYPTION_KEY": self.primary_key,
            "CREDENTIAL_ENCRYPTION_KEY_OLD": self.old_key,
        }):
            import app.core.security as sec
            import app.core.config as cfg
            # Force reload to pick up patched env
            old_multi = sec._multi
            sec._multi = None
            old_settings = cfg.settings
            cfg.settings = cfg.Settings(
                SECRET_KEY="x" * 32,
                DATABASE_URL="postgresql+asyncpg://x:x@x/x",
                SYNC_DATABASE_URL="postgresql+psycopg2://x:x@x/x",
                CREDENTIAL_ENCRYPTION_KEY=self.primary_key,
                CREDENTIAL_ENCRYPTION_KEY_OLD=self.old_key,
            )
            try:
                from cryptography.fernet import MultiFernet
                fernet = sec._get_fernet()
                self.assertIsInstance(fernet, MultiFernet)
            finally:
                sec._multi = old_multi
                cfg.settings = old_settings


# ─────────────────────────────────────────────────────────────────────────────
# Idempotency guard
# ─────────────────────────────────────────────────────────────────────────────

class TestFernetNeedsEncryption(unittest.TestCase):
    def setUp(self):
        import app.core.security as _sec
        _sec._multi = None  # reset singleton so conftest key is used fresh

    def _fn(self, val: str) -> bool:
        from app.core.encryption_migrations import _fernet_needs_encryption
        return _fernet_needs_encryption(val)

    def test_plaintext_needs_encryption(self):
        self.assertTrue(self._fn("public"))

    def test_empty_string_needs_encryption(self):
        self.assertTrue(self._fn(""))

    def test_json_plaintext_needs_encryption(self):
        self.assertTrue(self._fn('{"Authorization": "Bearer tok"}'))

    def test_valid_fernet_token_does_not_need_encryption(self):
        from app.core.security import encrypt_credential
        token = encrypt_credential("my-secret")
        self.assertFalse(self._fn(token))

    def test_idempotent_double_check(self):
        """Encrypting a value, then checking again must return False."""
        from app.core.security import encrypt_credential
        token = encrypt_credential("passphrase")
        self.assertFalse(self._fn(token))
        # Would not double-encrypt
        self.assertFalse(self._fn(token))


# ─────────────────────────────────────────────────────────────────────────────
# G1 — webhook_headers encrypt/decrypt
# ─────────────────────────────────────────────────────────────────────────────

class TestWebhookHeadersEncryption(unittest.TestCase):
    def setUp(self):
        import app.core.security as _sec
        _sec._multi = None

    def test_encrypt_decrypt_roundtrip(self):
        """Encrypting a headers dict and decrypting must return original."""
        import json
        from app.core.security import encrypt_credential, decrypt_credential_safe
        headers = {"Authorization": "Bearer secret-token", "X-Custom": "value"}
        encrypted = encrypt_credential(json.dumps(headers))
        decrypted = json.loads(decrypt_credential_safe(encrypted))
        self.assertEqual(decrypted, headers)

    def test_encrypted_value_is_not_plaintext(self):
        """Encrypted webhook_headers must not contain the plaintext token."""
        import json
        from app.core.security import encrypt_credential
        headers = {"Authorization": "Bearer super-secret"}
        encrypted = encrypt_credential(json.dumps(headers))
        self.assertNotIn("super-secret", encrypted)
        self.assertNotIn("Bearer", encrypted)

    def test_dispatch_decrypts_before_sending(self):
        """escalation_sender must call decrypt_credential_safe on webhook_headers."""
        import json
        from app.core.security import encrypt_credential
        headers = {"Authorization": "Bearer tok123"}
        encrypted = encrypt_credential(json.dumps(headers))

        rule = MagicMock()
        rule.webhook_headers = encrypted
        rule.webhook_url = "https://hooks.example.com/notify"
        rule.webhook_type = "generic"

        captured_headers = {}

        async def _fake_post(url, *, json=None, headers=None, **kw):
            captured_headers.update(headers or {})
            resp = MagicMock()
            resp.status_code = 200
            return resp

        import asyncio
        from unittest.mock import patch, AsyncMock
        import app.services.escalation_sender as sender

        incident = MagicMock()
        incident.id = 1

        with patch("app.services.escalation_matcher.build_payload", return_value={"event": "test"}):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client.post = AsyncMock(return_value=MagicMock(status_code=200))
                mock_client_cls.return_value = mock_client

                asyncio.run(sender.send_webhook(rule, incident))
                call_kwargs = mock_client.post.call_args
                actual_headers = call_kwargs.kwargs.get("headers", {})
                self.assertIn("Authorization", actual_headers)
                self.assertEqual(actual_headers["Authorization"], "Bearer tok123")

    def test_backward_compat_plaintext_webhook_headers(self):
        """decrypt_credential_safe must handle legacy plaintext JSON."""
        import json
        from app.core.security import decrypt_credential_safe
        plaintext_json = '{"X-Token": "legacy-value"}'
        result = decrypt_credential_safe(plaintext_json)
        # Falls back to plaintext
        self.assertEqual(json.loads(result), {"X-Token": "legacy-value"})


# ─────────────────────────────────────────────────────────────────────────────
# G2 — SNMP v3 passphrase hardening
# ─────────────────────────────────────────────────────────────────────────────

class TestSnmpV3PassphraseHardening(unittest.TestCase):
    def setUp(self):
        import app.core.security as _sec
        _sec._multi = None

    def test_encrypted_passphrase_decrypts_correctly(self):
        from app.core.security import encrypt_credential, decrypt_credential
        passphrase = "Str0ngAuth!Pass#2026"
        enc = encrypt_credential(passphrase)
        self.assertEqual(decrypt_credential(enc), passphrase)

    def test_encrypted_passphrase_fits_text_column(self):
        """Fernet token for a typical passphrase must be under 512 chars."""
        from app.core.security import encrypt_credential
        passphrase = "A" * 64  # generous upper bound for a real passphrase
        enc = encrypt_credential(passphrase)
        self.assertLessEqual(len(enc), 512)

    def test_decrypt_credential_safe_handles_plaintext(self):
        from app.core.security import decrypt_credential_safe
        result = decrypt_credential_safe("public")
        self.assertEqual(result, "public")

    def test_decrypt_credential_safe_handles_fernet_token(self):
        from app.core.security import encrypt_credential, decrypt_credential_safe
        enc = encrypt_credential("authPass123")
        self.assertEqual(decrypt_credential_safe(enc), "authPass123")

    def test_decrypt_credential_safe_handles_none(self):
        from app.core.security import decrypt_credential_safe
        self.assertIsNone(decrypt_credential_safe(None))

    def test_decrypt_credential_safe_handles_empty(self):
        from app.core.security import decrypt_credential_safe
        self.assertIsNone(decrypt_credential_safe(""))


# ─────────────────────────────────────────────────────────────────────────────
# Startup migration functions
# ─────────────────────────────────────────────────────────────────────────────

class TestStartupMigrations(unittest.IsolatedAsyncioTestCase):
    async def _run_webhook_migration(self, rows):
        """Run _encrypt_existing_webhook_headers against mock rows."""
        from app.core.encryption_migrations import _encrypt_existing_webhook_headers
        updates = []

        async def _execute(query, params=None):
            result = MagicMock()
            if params is None:
                result.fetchall.return_value = rows
            else:
                updates.append(params)
            return result

        conn = MagicMock()
        conn.execute = AsyncMock(side_effect=_execute)
        await _encrypt_existing_webhook_headers(conn)
        return updates

    async def test_migration_encrypts_plaintext_webhook_headers(self):
        import json
        plaintext = json.dumps({"Authorization": "Bearer tok"})
        updates = await self._run_webhook_migration([(1, plaintext)])
        self.assertEqual(len(updates), 1)
        encrypted_val = updates[0]["enc"]
        # Must look like a Fernet token (starts with gAAAAA)
        self.assertTrue(encrypted_val.startswith("gAAAAA"), f"Expected Fernet token, got: {encrypted_val[:20]}")

    async def test_migration_skips_already_encrypted(self):
        from app.core.security import encrypt_credential
        already_encrypted = encrypt_credential('{"X-Token": "val"}')
        updates = await self._run_webhook_migration([(1, already_encrypted)])
        self.assertEqual(len(updates), 0, "Should not re-encrypt already-encrypted value")

    async def test_migration_skips_null_rows(self):
        updates = await self._run_webhook_migration([])
        self.assertEqual(len(updates), 0)


if __name__ == "__main__":
    unittest.main()
