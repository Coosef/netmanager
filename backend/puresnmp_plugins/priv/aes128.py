"""
AES-128-CFB privacy plugin for puresnmp (RFC 3826).
Requires the 'cryptography' package.
"""

import os
import struct
from typing import NamedTuple

IDENTIFIER = "aes128"
IANA_ID = 4


class EncryptionResult(NamedTuple):
    ciphertext: bytes
    salt: bytes


def encrypt_data(
    localised_key: bytes,
    engine_id: bytes,
    engine_boots: int,
    engine_time: int,
    data: bytes,
) -> EncryptionResult:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    # RFC 3826: 16-byte AES key from first 16 bytes of localised key
    aes_key = localised_key[:16]

    # Local IV salt: 8 random bytes
    local_iv = os.urandom(8)

    # IV = engine_boots (4 bytes BE) || engine_time (4 bytes BE) || local_iv (8 bytes)
    iv = (
        struct.pack("!I", engine_boots & 0xFFFFFFFF)
        + struct.pack("!I", engine_time & 0xFFFFFFFF)
        + local_iv
    )

    cipher = Cipher(
        algorithms.AES(aes_key),
        modes.CFB(iv),
        backend=default_backend(),
    )
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(data) + encryptor.finalize()
    return EncryptionResult(ciphertext, local_iv)


def decrypt_data(
    localised_key: bytes,
    engine_id: bytes,
    engine_boots: int,
    engine_time: int,
    salt: bytes,
    data: bytes,
) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    aes_key = localised_key[:16]

    # Reconstruct IV from engine_boots + engine_time + salt (local_iv)
    iv = (
        struct.pack("!I", engine_boots & 0xFFFFFFFF)
        + struct.pack("!I", engine_time & 0xFFFFFFFF)
        + salt
    )

    cipher = Cipher(
        algorithms.AES(aes_key),
        modes.CFB(iv),
        backend=default_backend(),
    )
    decryptor = cipher.decryptor()
    return decryptor.update(data) + decryptor.finalize()
