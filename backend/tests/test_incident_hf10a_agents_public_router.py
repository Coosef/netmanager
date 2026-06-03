"""Incident sprint Hotfix #10A — Agent installer download public router.

RCA: /api/v1/agents/{id}/download/{platform} ve /agents/download/script
endpoint'leri X-Agent-Key header auth kullanır ama T10 Faz A1'de
agents.router'a _feat("agents") (→ Depends(get_current_active_user))
eklendiğinden Bearer token şart olmuş — installer machine'in user session'ı
yok, public-credential auth endpoint koduna gelmeden 401 "Not authenticated"
dönüyor.

Fix: Yeni agents_public_router (gate'siz) + 2 endpoint decorator taşıma.
Admin endpoint'leri (24 adet) router'da, _feat("agents") gate'inde kalır.

Source assertion + signature smoke (W3.1/HF#1/HF#2 paterni).
"""
from __future__ import annotations

from pathlib import Path


def _src() -> str:
    from app.api.v1.endpoints import agents as ag
    return Path(ag.__file__).read_text()


def _router_src() -> str:
    from app.api.v1 import router as r
    return Path(r.__file__).read_text()


def test_agents_public_router_defined():
    """agents.py içinde agents_public_router = APIRouter() tanımlı olmalı."""
    from app.api.v1.endpoints import agents as ag
    from fastapi import APIRouter
    assert hasattr(ag, "agents_public_router"), (
        "agents.agents_public_router tanımlı değil — HF#10A fix uygulanmamış"
    )
    assert isinstance(ag.agents_public_router, APIRouter), (
        "agents_public_router APIRouter instance değil"
    )


def test_download_installer_uses_public_router():
    """download_installer decorator'ı @agents_public_router.get olmalı."""
    src = _src()
    assert '@agents_public_router.get("/{agent_id}/download/{platform}")' in src, (
        "download_installer hâlâ admin router'da — public router'a taşınmamış"
    )
    # Eski admin decorator pattern'i KALMAMALI
    assert '@router.get("/{agent_id}/download/{platform}")' not in src, (
        "Eski admin router decorator'ı korunmuş — installer hâlâ Bearer istiyor"
    )


def test_download_script_uses_public_router():
    """download_agent_script decorator'ı @agents_public_router.get olmalı."""
    src = _src()
    assert '@agents_public_router.get("/download/script")' in src, (
        "download_agent_script public router'a taşınmamış"
    )
    assert '@router.get("/download/script")' not in src, (
        "Eski admin router decorator'ı korunmuş — script download hâlâ Bearer istiyor"
    )


def test_admin_endpoints_remain_on_admin_router():
    """24 admin endpoint hâlâ @router decorator'ında olmalı (yanlışlıkla
    public router'a taşıma regression korumacı)."""
    src = _src()
    # Birkaç kritik admin endpoint sample
    admin_decorators = [
        '@router.get("/", response_model=list[dict])',     # list agents
        '@router.post("/{agent_id}/restart"',                # restart
        '@router.post("/{agent_id}/rotate-key"',             # key rotate
        '@router.get("/latency-map"',                        # telemetry
        '@router.post("/{agent_id}/probe-devices"',          # probe
        '@router.post("/{agent_id}/snmp-walk"',              # snmp
    ]
    for d in admin_decorators:
        assert d in src, f"Admin decorator kayıp / yanlış taşıma: {d!r}"
        # Aynı path public router'a taşınmamalı
        public_eq = d.replace("@router.", "@agents_public_router.")
        assert public_eq not in src, (
            f"Admin endpoint yanlışlıkla public router'a taşınmış: {public_eq!r}"
        )


def test_router_includes_public_router_without_dependency():
    """router.py'de agents_public_router include edilirken dependencies
    parametresi YA hiç YOK YA da boş — Bearer gate uygulanmamalı."""
    src = _router_src()
    # Public router include satırı bulunmalı
    assert "agents.agents_public_router" in src, (
        "router.py'de agents_public_router include edilmemiş"
    )
    # İlgili satırı bul (multi-line basitleştirilmiş — istisna sıralı arama)
    lines = src.splitlines()
    public_include_line = None
    for i, line in enumerate(lines):
        if "agents.agents_public_router" in line:
            # include satırının kendisi veya komşu (multi-line include destekli)
            block = " ".join(lines[max(0, i - 1):i + 3])
            public_include_line = block
            break
    assert public_include_line is not None
    # _feat("agents") veya require_feature içeren dependency olmamalı
    assert "_feat(\"agents\")" not in public_include_line, (
        "Public installer router'a _feat gate uygulanmış — fix amacını ihlal"
    )
    assert "require_feature" not in public_include_line


def test_router_admin_include_still_feature_gated():
    """Regression: agents.router include'unda _feat("agents") KORUNMUŞ olmalı."""
    src = _router_src()
    # Admin router include satırı
    assert (
        'api_router.include_router(agents.router, prefix="/agents", '
        'tags=["Agents"], dependencies=_feat("agents"))'
    ) in src, "Admin agents.router include'undan _feat gate kaldırılmış — security regression"


def test_public_router_endpoints_in_openapi():
    """App startup sonrası OpenAPI'de iki installer path mevcut + admin path'ler
    de korunmuş olmalı."""
    from app.main import app
    paths = set(app.openapi().get("paths", {}).keys())
    # Public installer endpoint'leri
    assert "/api/v1/agents/{agent_id}/download/{platform}" in paths, (
        "Installer download endpoint OpenAPI'de yok"
    )
    assert "/api/v1/agents/download/script" in paths, (
        "Agent script download endpoint OpenAPI'de yok"
    )
    # Admin endpoint sample (regression)
    assert "/api/v1/agents/" in paths
    assert "/api/v1/agents/latency-map" in paths
