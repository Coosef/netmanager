"""
Unit tests for syslog_normalizer.py — Faz 2B

Coverage:
- Per-pattern: Cisco IOS/IOS-XE, Aruba OS-CX, Ruijie RG-OS
- Recovery (is_problem=False) paths
- Component extraction and normalisation
- Audit events (config_change) excluded from AVAILABILITY_EVENT_TYPES
- Unknown syslog → None
- Severity escalation (syslog severity_int ≤ 2 → critical)
- AVAILABILITY_EVENT_TYPES membership
"""

import pytest
from app.services.syslog_normalizer import normalize, NormalizedEvent, AVAILABILITY_EVENT_TYPES


# ── Helpers ───────────────────────────────────────────────────────────────────

def n(message: str, facility: int = 23, severity_int: int = 5) -> NormalizedEvent | None:
    """Shorthand: normalize with default facility/severity_int."""
    return normalize(facility, severity_int, message)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Unknown / empty messages → None
# ══════════════════════════════════════════════════════════════════════════════

def test_empty_message_returns_none():
    assert normalize(23, 5, "") is None


def test_unknown_message_returns_none():
    assert n("this is just some random log line with no pattern") is None


def test_authentication_failure_returns_none():
    # authFailure is a security event; availability correlation does not apply
    assert n("Authentication failure from 10.0.0.1") is None


# ══════════════════════════════════════════════════════════════════════════════
# 2. BGP peer down (must match before generic routing patterns)
# ══════════════════════════════════════════════════════════════════════════════

def test_bgp_adjchange_down():
    msg = "%BGP-5-ADJCHANGE: neighbor 10.1.1.2 Down BGP Notification sent"
    result = n(msg)
    assert result is not None
    assert result.event_type == "bgp_peer_down"
    assert result.is_problem is True
    assert result.component == "device"


def test_bgp_neighbor_down_generic():
    msg = "BGP neighbor 192.168.1.1 is now down — hold timer expired"
    result = n(msg)
    assert result is not None
    assert result.event_type == "bgp_peer_down"
    assert result.is_problem is True


def test_bgp_not_matched_as_routing_change():
    # Ensure BGP messages are classified as bgp_peer_down, not routing_change
    msg = "bgp peer neighbor 10.0.0.1 down notification"
    result = n(msg)
    assert result is not None
    assert result.event_type == "bgp_peer_down"


# ══════════════════════════════════════════════════════════════════════════════
# 3. Routing adjacency (OSPF / IS-IS)
# ══════════════════════════════════════════════════════════════════════════════

def test_ospf_adjchg_down():
    msg = "%OSPF-5-ADJCHG: Process 1, Nbr 10.0.0.2 on GigabitEthernet0/1 from FULL to DOWN"
    result = n(msg)
    assert result is not None
    assert result.event_type == "routing_change"
    assert result.is_problem is True


def test_ospf_neighbor_dead():
    msg = "OSPF neighbor 10.0.0.3 is Dead on interface Gi0/2"
    result = n(msg)
    assert result is not None
    assert result.event_type == "routing_change"
    assert result.is_problem is True


def test_isis_adjchg_down():
    msg = "%ISIS-5-ADJCHANGE: Adjacency to R2 (GigabitEthernet0/0) is down, neighbor restarted"
    result = n(msg)
    assert result is not None
    assert result.event_type == "routing_change"
    assert result.is_problem is True


# ══════════════════════════════════════════════════════════════════════════════
# 4. STP events
# ══════════════════════════════════════════════════════════════════════════════

def test_stp_topology_change():
    msg = "%STP-2-TOPOLOGY_CHANGE: Vlan 10 topology change"
    result = n(msg)
    assert result is not None
    assert result.event_type == "stp_event"
    assert result.is_problem is True


def test_stp_bpduguard():
    msg = "%SPANTREE-2-BPDUGUARD_BLOCK: BPDU Guard blocking port GigabitEthernet0/3"
    result = n(msg)
    assert result is not None
    assert result.event_type == "stp_event"


