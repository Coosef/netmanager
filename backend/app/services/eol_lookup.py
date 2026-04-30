"""Static EOL/EOS lookup for common network equipment.

Dates are sourced from vendor EoL bulletins (Cisco, Aruba, Ruijie).
Matching strategy: normalise model string → longest-prefix match → regex alias fallback.
"""
import re
from datetime import date
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# EOL Database — keyed by model prefix (normalised: uppercase, no spaces/dashes)
# Values: eol / eos as ISO strings (or None = still active / not announced)
# ─────────────────────────────────────────────────────────────────────────────

_EOL_DB: dict[str, dict] = {
    # ── Cisco Catalyst 2960 ──────────────────────────────────────────────────
    "WSC2960S":   {"eol": "2020-01-31", "eos": "2017-01-31"},
    "WSC2960X":   {"eol": "2026-10-31", "eos": "2023-10-31"},
    "WSC2960CX":  {"eol": "2026-10-31", "eos": "2023-10-31"},
    "WSC2960L":   {"eol": "2027-01-31", "eos": "2024-01-31"},
    "WSC2960":    {"eol": "2020-01-31", "eos": "2017-01-31"},

    # ── Cisco Catalyst 3560 ──────────────────────────────────────────────────
    "WSC3560CX":  {"eol": "2026-04-30", "eos": "2023-04-30"},
    "WSC3560X":   {"eol": "2024-10-31", "eos": "2021-10-31"},
    "WSC3560E":   {"eol": "2018-01-31", "eos": "2016-01-31"},
    "WSC3560G":   {"eol": "2018-01-31", "eos": "2016-01-31"},
    "WSC3560":    {"eol": "2018-01-31", "eos": "2016-01-31"},

    # ── Cisco Catalyst 3650 ──────────────────────────────────────────────────
    "WSC3650":    {"eol": "2026-10-31", "eos": "2023-10-31"},

    # ── Cisco Catalyst 3750 ──────────────────────────────────────────────────
    "WSC3750X":   {"eol": "2022-10-31", "eos": "2019-10-31"},
    "WSC3750G":   {"eol": "2016-10-31", "eos": "2013-10-31"},
    "WSC3750E":   {"eol": "2016-10-31", "eos": "2013-10-31"},
    "WSC3750":    {"eol": "2013-07-26", "eos": "2013-07-26"},

    # ── Cisco Catalyst 3850 ──────────────────────────────────────────────────
    "WSC3850":    {"eol": "2026-10-31", "eos": "2023-10-31"},

    # ── Cisco Catalyst 4500 ──────────────────────────────────────────────────
    "WSC4500X":   {"eol": "2027-01-31", "eos": "2024-01-31"},
    "WSC4507":    {"eol": "2022-07-31", "eos": "2019-07-31"},
    "WSC4506":    {"eol": "2022-07-31", "eos": "2019-07-31"},
    "WSC4503":    {"eol": "2022-07-31", "eos": "2019-07-31"},

    # ── Cisco Catalyst 6500 ──────────────────────────────────────────────────
    "WSC6509":    {"eol": "2020-01-31", "eos": "2017-01-31"},
    "WSC6506":    {"eol": "2020-01-31", "eos": "2017-01-31"},
    "WSC6504":    {"eol": "2020-01-31", "eos": "2017-01-31"},
    "WSC6500":    {"eol": "2020-01-31", "eos": "2017-01-31"},
    "WSC6807":    {"eol": "2026-01-31", "eos": "2023-01-31"},

    # ── Cisco Catalyst 9000 (active — no EOL) ────────────────────────────────
    "C9200":      {"eol": None, "eos": None},
    "C9300":      {"eol": None, "eos": None},
    "C9400":      {"eol": None, "eos": None},
    "C9500":      {"eol": None, "eos": None},
    "C9600":      {"eol": None, "eos": None},

    # ── Cisco ISR ────────────────────────────────────────────────────────────
    "ISR4321":    {"eol": "2026-07-31", "eos": "2023-07-31"},
    "ISR4331":    {"eol": "2026-07-31", "eos": "2023-07-31"},
    "ISR4351":    {"eol": "2026-07-31", "eos": "2023-07-31"},
    "ISR4431":    {"eol": "2026-07-31", "eos": "2023-07-31"},
    "ISR4451":    {"eol": "2026-07-31", "eos": "2023-07-31"},
    "ISR1100":    {"eol": None, "eos": None},
    "ISR900":     {"eol": "2026-03-31", "eos": "2023-03-31"},
    "ISR800":     {"eol": "2020-07-31", "eos": "2017-07-31"},
    "CISCO2901":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO2911":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO2921":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO2951":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO3925":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO3945":  {"eol": "2023-01-31", "eos": "2020-01-31"},
    "CISCO1841":  {"eol": "2015-04-30", "eos": "2013-04-30"},
    "CISCO2801":  {"eol": "2013-07-26", "eos": "2013-07-26"},
    "CISCO2811":  {"eol": "2013-07-26", "eos": "2013-07-26"},
    "CISCO2821":  {"eol": "2013-07-26", "eos": "2013-07-26"},
    "CISCO2851":  {"eol": "2013-07-26", "eos": "2013-07-26"},

    # ── Cisco ASR ────────────────────────────────────────────────────────────
    "ASR1001X":   {"eol": None, "eos": None},
    "ASR1002X":   {"eol": None, "eos": None},
    "ASR1006X":   {"eol": None, "eos": None},
    "ASR9001":    {"eol": None, "eos": None},
    "ASR9006":    {"eol": None, "eos": None},
    "ASR9010":    {"eol": None, "eos": None},

    # ── Cisco Nexus ──────────────────────────────────────────────────────────
    "N5K":        {"eol": "2022-07-31", "eos": "2019-07-31"},
    "N2K":        {"eol": "2022-01-31", "eos": "2019-01-31"},
    "N3K":        {"eol": None, "eos": None},
    "N9K":        {"eol": None, "eos": None},
    "N7K":        {"eol": "2025-07-31", "eos": "2022-07-31"},

    # ── Cisco ASA ────────────────────────────────────────────────────────────
    "ASA5505":    {"eol": "2019-08-31", "eos": "2016-08-31"},
    "ASA5506":    {"eol": "2022-09-30", "eos": "2019-09-30"},
    "ASA5508":    {"eol": "2022-09-30", "eos": "2019-09-30"},
    "ASA5516":    {"eol": "2022-09-30", "eos": "2019-09-30"},
    "ASA5510":    {"eol": "2017-08-31", "eos": "2014-08-31"},
    "ASA5512":    {"eol": "2020-09-30", "eos": "2017-09-30"},
    "ASA5515":    {"eol": "2020-09-30", "eos": "2017-09-30"},
    "ASA5520":    {"eol": "2017-08-31", "eos": "2014-08-31"},
    "ASA5525":    {"eol": "2020-09-30", "eos": "2017-09-30"},
    "ASA5545":    {"eol": "2020-09-30", "eos": "2017-09-30"},
    "ASA5585":    {"eol": "2025-09-30", "eos": "2022-09-30"},

    # ── Aruba / HP ProCurve ───────────────────────────────────────────────────
    "J9773A":     {"eol": "2023-09-30", "eos": "2020-09-30"},  # 2920-24G
    "J9727A":     {"eol": "2023-09-30", "eos": "2020-09-30"},  # 2920-24G-PoE+
    "J9728A":     {"eol": "2025-12-31", "eos": "2022-12-31"},  # 2530-24G
    "J9729A":     {"eol": "2025-12-31", "eos": "2022-12-31"},  # 2530-48G
    "J9781A":     {"eol": "2025-12-31", "eos": "2022-12-31"},  # 2530-8G
    "J9774A":     {"eol": "2023-09-30", "eos": "2020-09-30"},  # 2920-48G
    "J9775A":     {"eol": "2023-09-30", "eos": "2020-09-30"},  # 2920-24G-PoE+
    "J9850A":     {"eol": "2025-04-30", "eos": "2022-04-30"},  # 3810M-48G
    "J9851A":     {"eol": "2025-04-30", "eos": "2022-04-30"},  # 3810M-24G
    "J9584A":     {"eol": "2019-01-31", "eos": "2016-01-31"},  # 3500yl-24G

    # Aruba by normalised product name
    "ARUBA2530":  {"eol": "2025-12-31", "eos": "2022-12-31"},
    "ARUBA2920":  {"eol": "2023-09-30", "eos": "2020-09-30"},
    "ARUBA2930F": {"eol": None, "eos": None},
    "ARUBA2930M": {"eol": None, "eos": None},
    "ARUBA2930":  {"eol": None, "eos": None},
    "ARUBA3810":  {"eol": "2025-04-30", "eos": "2022-04-30"},
    "ARUBA6300":  {"eol": None, "eos": None},
    "ARUBA6400":  {"eol": None, "eos": None},
    "ARUBA8325":  {"eol": None, "eos": None},
    "ARUBA8360":  {"eol": None, "eos": None},

    # ── Ruijie ────────────────────────────────────────────────────────────────
    "RG-S2910":   {"eol": "2023-12-31", "eos": "2021-12-31"},
    "RGS2910":    {"eol": "2023-12-31", "eos": "2021-12-31"},
    "RG-S5750":   {"eol": None, "eos": None},
    "RGS5750":    {"eol": None, "eos": None},
    "RG-S6000":   {"eol": None, "eos": None},
    "RGS6000":    {"eol": None, "eos": None},
    # Ruijie Campus Series (CS83 / S6100 / S6150 / XS-S1960 — current gen)
    "CS83":       {"eol": None, "eos": None},
    "S615":       {"eol": None, "eos": None},  # S6150 backbone
    "S610":       {"eol": None, "eos": None},  # S6100 core
    "XSS1960":    {"eol": None, "eos": None},  # XS-S1960 aggregation
    "XSS1930":    {"eol": None, "eos": None},
    "RGS5300":    {"eol": None, "eos": None},
    "RGS6300":    {"eol": None, "eos": None},

    # ── Fortinet ─────────────────────────────────────────────────────────────
    "FG40F":      {"eol": None, "eos": None},
    "FG60F":      {"eol": None, "eos": None},
    "FG100F":     {"eol": None, "eos": None},
    "FG200F":     {"eol": None, "eos": None},
    "FG60E":      {"eol": "2025-01-31", "eos": "2023-01-31"},
    "FG100E":     {"eol": "2025-01-31", "eos": "2023-01-31"},
    "FG200E":     {"eol": "2025-01-31", "eos": "2023-01-31"},
    "FG300E":     {"eol": "2026-01-31", "eos": "2024-01-31"},

    # ── MikroTik (most are active) ────────────────────────────────────────────
    "CRS":        {"eol": None, "eos": None},
    "CCR":        {"eol": None, "eos": None},
    "RB":         {"eol": None, "eos": None},
}

