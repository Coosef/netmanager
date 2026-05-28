"""T10 Faz B2a — DB permission audit (runtime user netmgr_app).

Amaç: runtime uygulama kullanıcısının (netmgr_app) gerçekten en-az-yetki
ile çalıştığını ve migration/superuser (netmgr) ile ayrıştığını DOĞRULAMAK.

Beklenenler:
  * netmgr_app: NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, LOGIN
  * netmgr_app: public şemada CREATE yetkisi YOK (DDL yapamaz), USAGE var
  * netmgr_app: uygulama tablolarında SELECT/INSERT/UPDATE/DELETE var
  * netmgr_app: hiçbir uygulama tablosunun sahibi DEĞİL (ALTER/DROP yapamaz)
  * RLS scoped tablolarda ENABLE + FORCE; netmgr_app bypass etmiyor
  * netmgr (migration/superuser): rolsuper=true (kontrast)

Güvenlik:
  * DESTRUCTIVE İŞLEM YOK. DDL "yapabilir mi?" testleri bir transaction
    içinde denenir ve KOŞULSUZ ROLLBACK edilir → hiçbir kalıcı nesne oluşmaz.
  * CRUD yetkisi has_table_privilege ile (katalog) kontrol edilir — gerçek
    INSERT/UPDATE/DELETE yazılmaz.

Çalıştırma (backend konteynerinde — env'de SYNC_DATABASE_URL=netmgr_app,
MIGRATION_DATABASE_URL=netmgr):
    docker compose exec -T backend python scripts/audit_db_permissions.py
    docker compose exec -T backend python scripts/audit_db_permissions.py --json

Çıkış kodu: tüm kontroller PASS ise 0, en az bir FAIL varsa 1.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

from sqlalchemy import create_engine, text


# Bağlantı URL'leri (env'den). netmgr_app = runtime; netmgr = migration/super.
APP_URL = os.environ.get("SYNC_DATABASE_URL", "")
MIG_URL = os.environ.get("MIGRATION_DATABASE_URL", "")

# RLS / CRUD örneklemesi için temsili scoped tablolar (Faz 7/8).
SAMPLE_SCOPED = [
    "devices", "alert_rules", "network_events", "incidents",
    "topology_links", "config_backups",
]


class Audit:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, name: str, expected, actual, ok: bool, note: str = "") -> None:
        self.checks.append({
            "check": name, "expected": expected, "actual": actual,
            "result": "PASS" if ok else "FAIL", "note": note,
        })

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if c["result"] == "FAIL"]


def _scalar(conn, sql: str, **params):
    return conn.execute(text(sql), params).scalar()


def audit_role_attributes(conn, a: Audit) -> None:
    """pg_roles: netmgr_app en-az-yetki; netmgr superuser (kontrast)."""
    row = conn.execute(text(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin "
        "FROM pg_roles WHERE rolname = 'netmgr_app'"
    )).first()
    if row is None:
        a.add("netmgr_app rolü mevcut", True, False, False, "rol bulunamadı!")
        return
    sup, byp, cdb, crole, login = row
    a.add("netmgr_app NOSUPERUSER", False, sup, sup is False)
    a.add("netmgr_app NOBYPASSRLS", False, byp, byp is False)
    a.add("netmgr_app NOCREATEDB", False, cdb, cdb is False)
    a.add("netmgr_app NOCREATEROLE", False, crole, crole is False)
    a.add("netmgr_app LOGIN", True, login, login is True)

    super_row = conn.execute(text(
        "SELECT rolsuper FROM pg_roles WHERE rolname = 'netmgr'"
    )).first()
    if super_row is not None:
        a.add("netmgr (migration) SUPERUSER", True, super_row[0], super_row[0] is True,
              "kontrast: migration/DDL bu rolle yapılır")


def audit_schema_db_privs(conn, a: Audit) -> None:
    """public şema + DB seviyesi: CREATE kapalı, USAGE açık."""
    db = _scalar(conn, "SELECT current_database()")
    usage = _scalar(conn, "SELECT has_schema_privilege('netmgr_app','public','USAGE')")
    create_sch = _scalar(conn, "SELECT has_schema_privilege('netmgr_app','public','CREATE')")
    create_db = _scalar(conn, "SELECT has_database_privilege('netmgr_app', :db, 'CREATE')", db=db)
    a.add("netmgr_app public USAGE", True, usage, usage is True)
    a.add("netmgr_app public CREATE kapalı", False, create_sch, create_sch is False,
          "CREATE yoksa CREATE TABLE/SCHEMA public'te yapılamaz")
    a.add("netmgr_app DB CREATE kapalı (şema yaratamaz)", False, create_db, create_db is False)


def audit_table_crud(conn, a: Audit) -> None:
    """Örnek scoped tablolarda CRUD yetkisi (katalog — yazma yapılmaz)."""
    for tbl in SAMPLE_SCOPED:
        exists = _scalar(conn, "SELECT to_regclass(:t) IS NOT NULL", t=f"public.{tbl}")
        if not exists:
            a.add(f"{tbl}: tablo mevcut", True, False, False, "tablo yok — örneklemden atla")
            continue
        privs = {}
        for p in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            privs[p] = _scalar(conn, "SELECT has_table_privilege('netmgr_app', :t, :p)",
                               t=f"public.{tbl}", p=p)
        ok = all(privs.values())
        a.add(f"{tbl}: netmgr_app CRUD (S/I/U/D)", "hepsi True", privs, ok)


def audit_ownership(conn, a: Audit) -> None:
    """netmgr_app hiçbir public tablosunun sahibi olmamalı (ALTER/DROP = ownership)."""
    owned = _scalar(conn,
        "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='netmgr_app'")
    total = _scalar(conn, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
    a.add("netmgr_app public tablo sahipliği = 0 (ALTER/DROP yapamaz)",
          0, owned, owned == 0, f"public'te toplam {total} tablo")


def audit_live_ddl_denied(conn, a: Audit) -> None:
    """CANLI: DDL denemeleri permission-denied olmalı. Her deneme bir
    transaction içinde, KOŞULSUZ ROLLBACK → kalıcı nesne oluşmaz."""
    stamp = datetime.now(timezone.utc).strftime("%H%M%S%f")
    attempts = [
        ("CREATE TABLE (public) reddediliyor", f'CREATE TABLE public._b2a_probe_{stamp} (id int)'),
        ("CREATE SCHEMA reddediliyor", f'CREATE SCHEMA _b2a_sch_{stamp}'),
    ]
    for name, ddl in attempts:
        trans = conn.begin_nested() if conn.in_transaction() else conn.begin()
        try:
            conn.execute(text(ddl))
            # Buraya geldiyse DDL BAŞARILI oldu (kötü) — geri al.
            trans.rollback()
            a.add(name, "permission denied", "ALLOWED", False,
                  "DDL başarılı oldu — rollback edildi ama yetki AÇIK (kötü)")
        except Exception as e:  # noqa: BLE001
            trans.rollback()
            msg = str(getattr(e, "orig", e)).lower()
            denied = "permission denied" in msg or "must be owner" in msg or "denied" in msg
            a.add(name, "permission denied", "DENIED" if denied else f"OTHER: {msg[:80]}",
                  denied)


def audit_live_crud_works(conn, a: Audit) -> None:
    """CANLI: temel okuma çalışmalı (bağlantı + SELECT yetkisi)."""
    one = _scalar(conn, "SELECT 1")
    a.add("netmgr_app SELECT 1 (bağlantı)", 1, one, one == 1)
    if _scalar(conn, "SELECT to_regclass('public.devices') IS NOT NULL"):
        # Sadece okuma — RLS context yoksa 0 satır görebilir; yetki testidir.
        try:
            _scalar(conn, "SELECT count(*) FROM devices")
            a.add("netmgr_app devices SELECT (okuma yetkisi)", "ok", "ok", True)
        except Exception as e:  # noqa: BLE001
            a.add("netmgr_app devices SELECT (okuma yetkisi)", "ok", str(e)[:80], False)


def audit_rls(conn, a: Audit) -> None:
    """RLS: scoped tablolarda ENABLE + FORCE; policy sayısı > 0."""
    rows = conn.execute(text("""
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
        ORDER BY c.relname
    """)).all()
    rls_enabled = [r[0] for r in rows]
    not_forced = [r[0] for r in rows if not r[2]]
    a.add("RLS-enabled tablo sayısı > 0", ">0", len(rls_enabled), len(rls_enabled) > 0)
    a.add("RLS-enabled tabloların hepsi FORCE", [], not_forced, len(not_forced) == 0,
          "FORCE olmayan = owner muafiyeti açığı" if not_forced else "hepsi FORCE")
    policies = _scalar(conn, "SELECT count(*) FROM pg_policies WHERE schemaname='public'")
    a.add("RLS policy sayısı > 0", ">0", policies, policies > 0)

    # Örnek scoped tabloların RLS+FORCE durumu (rapor için).
    sample = {}
    for tbl in SAMPLE_SCOPED:
        r = conn.execute(text(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE oid = to_regclass(:t)"), {"t": f"public.{tbl}"}).first()
        sample[tbl] = None if r is None else {"enabled": r[0], "force": r[1]}
    a.add("Örnek scoped tablolar RLS+FORCE", "enabled+force", sample,
          all(v and v["enabled"] and v["force"] for v in sample.values() if v is not None))


def run() -> dict:
    if not APP_URL:
        print("HATA: SYNC_DATABASE_URL (netmgr_app) env'de yok.", file=sys.stderr)
        sys.exit(2)

    a = Audit()
    engine = create_engine(APP_URL, poolclass=__import__("sqlalchemy").pool.NullPool)
    with engine.connect() as conn:
        # netmgr_app ile bağlanıldığını teyit et.
        whoami = _scalar(conn, "SELECT current_user")
        a.add("Bağlanan kullanıcı = netmgr_app", "netmgr_app", whoami, whoami == "netmgr_app",
              "runtime kullanıcısı olarak audit")
        audit_role_attributes(conn, a)
        audit_schema_db_privs(conn, a)
        audit_table_crud(conn, a)
        audit_ownership(conn, a)
        audit_live_crud_works(conn, a)
        audit_live_ddl_denied(conn, a)
        audit_rls(conn, a)
    engine.dispose()

    return {
        "audit": "T10 B2a — DB permission (netmgr_app runtime user)",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "connected_user": whoami,
        "total": len(a.checks),
        "passed": len(a.checks) - len(a.failed),
        "failed": len(a.failed),
        "verdict": "GO" if not a.failed else "NO-GO",
        "checks": a.checks,
    }


def main() -> None:
    as_json = "--json" in sys.argv
    report = run()
    if as_json:
        print(json.dumps(report, default=str, ensure_ascii=False, indent=2))
    else:
        print(f"\n=== {report['audit']} ===")
        print(f"Kullanıcı: {report['connected_user']} | {report['timestamp']}")
        print(f"{'-'*72}")
        for c in report["checks"]:
            mark = "✓" if c["result"] == "PASS" else "✗"
            print(f"  [{mark}] {c['check']}")
            print(f"       beklenen={c['expected']!r} gerçek={c['actual']!r}"
                  + (f"  — {c['note']}" if c["note"] else ""))
        print(f"{'-'*72}")
        print(f"TOPLAM {report['total']} | PASS {report['passed']} | "
              f"FAIL {report['failed']} → {report['verdict']}")
    sys.exit(0 if report["failed"] == 0 else 1)


if __name__ == "__main__":
    main()