def test_stp_block_pvid_peer():
    msg = "BLOCK_PVID_PEER on port GigabitEthernet0/4"
    result = n(msg)
    assert result is not None
    assert result.event_type == "stp_event"


def test_stp_not_in_availability_event_types():
    # STP is normalised but deliberately excluded from correlation scope
    assert "stp_event" not in AVAILABILITY_EVENT_TYPES


# ══════════════════════════════════════════════════════════════════════════════
# 5. Device restart
# ══════════════════════════════════════════════════════════════════════════════

def test_reload_requested():
    msg = "%SYS-5-RELOAD: Reload requested by console. Reload reason: reload command"
    result = n(msg)
    assert result is not None
    assert result.event_type == "device_restart"
    assert result.is_problem is True
    assert result.severity == "critical"  # rule severity for restart


def test_system_restarted():
    msg = "System restarted -- Cisco IOS Software"
    result = n(msg)
    assert result is not None
    assert result.event_type == "device_restart"
    assert result.is_problem is True


# ══════════════════════════════════════════════════════════════════════════════
# 6. Cisco IOS — interface line protocol
# ══════════════════════════════════════════════════════════════════════════════

def test_cisco_lineproto_down():
    msg = "%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to down"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is True
    assert result.component == "GigabitEthernet0/1"


def test_cisco_lineproto_up():
    msg = "%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/1, changed state to up"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is False
    assert result.component == "GigabitEthernet0/1"


# ══════════════════════════════════════════════════════════════════════════════
# 7. Cisco IOS — interface link state
# ══════════════════════════════════════════════════════════════════════════════

def test_cisco_link_down():
    msg = "%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is True
    assert result.component == "GigabitEthernet0/1"


def test_cisco_link_up():
    msg = "%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to up"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is False
    assert result.component == "GigabitEthernet0/1"


def test_cisco_tengig_interface():
    msg = "%LINK-3-UPDOWN: Interface TenGigabitEthernet1/0/1, changed state to down"
    result = n(msg)
    assert result is not None
    assert result.component == "TenGigabitEthernet1/0/1"


# ══════════════════════════════════════════════════════════════════════════════
# 8. Ruijie RG-OS
# ══════════════════════════════════════════════════════════════════════════════

def test_ruijie_link_status_down():
    msg = "%INTF-5-UPDOWN: Interface GigabitEthernet 0/1 link status changed to down"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is True
    # Whitespace normalised in component
    assert result.component == "GigabitEthernet 0/1"


def test_ruijie_link_status_up():
    msg = "%INTF-5-UPDOWN: Interface GigabitEthernet 0/1 link status changed to up"
    result = n(msg)
    assert result is not None
    assert result.is_problem is False


def test_ruijie_turned_down():
    msg = "Interface XGigabitEthernet1/0/1 is turned down."
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is True
    assert result.component == "XGigabitEthernet1/0/1"


# ══════════════════════════════════════════════════════════════════════════════
# 9. Aruba OS-CX
# ══════════════════════════════════════════════════════════════════════════════

def test_aruba_port_down():
    msg = "UPDN: Port GigabitEthernet1/0/5 is Down"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is True
    assert result.component == "GigabitEthernet1/0/5"


def test_aruba_port_up():
    msg = "UPDN: Port GigabitEthernet1/0/5 is Up"
    result = n(msg)
    assert result is not None
    assert result.event_type == "port_down"
    assert result.is_problem is False
    assert result.component == "GigabitEthernet1/0/5"


def test_aruba_port_name_with_slash():
    msg = "Port 1/0/24 is Down"
    result = n(msg)
    assert result is not None
    assert result.is_problem is True
    assert result.component == "1/0/24"


# ══════════════════════════════════════════════════════════════════════════════
# 10. Config change — audit event (must NOT open incidents)
# ══════════════════════════════════════════════════════════════════════════════

def test_config_change_normalised():
    msg = "%SYS-5-CONFIG_I: Configured from console by admin"
    result = n(msg)
    assert result is not None
    assert result.event_type == "config_change"
    assert result.is_problem is False   # never a problem signal


