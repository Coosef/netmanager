"""
ParserEngine — central parse dispatcher.

Parse chain for a given raw output:
  1. DB template (regex / textfsm / raw)
  2. ntc-templates fallback (if ntc_templates installed and platform known)
  3. raw passthrough

ntc-templates platform mapping uses community conventions:
  cisco_ios       → cisco_ios
  cisco_nxos      → cisco_nxos
  aruba_aoscx     → hp_aruba_aoscx_cx
  aruba_osswitch  → hp_procurve
  hp_procurve     → hp_procurve
  junos           → juniper_junos
  mikrotik_routeros → mikrotik_routeros
"""
import io
import json
import re
from typing import Any

# ntc-templates command name mapping
# key = our command_type, value = CLI string ntc-templates expects
_NTC_COMMAND_MAP: dict[str, str] = {
    "show_version":        "show version",
    "show_interfaces":     "show interfaces",
    "show_vlan":           "show vlan",
    "show_lldp":           "show lldp neighbors detail",
    "show_cdp":            "show cdp neighbors detail",
    "show_mac_table":      "show mac address-table",
    "show_arp":            "show arp",
    "show_running_config": "show running-config",
    "show_power_inline":   "show power inline",
    "show_switchport":     "show interfaces switchport",
}

# Our os_type → ntc-templates platform name
_NTC_PLATFORM_MAP: dict[str, str] = {
    "cisco_ios":          "cisco_ios",
    "cisco_nxos":         "cisco_nxos",
    "aruba_aoscx":        "hp_aruba_aoscx_cx",
    "aruba_osswitch":     "hp_procurve",
    "hp_procurve":        "hp_procurve",
    "junos":              "juniper_junos",
    "mikrotik_routeros":  "mikrotik_routeros",
    "fortios":            "fortinet_fortios",
}


class ParseResult:
    __slots__ = ("success", "data", "source", "error")

    def __init__(
        self,
        success: bool,
        data: Any = None,
        source: str = "raw",
        error: str | None = None,
    ):
        self.success = success
        self.data = data
        self.source = source
        self.error = error

    def to_dict(self) -> dict:
        return {"success": self.success, "data": self.data, "source": self.source, "error": self.error}


class ParserEngine:

    # ---------------------------------------------------------------------------
    # Public
    # ---------------------------------------------------------------------------

    def parse(
        self,
        raw_output: str,
        parser_type: str,
        parser_template: str | None,
        *,
        os_type: str | None = None,
        command_type: str | None = None,
    ) -> ParseResult:
        """
        Parse raw_output using the given strategy.
        Falls back to ntc-templates when parser_type is 'raw' and
        os_type + command_type are provided.
        """
        try:
            if parser_type == "regex" and parser_template:
                return self._parse_regex(parser_template, raw_output)
            elif parser_type == "textfsm" and parser_template:
                return self._parse_textfsm(parser_template, raw_output)
            elif parser_type == "raw":
                # Try ntc-templates first as an upgrade
                if os_type and command_type:
                    ntc = self._try_ntc(os_type, command_type, raw_output)
                    if ntc is not None:
                        return ParseResult(success=True, data=ntc, source="ntc_templates")
                return ParseResult(success=True, data=raw_output, source="raw")
            else:
                return ParseResult(success=False, error=f"Unknown parser type: {parser_type}")
        except Exception as exc:
            return ParseResult(success=False, error=str(exc))

    def parse_with_json(
        self,
        raw_output: str,
        parser_type: str,
        parser_template: str | None,
        *,
        os_type: str | None = None,
        command_type: str | None = None,
    ) -> tuple[bool, Any, str | None]:
        """Convenience wrapper → (success, parsed_data, error)."""
        result = self.parse(
            raw_output, parser_type, parser_template,
            os_type=os_type, command_type=command_type,
        )
        return result.success, result.data, result.error

    # ---------------------------------------------------------------------------
    # Regex
    # ---------------------------------------------------------------------------

    def _parse_regex(self, pattern: str, text: str) -> ParseResult:
        try:
            compiled = re.compile(pattern, re.MULTILINE | re.IGNORECASE)
        except re.error as exc:
            return ParseResult(success=False, error=f"Invalid regex: {exc}")
        results = []
        for m in compiled.finditer(text):
            results.append(m.groupdict() if m.groupdict() else list(m.groups()))
        if not results:
            return ParseResult(success=False, error="Regex matched 0 rows", source="regex")
        return ParseResult(success=True, data=results, source="regex")

    # ---------------------------------------------------------------------------
    # TextFSM
    # ---------------------------------------------------------------------------

    def _parse_textfsm(self, template_body: str, text: str) -> ParseResult:
        try:
            import textfsm
        except ImportError:
            return ParseResult(success=False, error="textfsm package not installed")
        try:
            fsm = textfsm.TextFSM(io.StringIO(template_body))
            headers = fsm.header
            rows = fsm.ParseText(text)
            data = [dict(zip(headers, row)) for row in rows]
            if not data:
                return ParseResult(success=False, error="TextFSM parsed 0 rows", source="textfsm")
            return ParseResult(success=True, data=data, source="textfsm")
        except Exception as exc:
            return ParseResult(success=False, error=str(exc), source="textfsm")

    # ---------------------------------------------------------------------------
    # ntc-templates fallback
    # ---------------------------------------------------------------------------

    def _try_ntc(
        self, os_type: str, command_type: str, raw_output: str
    ) -> list | None:
        platform = _NTC_PLATFORM_MAP.get(os_type)
        command = _NTC_COMMAND_MAP.get(command_type)
        if not platform or not command:
            return None
        try:
            from ntc_templates.parse import parse_output  # type: ignore
            result = parse_output(platform=platform, command=command, data=raw_output)
            # parse_output returns [] on no match — treat as miss
            return result if result else None
        except Exception:
            return None

    # ---------------------------------------------------------------------------
    # Serialise parsed data to store in DB (JSON string)
    # ---------------------------------------------------------------------------

    @staticmethod
    def serialise(data: Any) -> str | None:
        if data is None:
            return None
        if isinstance(data, str):
            return data  # raw passthrough
        try:
            return json.dumps(data, ensure_ascii=False, default=str)
        except Exception:
            return str(data)


# Module-level singleton
parser_engine = ParserEngine()
