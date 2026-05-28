"""
T10 Faz C C3 — policy-driven health anomaly (CPU + Memory).

evaluate_switch_health: saf eşik değerlendirme (DB/SNMP yok). NULL eşik → skip,
NULL metrik → skip, critical>warning önceliği, `[policy=<name>]` etiketi.
poll_device_health task'ı bunu kullanır; feature kapalı org atlanır (canlı/entegrasyon).
"""
from app.models.security_policy import SwitchSecurityPolicy
from app.services.security_policy_service import evaluate_switch_health


def _pol(**kw):
    return SwitchSecurityPolicy(name=kw.pop("name", "Default"), **kw)


def test_cpu_critical():
    out = evaluate_switch_health("sw1", _pol(cpu_warning=70, cpu_critical=85), {"cpu_pct": 90})
    assert len(out) == 1
    a = out[0]
    assert a["event_type"] == "high_cpu" and a["severity"] == "critical"
    assert "[policy=Default]" in a["message"]
    assert a["details"]["value"] == 90 and a["details"]["threshold"] == 85


def test_cpu_warning_band():
    out = evaluate_switch_health("sw1", _pol(cpu_warning=70, cpu_critical=85), {"cpu_pct": 75})
    assert out[0]["severity"] == "warning" and out[0]["details"]["threshold"] == 70


def test_cpu_below_warning_no_alarm():
    out = evaluate_switch_health("sw1", _pol(cpu_warning=70, cpu_critical=85), {"cpu_pct": 50})
    assert out == []


def test_null_threshold_skips_silently():
    # cpu_warning/critical NULL → CPU kontrolü kapalı, metrik yüksek olsa bile alarm yok
    out = evaluate_switch_health("sw1", _pol(cpu_warning=None, cpu_critical=None), {"cpu_pct": 99})
    assert out == []


def test_null_metric_skips():
    # SNMP cpu döndürmedi (None) → skip
    out = evaluate_switch_health("sw1", _pol(cpu_warning=70, cpu_critical=85), {"cpu_pct": None})
    assert out == []


def test_memory_critical_and_label():
    out = evaluate_switch_health("sw1", _pol(name="Backbone", memory_warning=75, memory_critical=85),
                                 {"ram_pct": 88})
    assert out[0]["event_type"] == "high_memory" and out[0]["severity"] == "critical"
    assert "[policy=Backbone]" in out[0]["message"]


def test_cpu_and_memory_together():
    out = evaluate_switch_health(
        "sw1", _pol(cpu_warning=70, cpu_critical=85, memory_warning=75, memory_critical=90),
        {"cpu_pct": 95, "ram_pct": 80})
    kinds = {(a["event_type"], a["severity"]) for a in out}
    assert ("high_cpu", "critical") in kinds
    assert ("high_memory", "warning") in kinds


def test_dedup_metric_keys_distinct():
    out = evaluate_switch_health(
        "sw1", _pol(cpu_critical=85, memory_critical=90), {"cpu_pct": 90, "ram_pct": 95})
    metrics = {a["metric"] for a in out}
    assert metrics == {"cpu", "mem"}   # ayrı dedup key'ler (cpu:/mem:)
