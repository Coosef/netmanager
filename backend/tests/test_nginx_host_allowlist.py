"""Regression pins for the host allowlist + rejection page rewrite
(fix/nginx-host-allowlist-and-mount).

Replaces the earlier PR-#131 `test_nginx_thinkflx_host_rejection.py`
suite — that PR shipped an exact-host `return 444` rule for
thinkflx.com + www.thinkflx.com, but the accidental-exposure surface
is bigger than one domain (direct-IP access, misconfigured DNS on any
future domain that resolves here, empty Host on HTTP/1.0). This PR
switches to a generic allowlist:

  * ONLY `netmanager.systrack.app` and `ws.systrack.app` reach the
    NetManager frontend / API / WebSocket upstreams,
  * every other Host header (including thinkflx.com, direct-IP,
    unknown domains) lands on the `default_server` rejection block
    and receives an informative bilingual 421 HTML page.

These tests pin the shape of that fix so a future refactor cannot
silently:
  * add a proxy_pass or a NetManager location block into the
    rejection server (would leak data),
  * shrink or widen the allowlist without a matching test edit,
  * regress the required rejection page fingerprints (status 421,
    bilingual copy, no-store cache, self-contained HTML with no
    external asset dependency),
  * break the WebSocket / API / health / SPA routing inside the
    authorized server block,
  * bring back the removed PR-#131 `return 444` rule (which would
    conflict semantically with the uniform 421 policy adopted here).
"""
from __future__ import annotations

import re
from pathlib import Path

_NGINX_CONF = (
    Path(__file__).resolve().parent.parent.parent / "nginx" / "nginx.conf"
)


def _read_conf() -> str:
    return _NGINX_CONF.read_text(encoding="utf-8")


# ══════════════════════════════════════════════════════════════════════
#  Allowlist pins — ONLY the two authorized hosts, no more, no less.
# ══════════════════════════════════════════════════════════════════════


def test_authorized_allowlist_hostnames_exact():
    """The `server_name` directive for the NetManager block MUST list
    exactly these two hostnames in this order. A future edit adding
    a third host — even a legitimate one — must also update this
    test so reviewers see the widening explicitly."""
    src = _read_conf()
    assert (
        "server_name netmanager.systrack.app ws.systrack.app;" in src
    ), (
        "authorized server_name must list exactly "
        "`netmanager.systrack.app ws.systrack.app` (in this order)"
    )


def test_no_other_authorized_hostname_appears():
    """No other host may show up on any non-rejection `server_name`
    directive. Guards against a rebase that quietly adds e.g.
    `admin.systrack.app` to the allowlist without a test update."""
    src = _read_conf()
    matches = re.findall(r"^\s*server_name\s+([^;]+);", src, flags=re.MULTILINE)
    # Two expected: the rejection catch-all `_` and the authorized pair.
    assert len(matches) == 2, (
        f"expected exactly 2 `server_name` directives (rejection + "
        f"authorized); found {len(matches)}: {matches}"
    )
    rejection, authorized = matches[0].strip(), matches[1].strip()
    assert rejection == "_", (
        f"first server_name must be `_` (catch-all rejection); got `{rejection}`"
    )
    assert authorized == "netmanager.systrack.app ws.systrack.app", (
        f"authorized server_name must be exactly "
        f"`netmanager.systrack.app ws.systrack.app`; got `{authorized}`"
    )


# ══════════════════════════════════════════════════════════════════════
#  Default rejection server pins.
# ══════════════════════════════════════════════════════════════════════


def _rejection_block_source() -> str:
    """Slice the source between the first `server {` (the rejection
    block) and the second `server {` (the authorized NetManager
    block). The tests below operate on this slice so a rejection-block
    assertion cannot accidentally succeed by matching a string in the
    authorized block."""
    src = _read_conf()
    first = src.find("server {")
    assert first != -1, "no server block found in nginx.conf"
    second = src.find("server {", first + 1)
    assert second != -1, "expected a second server block (authorized)"
    return src[first:second]