# Regex aliases: pattern → key in _EOL_DB
# Used when model string is descriptive (e.g. "Cisco Catalyst 3850 48-port")
_ALIASES: list[tuple[re.Pattern, str]] = [
    # Cisco Catalyst series from descriptive names
    (re.compile(r"catalyst\s*2960\s*[lLxXcC]", re.I), "WSC2960X"),
    (re.compile(r"catalyst\s*2960", re.I),              "WSC2960"),
    (re.compile(r"catalyst\s*3560\s*cx", re.I),         "WSC3560CX"),
    (re.compile(r"catalyst\s*3560\s*[xX]", re.I),       "WSC3560X"),
    (re.compile(r"catalyst\s*3560", re.I),               "WSC3560"),
    (re.compile(r"catalyst\s*3650", re.I),               "WSC3650"),
    (re.compile(r"catalyst\s*3750\s*[xX]", re.I),       "WSC3750X"),
    (re.compile(r"catalyst\s*3750", re.I),               "WSC3750"),
    (re.compile(r"catalyst\s*3850", re.I),               "WSC3850"),
    (re.compile(r"catalyst\s*4500", re.I),               "WSC4500X"),
    (re.compile(r"catalyst\s*6500", re.I),               "WSC6500"),
    (re.compile(r"catalyst\s*92[0-9]{2}", re.I),         "C9200"),
    (re.compile(r"catalyst\s*93[0-9]{2}", re.I),         "C9300"),
    (re.compile(r"catalyst\s*94[0-9]{2}", re.I),         "C9400"),
    (re.compile(r"catalyst\s*95[0-9]{2}", re.I),         "C9500"),
    # ISR
    (re.compile(r"\bISR\s*43[0-9]{2}", re.I),            "ISR4321"),
    (re.compile(r"\bISR\s*44[0-9]{2}", re.I),            "ISR4431"),
    # Aruba
    (re.compile(r"aruba\s*2530", re.I),                  "ARUBA2530"),
    (re.compile(r"aruba\s*2920", re.I),                  "ARUBA2920"),
    (re.compile(r"aruba\s*2930", re.I),                  "ARUBA2930"),
    (re.compile(r"aruba\s*3810", re.I),                  "ARUBA3810"),
    (re.compile(r"aruba\s*6[34]00", re.I),               "ARUBA6300"),
    (re.compile(r"aruba\s*8[34][0-9]{2}", re.I),         "ARUBA8325"),
    # ProCurve / HP
    (re.compile(r"procurve\s*3500", re.I),               "J9584A"),
]


