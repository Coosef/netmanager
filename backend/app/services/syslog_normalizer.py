"""
Syslog Normalization Engine — Faz 2B

Converts raw syslog message text into structured NormalizedEvent objects
for feeding into the correlation engine.

Design principles:
- Conservative: false negatives are better than false positives
- Vendor-agnostic: match semantic content, not platform-specific prefixes
- Ordered: most-specific patterns win (BGP before generic routing)
- Audit-safe: config_change is normalised but filtered from correlation callers
  via AVAILABILITY_EVENT_TYPES — it never opens an availability incident
"""

import re
from dataclasses import dataclass

# ── Public API ────────────────────────────────────────────────────────────────

# Only these event types should be fed into the correlation engine.
# stp_event and config_change are returned by normalize() for future
# notification/audit use, but deliberately excluded from availability incidents.
AVAILABILITY_EVENT_TYPES: frozenset[str] = frozenset({
    "port_down",
    "device_restart",
    "routing_change",
    "bgp_peer_down",
})


@dataclass(frozen=True)
class NormalizedEvent:
    event_type: str   # port_down | device_restart | stp_event | routing_change | bgp_peer_down | config_change
    component: str    # interface name (e.g. "GigabitEthernet0/1") or "device"
    is_problem: bool  # False = recovery / clear signal
    severity: str     # critical | warning | info


# ── Internal rule table ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Rule:
    pattern: re.Pattern
    event_type: str
    component_group: int | None  # capture group for interface name; None → "device"
    is_problem: bool
    severity: str


# Rules are evaluated in order — first match wins.
# Vendor coverage: Cisco IOS/IOS-XE, Aruba OS-CX, Ruijie RG-OS.
_RULES: list[_Rule] = [

    # ── BGP (before generic routing — BGP messages also contain "neighbor … down") ──
    _Rule(
        re.compile(r"%BGP\S*\s+ADJCHANGE.+?down", re.IGNORECASE),
        "bgp_peer_down", None, True, "warning",
    ),
    _Rule(
        re.compile(r"bgp.{0,60}neighbor.{0,40}\bdown\b", re.IGNORECASE),
        "bgp_peer_down", None, True, "warning",
    ),

    # ── OSPF / IS-IS / generic routing adjacency ─────────────────────────────
    _Rule(
        re.compile(r"ADJ(?:CHG|CHANGE).{0,80}\bdown\b", re.IGNORECASE),
        "routing_change", None, True, "warning",
    ),
    _Rule(
        re.compile(r"ospf.{0,60}neighbor.{0,40}dead", re.IGNORECASE),
        "routing_change", None, True, "warning",
    ),
    _Rule(
        # Generic "neighbor X Down" — must come after the BGP rules above
        re.compile(r"(?<!bgp\s)neighbor\s+\S+\s+down", re.IGNORECASE),
        "routing_change", None, True, "warning",
    ),

    # ── STP ───────────────────────────────────────────────────────────────────
    _Rule(
        re.compile(r"topology.?change|BLOCK_PVID_PEER|bpduguard|bdpuguard", re.IGNORECASE),
        "stp_event", None, True, "warning",
    ),

    # ── Device restart / reload ───────────────────────────────────────────────
    _Rule(
        re.compile(r"reload\s+requested|system\s+restarted|%SYS.{0,20}RELOAD", re.IGNORECASE),
        "device_restart", None, True, "critical",
    ),

    # ── Interface line-protocol (Cisco: most explicit, must be before link-state) ──
    # %LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to down
    _Rule(
        re.compile(
            r"line\s+protocol\s+on\s+interface\s+(.+?)(?:,)?\s+changed\s+state\s+to\s+down",
            re.IGNORECASE,
        ),
        "port_down", 1, True, "warning",
    ),
    _Rule(
        re.compile(
            r"line\s+protocol\s+on\s+interface\s+(.+?)(?:,)?\s+changed\s+state\s+to\s+up",
            re.IGNORECASE,
        ),
        "port_down", 1, False, "info",
    ),

    # ── Interface link state (Cisco IOS + Ruijie) ─────────────────────────────
    # %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down
    _Rule(
        re.compile(r"interface\s+(.+?),\s+changed\s+state\s+to\s+down", re.IGNORECASE),
        "port_down", 1, True, "warning",
    ),
    _Rule(
        re.compile(r"interface\s+(.+?),\s+changed\s+state\s+to\s+up", re.IGNORECASE),
        "port_down", 1, False, "info",
    ),

    # ── Ruijie RG-OS interface variants ──────────────────────────────────────
    # %INTF-5-UPDOWN: Interface GigabitEthernet 0/1 link status changed to down
    _Rule(
        re.compile(r"interface\s+(.+?)\s+link\s+status\s+changed\s+to\s+down", re.IGNORECASE),
        "port_down", 1, True, "warning",
    ),
    _Rule(
        re.compile(r"interface\s+(.+?)\s+link\s+status\s+changed\s+to\s+up", re.IGNORECASE),
        "port_down", 1, False, "info",
    ),
    # Ruijie: Interface XGigabitEthernet1/0/1 is turned down
    _Rule(
        re.compile(r"interface\s+(\S+)\s+is\s+turned\s+down", re.IGNORECASE),
        "port_down", 1, True, "warning",
    ),

    # ── Aruba OS-CX port state ────────────────────────────────────────────────
    # UPDN: Port GigabitEthernet1/0/1 is Down
    _Rule(
        re.compile(r"port\s+(\S+)\s+is\s+down", re.IGNORECASE),
        "port_down", 1, True, "warning",
    ),
    _Rule(
        re.compile(r"port\s+(\S+)\s+is\s+up", re.IGNORECASE),
        "port_down", 1, False, "info",
    ),

    # ── Config change — audit only, is_problem=False, excluded from correlation ──
    _Rule(
        re.compile(r"configured\s+from|SYS-\d-CONFIG_I", re.IGNORECASE),
        "config_change", None, False, "info",
    ),
]


def normalize(facility: int, severity_int: int, message: str) -> NormalizedEvent | None:
    """
    Match message against the known-pattern table.

    Returns NormalizedEvent if a pattern matches, None otherwise.
    None means the message is unknown — callers should store it as a raw
    syslog buffer entry without forwarding to the correlation engine.

    facility    : RFC3164 facility code (0–23); available for future use
    severity_int: RFC3164 severity (0=emergency … 7=debug); used to escalate
                  to "critical" when the device itself reports 0–2
    message     : raw syslog message text (stripped of timestamp / hostname prefix)
    """
    if not message:
        return None

    for rule in _RULES:
        m = rule.pattern.search(message)
        if not m:
            continue

        # Extract interface/component name from capture group, or default to "device"
        if rule.component_group is not None:
            try:
                raw_component = m.group(rule.component_group)
                # Normalise: strip trailing punctuation, collapse whitespace
                component = " ".join(raw_component.split()).rstrip(",.")
            except IndexError:
                component = "device"
        else:
            component = "device"

        # Escalate severity when the device itself reports an emergency/alert/critical
        severity = "critical" if severity_int <= 2 else rule.severity

        return NormalizedEvent(
            event_type=rule.event_type,
            component=component,
            is_problem=rule.is_problem,
            severity=severity,
        )

    return None
