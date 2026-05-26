"""IP allowlist matching — kullanıcı `allowed_ips` field'i için yardımcı.

T9 Tur 2 #4. Format: comma-separated CIDR (örn. "10.0.0.0/8, 192.168.1.5").
NULL/boş → kısıt yok (login engellenmez).

Kullanım:
    if not ip_allowlist.is_allowed(client_ip, user.allowed_ips):
        raise HTTPException(403, "IP allowlist'e dahil değil")

Behavior:
- allowed_csv NULL veya "" → True (kısıt yok)
- client_ip None / boş → True (proxy header parse fail vs — fail-open ama
  güvenli mod isteniyorsa False'a çevrilebilir; şu an permissive)
- CIDR'lerden biri client_ip'yi kapsıyorsa → True
- Tek IP de geçerli ("1.2.3.4") → otomatik /32 olarak yorumlanır
- Geçersiz CIDR sessizce skip (log'lanır, denial sebebi olmaz)
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Optional

log = logging.getLogger(__name__)


def parse_csv(csv: Optional[str]) -> list[str]:
    """CSV'yi normalize edilmiş CIDR listesine çevir. Boş/geçersiz olanları atar."""
    if not csv:
        return []
    items: list[str] = []
    for raw in csv.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            net = ipaddress.ip_network(raw, strict=False)
            items.append(str(net))
        except ValueError:
            # Geçersiz format — atla, kayıt kabul edildiğinde validate edilmeli
            log.debug("ip_allowlist parse_csv: geçersiz cidr atıldı: %r", raw)
            continue
    return items


def is_allowed(client_ip: Optional[str], allowed_csv: Optional[str]) -> bool:
    """client_ip allowed_csv listesi içinde mi?

    Permissive davranır: kısıt yok (NULL/boş) veya IP yok ise True döner.
    Restrictive olmak istenirse fail-closed mode ayrı bir parametre olabilir.
    """
    if not allowed_csv or not allowed_csv.strip():
        return True
    if not client_ip:
        # IP bilinmiyor (proxy header parse fail vs) — engelleme
        return True
    try:
        addr = ipaddress.ip_address(client_ip)
    except ValueError:
        log.warning("ip_allowlist is_allowed: malformed client_ip: %r", client_ip)
        return False

    for raw in allowed_csv.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            net = ipaddress.ip_network(raw, strict=False)
            if addr in net:
                return True
        except ValueError:
            continue
    return False


def validate_csv(csv: Optional[str]) -> tuple[bool, str]:
    """UI/endpoint'in kabul aşamasında kullandığı strict validator.
    Returns: (ok, hata mesajı veya '')"""
    if not csv or not csv.strip():
        return True, ""  # boş kısıt yok demek
    for raw in csv.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ipaddress.ip_network(raw, strict=False)
        except ValueError as e:
            return False, f"Geçersiz IP/CIDR: '{raw}' ({e})"
    return True, ""