def _normalise(s: str) -> str:
    """Uppercase and strip all non-alphanumeric chars for prefix matching."""
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def lookup_eol(vendor: str, model: str) -> Optional[dict]:
    """Return { eol_date, eos_date, matched_model } or None if no match.

    eol_date / eos_date are date objects or None (= still active).
    """
    if not model or not model.strip():
        return None

    norm = _normalise(model)

    # 1. Prefix match against _EOL_DB (longest prefix wins)
    best_key: Optional[str] = None
    best_len = 0
    for key in _EOL_DB:
        k_norm = _normalise(key)
        if norm.startswith(k_norm) and len(k_norm) > best_len:
            best_key = key
            best_len = len(k_norm)

    if best_key:
        entry = _EOL_DB[best_key]
        return {
            "eol_date": date.fromisoformat(entry["eol"]) if entry.get("eol") else None,
            "eos_date": date.fromisoformat(entry["eos"]) if entry.get("eos") else None,
            "matched_model": best_key,
            "source": "local_db",
        }

    # 2. Regex alias fallback (descriptive model strings)
    for pattern, db_key in _ALIASES:
        if pattern.search(model):
            entry = _EOL_DB[db_key]
            return {
                "eol_date": date.fromisoformat(entry["eol"]) if entry.get("eol") else None,
                "eos_date": date.fromisoformat(entry["eos"]) if entry.get("eos") else None,
                "matched_model": db_key,
                "source": "alias_match",
            }

    return None
