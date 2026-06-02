"""Incident sprint Hotfix #2 — Agent WebSocket concurrent session race fix.

RCA: WS handler'ın `db: AsyncSession`'ı `_push_device_sync_task` ve
`_push_vault_task` arka plan task'larıyla paylaşılıyordu. SQLAlchemy AsyncSession
concurrent operation desteklemediği için heartbeat commit + push task SELECT
race condition'ı `InvalidRequestError: provisioning a new connection` exception'ı
üretiyor → WS handler düşüyor → agent flap.

Bu test suite hotfix sonrasını doğrular:
1. _push_device_sync_task `db` parametresi almıyor (kendi session açar)
2. _push_vault_task `db` parametresi almıyor (`agent_org_id` alıyor — INSERT'te org_id zorunlu)
3. Heartbeat handler nested try/except + log içeriyor
4. Disconnect finally bloğu nested try/except + log içeriyor
5. WS handler create_task çağrıları artık `db` parametresi geçirmiyor
"""
from __future__ import annotations

import inspect
from pathlib import Path


def test_push_device_sync_task_signature_no_db_param():
    """_push_device_sync_task artık `db` parametresi almamalı (kendi session açar)."""
    from app.api.v1.endpoints import agents as ag
    sig = inspect.signature(ag._push_device_sync_task)
    assert "db" not in sig.parameters, (
        f"_push_device_sync_task hâlâ `db` parametresi alıyor: {list(sig.parameters)}"
    )
    # agent_id zorunlu kalmalı
    assert "agent_id" in sig.parameters


def test_push_vault_task_signature_no_db_param_has_org_id():
    """_push_vault_task artık `db` parametresi almamalı.
    INSERT'te org_id zorunlu olduğu için `agent_org_id` parametresi olmalı."""
    from app.api.v1.endpoints import agents as ag
    sig = inspect.signature(ag._push_vault_task)
    assert "db" not in sig.parameters, (
        f"_push_vault_task hâlâ `db` parametresi alıyor: {list(sig.parameters)}"
    )
    assert "agent_id" in sig.parameters
    assert "agent_org_id" in sig.parameters, (
        "_push_vault_task INSERT'te organization_id türetmek için agent_org_id parametresi almalı"
    )


def test_heartbeat_handler_has_nested_defensive_rollback():
    """Heartbeat bloğunda nested try/except + log mesajı bulunmalı.
    Static source assertion (WS test client mock'lamak bu sprint scope dışı)."""
    from app.api.v1.endpoints import agents as ag
    src = Path(ag.__file__).read_text()
    assert "heartbeat commit failed" in src, (
        "Heartbeat commit fail log mesajı bulunamadı"
    )
    assert "heartbeat rollback failed" in src, (
        "Heartbeat rollback fail log mesajı bulunamadı"
    )


def test_disconnect_finally_has_log_not_silent_pass():
    """Disconnect finally bloğunda silent pass yerine warning log olmalı.
    Aksi halde agent.status='offline' yazılmazsa UI yanıltıcı."""
    from app.api.v1.endpoints import agents as ag
    src = Path(ag.__file__).read_text()
    assert "disconnect commit failed" in src, (
        "Disconnect commit fail log mesajı bulunamadı (silent pass kalmış olabilir)"
    )


def test_create_task_calls_no_longer_share_db_session():
    """WS handler create_task çağrıları artık `db` parametresi geçirmemeli.
    Source-level grep: `_push_device_sync_task(agent_id, db)` ve
    `_push_vault_task(agent_id, db)` pattern'leri kalmamalı."""
    from app.api.v1.endpoints import agents as ag
    src = Path(ag.__file__).read_text()
    # Eski hatalı pattern'ler kalmamalı
    assert "_push_device_sync_task(agent_id, db)" not in src, (
        "Hâlâ _push_device_sync_task(agent_id, db) çağrısı var — race condition geri geldi"
    )
    assert "_push_vault_task(agent_id, db)" not in src, (
        "Hâlâ _push_vault_task(agent_id, db) çağrısı var — race condition geri geldi"
    )
    # Yeni doğru pattern olmalı
    assert "_push_device_sync_task(agent_id)" in src
    assert "_push_vault_task(agent_id, agent.organization_id)" in src


def test_background_tasks_open_own_session_with_rls_bypass():
    """Background task fonksiyonlarında AsyncSessionLocal + SET app.is_super_admin pattern olmalı."""
    from app.api.v1.endpoints import agents as ag
    src = Path(ag.__file__).read_text()
    # Her iki task fonksiyonu da kendi session + RLS bypass içermeli
    # (lokal aramayı task fonksiyon gövdesi dışına çıkmasın diye basit string assertion)
    assert "AsyncSessionLocal()" in src
    assert "SET app.is_super_admin = 'on'" in src


def test_vault_task_writes_organization_id_on_insert():
    """_push_vault_task içinde AgentCredentialBundle INSERT'inde organization_id set edilmeli."""
    from app.api.v1.endpoints import agents as ag
    src = Path(ag.__file__).read_text()
    # AgentCredentialBundle constructor çağrısında organization_id kwarg olmalı
    assert "organization_id=agent_org_id" in src, (
        "AgentCredentialBundle INSERT'inde organization_id=agent_org_id bulunamadı (Faz 7 Phase 3d ihlali)"
    )
