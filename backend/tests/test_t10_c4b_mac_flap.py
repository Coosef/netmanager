"""
T10 Faz C C4b — MAC flap (collection transition capture + Redis counter).

evaluate_mac_flap: port DEĞİŞİMİNDE çağrılır; Redis sayaç (window TTL) +
transition ≥ min_transitions → flap alarm spec (DRY-RUN; gerçek shutdown YOK).
NULL pencere/eşik → None (kontrol kapalı). Breach'te bir kez (dedup).

Mevcut tablo port-history tutmadığından flap collection-anında transition ile yakalanır
(historical hesap değil — bkz. docs/T10_FAZ_C_PLAN.md §6).
"""
from app.models.security_policy import PortSecurityPolicy
from app.services.security_policy_service import evaluate_mac_flap


class _FakeRedis:
    def __init__(self):
        self.store = {}
        self.expires = {}

    def incr(self, k):
        self.store[k] = int(self.store.get(k, 0)) + 1
        return self.store[k]

    def expire(self, k, t):
        self.expires[k] = t

    def exists(self, k):
        return 1 if k in self.store else 0

    def setex(self, k, t, v):
        self.store[k] = v
        self.expires[k] = t


def _pol(**kw):
    return PortSecurityPolicy(name=kw.pop("name", "pos"), **kw)


def test_below_threshold_no_alarm():
    r = _FakeRedis()
    pol = _pol(mac_flap_window_min=5, mac_flap_min_transitions=3)
    assert evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/1") is None  # cnt=1
    assert evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/2") is None  # cnt=2


def test_threshold_breach_dry_run_alarm():
    r = _FakeRedis()
    pol = _pol(mac_flap_window_min=5, mac_flap_min_transitions=3, auto_quarantine_on_nth_flap=3)
    for _ in range(2):
        evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/1")
    spec = evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/2")  # cnt=3
    assert spec is not None
    assert spec["event_type"] == "mac_flap"
    assert spec["details"]["transitions"] == 3 and spec["details"]["threshold"] == 3
    assert spec["details"]["dry_run"] is True
    assert spec["details"]["suggested_action"] == "quarantine_port"
    assert spec["details"]["auto_quarantine_on_nth_flap"] == 3
    assert "[policy=pos]" in spec["message"]


def test_dedup_after_breach():
    r = _FakeRedis()
    pol = _pol(mac_flap_window_min=5, mac_flap_min_transitions=2)
    evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/1")          # cnt=1
    first = evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/2")  # cnt=2 → alarm
    second = evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/3") # cnt=3 → dedup
    assert first is not None and second is None


def test_null_window_or_threshold_disables():
    r = _FakeRedis()
    assert evaluate_mac_flap(r, _pol(mac_flap_window_min=None, mac_flap_min_transitions=3),
                             1, 10, "aa:bb", "sw1", "Gi0/1") is None
    assert evaluate_mac_flap(r, _pol(mac_flap_window_min=5, mac_flap_min_transitions=None),
                             1, 10, "aa:bb", "sw1", "Gi0/1") is None


def test_window_ttl_set_on_first():
    r = _FakeRedis()
    pol = _pol(mac_flap_window_min=7, mac_flap_min_transitions=5)
    evaluate_mac_flap(r, pol, 2, 20, "cc:dd", "sw2", "Gi0/1")
    assert r.expires["secpol:flap:2:20:cc:dd"] == 7 * 60   # window dakika → saniye


def test_no_shutdown_only_recommendation():
    # Spec sadece öneri taşır; gerçek port kapatma metadata değil aksiyon değil.
    r = _FakeRedis()
    pol = _pol(mac_flap_window_min=5, mac_flap_min_transitions=1)
    spec = evaluate_mac_flap(r, pol, 1, 10, "aa:bb", "sw1", "Gi0/1")
    assert spec["details"]["dry_run"] is True
    assert "shutdown" not in spec["details"]   # gerçek shutdown alanı yok