def test_rejection_server_uses_default_server_on_both_families():
    block = _rejection_block_source()
    assert "listen 80 default_server;" in block
    assert "listen [::]:80 default_server;" in block


def test_rejection_server_name_is_catch_all_underscore():
    block = _rejection_block_source()
    assert "server_name _;" in block


def test_rejection_server_returns_421():
    block = _rejection_block_source()
    assert "return 421" in block, (
        "rejection block MUST return 421 Misdirected Request"
    )
    # Guard against accidental status drift back to 444 (the removed
    # PR-#131 behavior) or a permissive 200.
    assert "return 200" not in block
    assert "return 444" not in block


def test_rejection_page_has_turkish_and_english_copy():
    block = _rejection_block_source()
    # Required Turkish phrases (from operator brief).
    assert "Bu alan adı NetManager için yetkili değildir." in block
    assert "Domain veya DNS yönlendirmesi hatalı görünüyor." in block
    assert "Lütfen domain yöneticinizle iletişime geçin" in block
    # Required English phrases.
    assert "Unauthorized domain" in block
    assert "This domain is not authorized for NetManager." in block
    assert "Please contact your domain administrator" in block


def test_rejection_page_headers_pin_content_type_and_no_store():
    block = _rejection_block_source()
    assert "default_type text/html;" in block
    assert "charset utf-8;" in block
    assert 'add_header X-Content-Type-Options "nosniff" always;' in block
    assert 'add_header Cache-Control "no-store" always;' in block


def test_rejection_server_has_no_proxy_pass():
    """The rejection block MUST NOT proxy anything anywhere — the whole
    point is to prevent unauthorized hosts from reaching NetManager
    upstreams."""
    block = _rejection_block_source()
    assert "proxy_pass" not in block, (
        "rejection server must never proxy_pass — it would leak"
    )


def test_rejection_server_has_no_location_blocks():
    """No location blocks allowed in the rejection server. All
    unauthorized traffic is answered by the top-level `return 421`
    regardless of URI. A stray `location /api { ... }` here would
    silently bypass the deny."""
    block = _rejection_block_source()
    # location can legitimately appear as a keyword in the returned
    # HTML body; guard on the directive form `location <path> {`.
    directive = re.search(
        r"^\s*location\s+[^\s{]+\s*\{", block, flags=re.MULTILINE
    )
    assert directive is None, (
        f"rejection server must not declare any location block; "
        f"found: {directive.group(0) if directive else ''}"
    )


def test_rejection_server_has_no_upstream_reference():
    """No `set $backend / $frontend` variable assignments and no
    references to backend:8000 / frontend:3000 inside the rejection
    block."""
    block = _rejection_block_source()
    assert "set $backend" not in block
    assert "set $frontend" not in block
    assert "backend:8000" not in block
    assert "frontend:3000" not in block


def test_rejection_page_contains_dynamic_host_placeholder():
    """The rejection page must echo `$host` (the requested Host header)
    so a misconfigured admin can see the domain they hit."""
    block = _rejection_block_source()
    assert "$host" in block, (
        "rejection page should echo `$host` for operator diagnostics"
    )


# ══════════════════════════════════════════════════════════════════════
#  Authorized server pins — every existing route must survive.
# ══════════════════════════════════════════════════════════════════════


def _authorized_block_source() -> str:
    """Everything from the second `server {` to end-of-file."""
    src = _read_conf()
    first = src.find("server {")
    second = src.find("server {", first + 1)
    return src[second:]


def test_authorized_server_has_backend_and_frontend_upstreams():
    block = _authorized_block_source()
    assert 'set $backend  "http://backend:8000";' in block
    assert 'set $frontend "http://frontend:3000";' in block


def test_authorized_server_preserves_api_location():
    block = _authorized_block_source()
    assert "location /api {" in block


def test_authorized_server_preserves_websocket_locations():
    block = _authorized_block_source()
    assert "location /api/v1/ws {" in block
    assert "location /api/v1/agents/ws {" in block


