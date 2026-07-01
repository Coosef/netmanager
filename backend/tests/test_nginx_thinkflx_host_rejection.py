"""Regression pins for the accidental-host-exposure fix
(fix/nginx-reject-unauthorized-hosts).

`www.thinkflx.com` DNS was pointing directly to the NetManager VPS IP
but no vhost/upstream/container was defined for it, so the outer
docker nginx `server_name _;` catch-all was silently serving the
NetManager frontend HTML to that host. This fix inserts an
exact-server_name deny block (returning 444 — nginx closes the
connection without a response) BEFORE the catch-all so `thinkflx.com`
and `www.thinkflx.com` requests never reach the NetManager upstream.

These tests pin the intentional shape of the fix so a future refactor
cannot silently:
  * remove the deny block,
  * move it BELOW the catch-all (nginx matches on longest-specific
    first, so the deny block MUST be present but position pins the
    author's intent),
  * accidentally add deny rules for authorized hosts
    (netmanager.systrack.app / ws.systrack.app),
  * break the backend + frontend upstream routing.
"""
from __future__ import annotations

from pathlib import Path

_NGINX_CONF = (
    Path(__file__).resolve().parent.parent.parent / "nginx" / "nginx.conf"
)


def _read_conf() -> str:
    return _NGINX_CONF.read_text(encoding="utf-8")


# ─── deny block content pins ──────────────────────────────────────────────


def test_deny_server_name_line_present():
    """The deny block MUST list the exact two hostnames on a single
    server_name directive so nginx matches them by exact string."""
    assert "server_name thinkflx.com www.thinkflx.com;" in _read_conf(), (
        "exact-host deny server_name missing — the fix has been "
        "unwound or the hostnames drifted"
    )


def test_return_444_directive_present():
    """`return 444` (nginx closes without a response) must appear at
    least once in the config. This is the fingerprint of the deny
    block; before the fix landed, no `return 444` existed anywhere."""
    assert "return 444;" in _read_conf(), (
        "return 444; missing — the deny block was removed or replaced"
    )


# ─── position pins ────────────────────────────────────────────────────────


def test_deny_block_precedes_catch_all():
    """The deny block MUST appear BEFORE the `server_name _;` catch-all
    in the source. nginx does not depend on source order for exact-name
    matching, but source order pins the author's intent — a future
    edit that inverts the order signals a semantic change that
    reviewers should catch."""
    src = _read_conf()
    deny_idx = src.find("server_name thinkflx.com www.thinkflx.com;")
    catch_idx = src.find("server_name _;")
    assert deny_idx != -1, "deny server_name not found"
    assert catch_idx != -1, "catch-all server_name _ missing — do not remove"
    assert deny_idx < catch_idx, (
        f"deny block must precede the catch-all in source order "
        f"(deny at {deny_idx}, catch-all at {catch_idx})"
    )


def test_catch_all_still_present():
    """The NetManager catch-all `server_name _;` MUST still exist —
    it serves the authorized hosts (netmanager.systrack.app,
    ws.systrack.app) that reach the docker outer nginx via host-level
    nginx / Cloudflare fronting. Removing it breaks both."""
    src = _read_conf()
    # Exactly one catch-all block.
    assert src.count("server_name _;") == 1, (
        "expected exactly one `server_name _;` catch-all block; "
        "found more or fewer — routing is unstable"
    )


# ─── negative pins — the fix stays surgical ───────────────────────────────


def test_no_new_deny_rule_for_netmanager_or_ws_hosts():
    """The fix MUST NOT deny netmanager.systrack.app or
    ws.systrack.app. Both are authorized hosts routed via the
    catch-all + host-level nginx / Cloudflare. A deny rule for either
    would black-hole live production traffic."""
    src = _read_conf()
    # Neither name should appear in a server_name directive.
    assert "server_name netmanager.systrack.app" not in src, (
        "netmanager.systrack.app must not have an explicit server_name "
        "in this fix"
    )
    assert "server_name ws.systrack.app" not in src, (
        "ws.systrack.app must not have an explicit server_name in this fix"
    )
    # And they must not appear as tokens in a deny/reject/444 comment
    # region. Simple scan: no `return 444` line within 5 lines of
    # either host name mention.
    lines = src.splitlines()
    for idx, line in enumerate(lines):
        if "netmanager.systrack.app" in line or "ws.systrack.app" in line:
            window = "\n".join(lines[max(0, idx - 2): idx + 3])
            assert "return 444" not in window, (
                f"authorized host referenced within 5 lines of a "
                f"`return 444` — potential accidental deny near line {idx + 1}"
            )


def test_backend_and_frontend_upstreams_unchanged():
    """The fix touches ONLY the deny block; the backend + frontend
    upstream `set $... "http://...";` lines and the /api + / location
    blocks must remain untouched. Regression pin against a rebase
    that accidentally drops or edits them."""
    src = _read_conf()
    assert 'set $backend  "http://backend:8000";' in src, (
        "backend upstream declaration removed"
    )
    assert 'set $frontend "http://frontend:3000";' in src, (
        "frontend upstream declaration removed"
    )


def test_websocket_locations_unchanged():
    """The two WebSocket location blocks (/api/v1/ws + /api/v1/agents/ws)
    must survive verbatim — agents + browsers depend on them."""
    src = _read_conf()
    assert "location /api/v1/ws {" in src
    assert "location /api/v1/agents/ws {" in src


def test_deny_block_uses_exact_hosts_not_wildcard():
    """server_name must list the two exact hostnames — no wildcard
    (`*.thinkflx.com`) or regex, so an unrelated sibling like
    `mail.thinkflx.com` (should it ever exist) is NOT swept up
    without an explicit review."""
    src = _read_conf()
    # Reject any wildcard on the deny line
    assert "server_name *.thinkflx.com" not in src, (
        "wildcard on deny server_name is too broad; use exact hosts"
    )
    # Reject a regex form too
    assert "server_name ~thinkflx" not in src, (
        "regex on deny server_name is too broad; use exact hosts"
    )
