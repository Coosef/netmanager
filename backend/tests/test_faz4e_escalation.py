"""
Faz 4E — Escalation Rule Engine

Tests for app.services.escalation_matcher:
  - matches_rule(): severity / event_type / source / duration / state / disabled filters
  - cooldown_cutoff(): returns correct datetime boundary
  - Payload builders: slack / generic / jira structure validation
"""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.services.escalation_matcher import (
    matches_rule,
    cooldown_cutoff,
    build_slack_payload,
    build_generic_payload,
    build_jira_payload,
    build_payload,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_incident(**kwargs):
    inc = MagicMock()
    inc.id              = kwargs.get("id", 1)
    inc.fingerprint     = kwargs.get("fingerprint", "abc123")
    inc.severity        = kwargs.get("severity", "critical")
    inc.event_type      = kwargs.get("event_type", "device_offline")
    inc.component       = kwargs.get("component", None)
    inc.state           = kwargs.get("state", "OPEN")
    inc.device_id       = kwargs.get("device_id", 10)
    inc.device_hostname = kwargs.get("device_hostname", "sw-01")
    inc.device_ip       = kwargs.get("device_ip", "10.0.0.1")
    inc.sources         = kwargs.get("sources", [])
    inc.opened_at       = kwargs.get("opened_at", datetime.now(timezone.utc) - timedelta(hours=1))
    inc.closed_at       = kwargs.get("closed_at", None)
    return inc


def _make_rule(**kwargs):
    rule = MagicMock()
    rule.enabled            = kwargs.get("enabled", True)
    rule.match_severity     = kwargs.get("match_severity", None)
    rule.match_event_types  = kwargs.get("match_event_types", None)
    rule.match_sources      = kwargs.get("match_sources", None)
    rule.min_duration_secs  = kwargs.get("min_duration_secs", None)
    rule.match_states       = kwargs.get("match_states", None)
    rule.webhook_type       = kwargs.get("webhook_type", "slack")
    rule.webhook_url        = kwargs.get("webhook_url", "https://hooks.example.com/test")
    rule.cooldown_secs      = kwargs.get("cooldown_secs", 3600)
    return rule


# ── matches_rule() ────────────────────────────────────────────────────────────

def test_matches_rule_all_none():
    """No matchers set → matches everything."""
    assert matches_rule(_make_incident(), _make_rule()) is True


def test_matches_rule_disabled():
    assert matches_rule(_make_incident(), _make_rule(enabled=False)) is False


def test_matches_rule_severity_match():
    rule = _make_rule(match_severity=json.dumps(["critical", "warning"]))
    assert matches_rule(_make_incident(severity="critical"), rule) is True
    assert matches_rule(_make_incident(severity="warning"), rule) is True


def test_matches_rule_severity_no_match():
    rule = _make_rule(match_severity=json.dumps(["critical"]))
    assert matches_rule(_make_incident(severity="info"), rule) is False


def test_matches_rule_event_type_match():
    rule = _make_rule(match_event_types=json.dumps(["device_offline", "port_down"]))
    assert matches_rule(_make_incident(event_type="device_offline"), rule) is True


def test_matches_rule_event_type_no_match():
    rule = _make_rule(match_event_types=json.dumps(["device_offline"]))
    assert matches_rule(_make_incident(event_type="threshold_alert"), rule) is False


def test_matches_rule_source_match():
    sources = [{"source": "snmp_trap", "confidence": 0.9, "ts": "2026-01-01T00:00:00Z"}]
    rule = _make_rule(match_sources=json.dumps(["snmp_trap"]))
    assert matches_rule(_make_incident(sources=sources), rule) is True


def test_matches_rule_source_no_match():
    sources = [{"source": "syslog", "confidence": 0.7, "ts": "2026-01-01T00:00:00Z"}]
    rule = _make_rule(match_sources=json.dumps(["snmp_trap", "synthetic"]))
    assert matches_rule(_make_incident(sources=sources), rule) is False


def test_matches_rule_duration_not_met():
    opened = datetime.now(timezone.utc) - timedelta(minutes=10)  # 600s ago
    rule = _make_rule(min_duration_secs=3600)
    assert matches_rule(_make_incident(opened_at=opened), rule) is False


def test_matches_rule_duration_met():
    opened = datetime.now(timezone.utc) - timedelta(hours=2)  # 7200s ago
    rule = _make_rule(min_duration_secs=3600)
    assert matches_rule(_make_incident(opened_at=opened), rule) is True


def test_matches_rule_state_default_open_degraded():
    """Default match_states=None → matches OPEN and DEGRADED, not RECOVERING."""
    rule = _make_rule()
    assert matches_rule(_make_incident(state="OPEN"),       rule) is True
    assert matches_rule(_make_incident(state="DEGRADED"),   rule) is True
    assert matches_rule(_make_incident(state="RECOVERING"), rule) is False
    assert matches_rule(_make_incident(state="CLOSED"),     rule) is False


def test_matches_rule_custom_states():
    rule = _make_rule(match_states=json.dumps(["RECOVERING"]))
    assert matches_rule(_make_incident(state="RECOVERING"), rule) is True
    assert matches_rule(_make_incident(state="OPEN"),       rule) is False


def test_matches_rule_source_empty_incident():
    """Incident has no sources → match_sources filter rejects it."""
    rule = _make_rule(match_sources=json.dumps(["snmp_trap"]))
    assert matches_rule(_make_incident(sources=[]), rule) is False


# ── cooldown_cutoff() ─────────────────────────────────────────────────────────

def test_cooldown_cutoff_correct():
    now = datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc)
    cutoff = cooldown_cutoff(3600, now=now)
    assert cutoff == datetime(2026, 5, 13, 11, 0, 0, tzinfo=timezone.utc)