def test_authorized_server_preserves_health_location():
    block = _authorized_block_source()
    assert "location /health {" in block


def test_authorized_server_preserves_root_frontend_location():
    block = _authorized_block_source()
    assert re.search(
        r"location\s+/\s*\{[\s\S]{0,300}proxy_pass\s+\$frontend;",
        block,
    ), "root location must proxy_pass to $frontend"


def test_websocket_upgrade_and_timeout_headers_preserved():
    block = _authorized_block_source()
    # `proxy_read_timeout 3600s;` appears in both /api/v1/ws and
    # /api/v1/agents/ws blocks; count must be at least 2.
    assert block.count("proxy_read_timeout    3600s;") >= 2, (
        "WebSocket 1h read timeout regressed"
    )
    assert block.count('proxy_set_header   Upgrade    $http_upgrade;') >= 2
    assert block.count('proxy_set_header   Connection "upgrade";') >= 2


def test_authorized_server_preserves_https_redirect():
    block = _authorized_block_source()
    assert 'if ($http_x_forwarded_proto = "http") {' in block
    assert "return 308 https://$host$request_uri;" in block


def test_authorized_server_preserves_vite_dev_path_404s():
    block = _authorized_block_source()
    assert 'location ~ ^/@(vite|fs|react-refresh|id|vite/client) { return 404; }' in block
    assert 'location ~ ^/src/                                    { return 404; }' in block
    assert 'location ~ ^/node_modules/                           { return 404; }' in block
    assert 'location = /__open-in-editor                         { return 404; }' in block


def test_authorized_server_preserves_security_headers():
    block = _authorized_block_source()
    assert (
        'add_header Strict-Transport-Security "max-age=63072000; '
        'includeSubDomains; preload" always;' in block
    )
    assert 'add_header X-Content-Type-Options    "nosniff"' in block
    assert 'add_header X-Frame-Options           "SAMEORIGIN"' in block
    assert 'add_header Referrer-Policy           "strict-origin-when-cross-origin"' in block
    assert 'add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()"' in block


# ══════════════════════════════════════════════════════════════════════
#  Anti-regression: the PR-#131 exact-thinkflx block must be GONE.
# ══════════════════════════════════════════════════════════════════════


def test_no_exact_thinkflx_deny_block():
    """PR #131 shipped `server_name thinkflx.com www.thinkflx.com;
    return 444;` as a targeted fix. That block is superseded by the
    generic default_server rejection here and MUST NOT come back — a
    future rebase that re-adds it would create a 444 (silent close) vs
    421 (informative HTML) inconsistency for the same host."""
    src = _read_conf()
    assert "server_name thinkflx.com" not in src, (
        "PR #131 exact-thinkflx server_name block must be removed; "
        "the generic default_server rejection covers it"
    )
    assert "return 444;" not in src, (
        "return 444 (silent close) removed in favour of return 421 "
        "(informative bilingual HTML rejection page)"
    )


# ══════════════════════════════════════════════════════════════════════
#  End-to-end shape pin.
# ══════════════════════════════════════════════════════════════════════


def test_exactly_two_server_blocks():
    src = _read_conf()
    starts = [m.start() for m in re.finditer(r"^\s*server\s*\{", src, flags=re.MULTILINE)]
    assert len(starts) == 2, (
        f"expected exactly 2 server blocks (rejection + authorized); "
        f"found {len(starts)}"
    )


def test_rejection_block_precedes_authorized_block():
    """Ordering pin — nginx picks by explicit name > wildcard, so
    functionally the order doesn't matter, but reviewers read
    top-to-bottom. Reject-first shows intent."""
    src = _read_conf()
    reject_idx = src.find("server_name _;")
    auth_idx = src.find("server_name netmanager.systrack.app")
    assert reject_idx != -1 and auth_idx != -1
    assert reject_idx < auth_idx, (
        "rejection server_name should precede the authorized block"
    )