def test_config_change_configured_from():
    msg = "Configured from 10.0.0.1 by SSH"
    result = n(msg)
    assert result is not None
    assert result.event_type == "config_change"
    assert result.is_problem is False


def test_config_change_not_in_availability_event_types():
    assert "config_change" not in AVAILABILITY_EVENT_TYPES


# ══════════════════════════════════════════════════════════════════════════════
# 11. AVAILABILITY_EVENT_TYPES completeness
# ══════════════════════════════════════════════════════════════════════════════

def test_availability_event_types_contains_port_down():
    assert "port_down" in AVAILABILITY_EVENT_TYPES


def test_availability_event_types_contains_device_restart():
    assert "device_restart" in AVAILABILITY_EVENT_TYPES


def test_availability_event_types_contains_routing_change():
    assert "routing_change" in AVAILABILITY_EVENT_TYPES


def test_availability_event_types_contains_bgp_peer_down():
    assert "bgp_peer_down" in AVAILABILITY_EVENT_TYPES


# ══════════════════════════════════════════════════════════════════════════════
# 12. Severity escalation (syslog severity_int ≤ 2 → critical)
# ══════════════════════════════════════════════════════════════════════════════

def test_severity_escalated_for_emergency():
    # rule.severity for port_down is "warning", but syslog says emergency (0)
    msg = "%LINK-0-UPDOWN: Interface GigabitEthernet0/1, changed state to down"
    result = normalize(23, 0, msg)
    assert result is not None
    assert result.severity == "critical"


def test_severity_not_escalated_for_normal():
    msg = "%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down"
    result = normalize(23, 5, msg)
    assert result is not None
    assert result.severity == "warning"  # rule default, not escalated


def test_severity_escalated_at_boundary():
    # severity_int=2 (critical in RFC3164) → escalate
    msg = "%LINK-2-UPDOWN: Interface GigabitEthernet0/1, changed state to down"
    result = normalize(23, 2, msg)
    assert result is not None
    assert result.severity == "critical"


def test_severity_not_escalated_at_boundary_plus_one():
    # severity_int=3 (error) → no escalation, keep rule severity
    msg = "%LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down"
    result = normalize(23, 3, msg)
    assert result is not None
    assert result.severity == "warning"


# ══════════════════════════════════════════════════════════════════════════════
# 13. Component normalisation
# ══════════════════════════════════════════════════════════════════════════════

def test_component_trailing_comma_stripped():
    # Pattern captures "GigabitEthernet0/1," — comma must be stripped
    msg = "Interface GigabitEthernet0/1, changed state to down"
    result = n(msg)
    assert result is not None
    assert result.component == "GigabitEthernet0/1"
    assert not result.component.endswith(",")


def test_component_whitespace_collapsed():
    # Ruijie "GigabitEthernet 0/1" — internal space preserved, no double spaces
    msg = "Interface GigabitEthernet  0/1 link status changed to down"
    result = n(msg)
    assert result is not None
    assert "  " not in result.component  # no double spaces


def test_component_defaults_to_device_when_no_group():
    msg = "%OSPF-5-ADJCHG: Process 1, Nbr 10.0.0.2 from FULL to DOWN"
    result = n(msg)
    assert result is not None
    assert result.component == "device"


# ══════════════════════════════════════════════════════════════════════════════
# 14. Regression: patterns must not over-match
# ══════════════════════════════════════════════════════════════════════════════

def test_spanning_tree_normal_port_state_is_not_port_down():
    # "port" in STP messages without "is Down/Up" should NOT match port pattern
    msg = "%STP-2-TOPOLOGY_CHANGE: Vlan 10 topology change notified to port GigabitEthernet0/1"
    result = n(msg)
    # Should match stp_event, not port_down
    assert result is not None
    assert result.event_type == "stp_event"


def test_ospf_neighbor_recovery_not_matched():
    # "neighbor X UP" — no recovery path for routing (only problem side)
    msg = "%OSPF-5-ADJCHG: neighbor 10.0.0.1 from EXSTART to FULL"
    result = n(msg)
    # No "down" in message → no match → None
    assert result is None