def test_cooldown_cutoff_zero():
    now = datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc)
    assert cooldown_cutoff(0, now=now) == now


# ── Payload builders ──────────────────────────────────────────────────────────

def test_build_slack_payload_structure():
    inc = _make_incident(severity="critical", event_type="device_offline")
    p = build_slack_payload(inc)
    assert "attachments" in p
    att = p["attachments"][0]
    assert att["color"] == "#ef4444"
    assert "CRITICAL" in att["title"]
    assert "device_offline" in att["title"]
    assert "sw-01" in att["text"]


def test_build_slack_payload_warning_color():
    inc = _make_incident(severity="warning")
    p = build_slack_payload(inc)
    assert p["attachments"][0]["color"] == "#f59e0b"


def test_build_generic_payload_fields():
    inc = _make_incident(id=42, severity="warning", event_type="port_down",
                         state="DEGRADED", device_hostname="r-01", device_ip="10.1.1.1")
    p = build_generic_payload(inc)
    assert p["incident_id"] == 42
    assert p["severity"] == "warning"
    assert p["event_type"] == "port_down"
    assert p["state"] == "DEGRADED"
    assert p["device_hostname"] == "r-01"
    assert p["device_ip"] == "10.1.1.1"


def test_build_jira_payload_fields():
    inc = _make_incident(severity="critical", event_type="device_offline",
                         device_hostname="sw-01", device_ip="10.0.0.1")
    p = build_jira_payload(inc)
    assert "CRITICAL" in p["summary"]
    assert p["priority"] == "Highest"
    assert "netmanager" in p["labels"]
    assert "critical" in p["labels"]
    assert p["incident_id"] == inc.id


def test_build_payload_routes_correctly():
    inc = _make_incident()
    assert "attachments" in build_payload("slack", inc)
    assert "incident_id" in build_payload("generic", inc)
    assert "summary" in build_payload("jira", inc)
    assert "incident_id" in build_payload("unknown_type", inc)  # falls back to generic
