"""T9 Tur 7 — IPAM service helpers.

CIDR math + utilization + free-IP suggestion. Kept DB-light: most queries
are simple selects; the heavy lifting (CIDR contains, network masks)
lives in PostgreSQL via the INET/CIDR operators, which are indexed by
the GIST index `ix_ipam_subnets_cidr_gist`.
"""
from __future__ import annotations

import ipaddress
from typing import Any, Optional

from sqlalchemy import and_, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ipam import IpamAssignment, IpamSubnet


# ── CIDR validation ─────────────────────────────────────────────────────────

def parse_cidr(value: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    """Validate + normalize a user-supplied CIDR string. Accepts host bits
    only when strict=False makes sense (we force strict=True so the operator
    can't paste '10.0.0.5/24' and corrupt the network)."""
    try:
        return ipaddress.ip_network(value, strict=True)
    except ValueError as exc:
        raise ValueError(f"Geçersiz CIDR: {value} ({exc})")


def parse_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        return ipaddress.ip_address(value)
    except ValueError as exc:
        raise ValueError(f"Geçersiz IP: {value} ({exc})")


def is_ip_in_subnet(ip: str, cidr: str) -> bool:
    try:
        return parse_ip(ip) in parse_cidr(cidr)
    except ValueError:
        return False


# ── Utilization ─────────────────────────────────────────────────────────────

def subnet_total_addresses(cidr: str) -> int:
    """Total assignable addresses in the CIDR.

    For IPv4: subtract network + broadcast (so /24 → 254 hosts).
    For /31 and /32 we keep all (RFC 3021 / point-to-point).
    For IPv6: large; we cap reporting at network.num_addresses but the
    'utilization %' becomes meaningless above a certain prefix length —
    handled at the UI layer.
    """
    net = parse_cidr(cidr)
    total = net.num_addresses
    if isinstance(net, ipaddress.IPv4Network) and net.prefixlen < 31:
        total -= 2  # network + broadcast
    return total


async def compute_utilization(db: AsyncSession, subnet: IpamSubnet) -> dict:
    """Returns {used, total, pct} for the subnet's assignment table.

    'Used' counts assignments whose type isn't network/broadcast (those
    are reserved by definition and don't count toward operator capacity).
    """
    used_q = (
        select(func.count(IpamAssignment.id))
        .where(
            IpamAssignment.subnet_id == subnet.id,
            IpamAssignment.type.notin_(["network", "broadcast"]),
        )
    )
    used = (await db.execute(used_q)).scalar_one() or 0
    total = subnet_total_addresses(subnet.cidr)
    pct = round((used / total) * 100, 1) if total > 0 else 0.0
    return {
        "used": used,
        "total": total,
        "pct": pct,
        "free": max(0, total - used),
        "warn_pct": subnet.utilization_warn_pct,
        "is_high": pct >= subnet.utilization_warn_pct,
    }


# ── Free IP suggestion ──────────────────────────────────────────────────────

async def suggest_free_ips(
    db: AsyncSession, subnet: IpamSubnet, count: int = 1,
    *, exclude_dhcp_range: bool = True,
) -> list[str]:
    """Return up to `count` unassigned host IPs from the subnet.

    Walks the CIDR top-down; excludes:
      - network / broadcast addresses
      - any existing assignment (any type)
      - the DHCP pool [start..end] when `exclude_dhcp_range=True`
    Worst-case linear in (assignments + range); fine up to /16 — bigger
    subnets pre-segmented via parent_subnet_id.
    """
    net = parse_cidr(subnet.cidr)
    if count <= 0:
        return []

    # Collect taken IPs into a set (string form — INET compares as str OK
    # but we keep cleanliness via ipaddress).
    rows = (await db.execute(
        select(IpamAssignment.ip_address).where(IpamAssignment.subnet_id == subnet.id)
    )).scalars().all()
    taken: set[str] = {str(ipaddress.ip_address(r.split("/")[0]) if "/" in str(r) else r)
                       for r in rows}

    dhcp_range = None
    if exclude_dhcp_range and subnet.dhcp_enabled and subnet.dhcp_range_start and subnet.dhcp_range_end:
        try:
            start = int(parse_ip(str(subnet.dhcp_range_start)))
            end = int(parse_ip(str(subnet.dhcp_range_end)))
            if start <= end:
                dhcp_range = (start, end)
        except ValueError:
            pass

    out: list[str] = []
    hosts = net.hosts() if isinstance(net, (ipaddress.IPv4Network, ipaddress.IPv6Network)) else []
    # For /31 net.hosts() returns 0 entries; iterate all addresses then.
    if isinstance(net, ipaddress.IPv4Network) and net.prefixlen >= 31:
        hosts = list(net)
    for addr in hosts:
        s = str(addr)
        if s in taken:
            continue
        if dhcp_range is not None and dhcp_range[0] <= int(addr) <= dhcp_range[1]:
            continue
        out.append(s)
        if len(out) >= count:
            break
    return out


# ── Hierarchy resolution ────────────────────────────────────────────────────

async def find_containing_subnet(
    db: AsyncSession, ip: str, organization_id: int,
) -> Optional[IpamSubnet]:
    """Return the most-specific subnet (longest prefix) containing `ip`."""
    # PostgreSQL `>>` "supernet of" + ORDER BY masklen DESC gives the
    # most-specific match.
    sql = text("""
        SELECT * FROM ipam_subnets
        WHERE organization_id = :org_id
          AND cidr >>= cast(:ip as inet)
          AND deleted_at IS NULL
        ORDER BY masklen(cidr) DESC
        LIMIT 1
    """)
    row = (await db.execute(sql, {"org_id": organization_id, "ip": ip})).mappings().first()
    if row is None:
        return None
    # Re-fetch via ORM for relationship hydration.
    return (await db.execute(
        select(IpamSubnet).where(IpamSubnet.id == row["id"])
    )).scalar_one_or_none()


# ── Conflict detection ─────────────────────────────────────────────────────

async def find_overlapping_subnets(
    db: AsyncSession, cidr: str, organization_id: int,
    *, exclude_id: Optional[int] = None,
) -> list[IpamSubnet]:
    """Subnets in the same org whose CIDR overlaps with `cidr`.

    NB: asyncpg '::int' cast operatörü ':param' placeholder ile çakışıyor —
    bu yüzden exclude_id'i Python tarafında koşullu WHERE clause ile ekliyoruz.
    """
    base_sql = """
        SELECT id FROM ipam_subnets
        WHERE organization_id = :org_id
          AND deleted_at IS NULL
          AND cidr && cast(:cidr as cidr)
    """
    params: dict[str, Any] = {"org_id": organization_id, "cidr": cidr}
    if exclude_id is not None:
        base_sql += " AND id <> :exclude_id"
        params["exclude_id"] = exclude_id
    rows = (await db.execute(text(base_sql), params)).all()
    if not rows:
        return []
    ids = [r[0] for r in rows]
    return list((await db.execute(
        select(IpamSubnet).where(IpamSubnet.id.in_(ids))
    )).scalars().all())
