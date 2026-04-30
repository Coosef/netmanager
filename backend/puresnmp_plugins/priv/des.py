"""
DES-CBC privacy plugin for puresnmp (RFC 3414, section 8).
Requires the 'cryptography' package.
"""

import os
import struct
from typing import NamedTuple

IDENTIFIER = "des"
IANA_ID = 2


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

    # RFC 3414: first 8 bytes of 16-byte localized key = DES key,
    # last 8 bytes = pre-IV
    des_key = localised_key[:8]
    pre_iv = localised_key[8:16]

    # Salt = engine_boots (4 bytes) || random (4 bytes)
    salt = struct.pack("!I", engine_boots & 0xFFFFFFFF) + os.urandom(4)

    # IV = pre_IV XOR salt
    iv = bytes(a ^ b for a, b in zip(pre_iv, salt))

    # Pad data to 8-byte block boundary
    pad_len = (8 - len(data) % 8) % 8
    data_padded = data + bytes(pad_len)

    cipher = Cipher(
        algorithms.TripleDES(des_key + des_key + des_key),  # 3DES with same key (DES-CBC compat)
        modes.CBC(iv),
        backend=default_backend(),
    )
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(data_padded) + encryptor.finalize()
    return EncryptionResult(ciphertext, salt)


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

    des_key = localised_key[:8]
    pre_iv = localised_key[8:16]
    iv = bytes(a ^ b for a, b in zip(pre_iv, salt))

    cipher = Cipher(
        algorithms.TripleDES(des_key + des_key + des_key),
        modes.CBC(iv),
        backend=default_backend(),
    )
    decryptor = cipher.decryptor()
    return decryptor.update(data) + decryptor.finalize()
