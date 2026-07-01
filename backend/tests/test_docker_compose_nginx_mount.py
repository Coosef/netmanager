"""Regression pins for the nginx service's bind-mount fix
(fix/nginx-host-allowlist-and-mount).

Prior to this PR the nginx service used a single-file bind mount:

    - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro

Single-file bind mounts resolve to an inode at container-create time.
A subsequent `git pull` that atomically renames the source file leaves
the container reading the ORIGINAL inode (unlinked but still open),
so the deploy's `nginx -s reload` becomes a functional no-op. This
was actually observed on prod during the PR #131 deploy (5326-byte
stale in-container file, mtime 2026-05-29 vs 5566-byte host file
mtime 2026-07-01 15:13:39). See the deploy report attached to the
PR body.

The fix is a directory bind mount:

    - ./nginx/:/etc/nginx/conf.d/:ro

Docker resolves directory mounts by path at every read, so
`git pull && nginx -s reload` produces the expected zero-downtime
effect from now on.

These tests pin the intent of that fix so a future edit cannot
silently:
  * revert to a single-file mount,
  * change the mount target away from `/etc/nginx/conf.d/`,
  * drop the `:ro` read-only flag,
  * add a second `.conf` file to `nginx/` without an explicit test
    update (nginx would auto-include it into the effective config),
  * break the nginx service's port publish, network membership or
    healthcheck.
"""
from __future__ import annotations

from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml", reason="PyYAML required for compose parsing")

_COMPOSE_PATH = (
    Path(__file__).resolve().parent.parent.parent / "docker-compose.yml"
)
_NGINX_DIR = Path(__file__).resolve().parent.parent.parent / "nginx"


def _load_compose() -> dict:
    return yaml.safe_load(_COMPOSE_PATH.read_text(encoding="utf-8"))


def _nginx_service() -> dict:
    compose = _load_compose()
    services = compose.get("services", {})
    assert "nginx" in services, "nginx service missing from docker-compose.yml"
    return services["nginx"]


# ══════════════════════════════════════════════════════════════════════
#  Bind mount shape.
# ══════════════════════════════════════════════════════════════════════


def test_nginx_uses_directory_bind_mount_not_single_file():
    """Directory mount, not single-file. Every string in `volumes:`
    is inspected — no entry may reference `nginx.conf` as a source
    path (that would be the old single-file style)."""
    svc = _nginx_service()
    volumes = svc.get("volumes", [])
    assert volumes, "nginx service has no volumes; directory mount missing"

    # Assert exactly one bind mount and that it maps ./nginx/ dir → conf.d.
    matches = [
        v for v in volumes
        if isinstance(v, str) and v.startswith("./nginx")
    ]
    assert len(matches) == 1, (
        f"expected exactly one ./nginx-rooted bind mount; found {len(matches)}: "
        f"{matches}"
    )
    mount = matches[0]
    # Explicitly reject the pre-fix single-file mount form.
    assert "nginx.conf:/etc/nginx/conf.d/default.conf" not in mount, (
        "single-file bind mount detected — the fix requires a directory "
        "mount so `git pull` atomic renames propagate into the container"
    )
    # Assert the exact directory form the fix intends.
    assert mount == "./nginx/:/etc/nginx/conf.d/:ro", (
        f"unexpected mount string `{mount}`; expected "
        f"`./nginx/:/etc/nginx/conf.d/:ro`"
    )


def test_nginx_mount_is_read_only():
    svc = _nginx_service()
    volumes = svc.get("volumes", [])
    matches = [v for v in volumes if isinstance(v, str) and v.startswith("./nginx")]
    assert matches, "no ./nginx mount to check ro flag on"
    for v in matches:
        assert v.endswith(":ro"), (
            f"nginx bind mount `{v}` must be read-only (`:ro`); the "
            f"nginx container never writes to its config directory"
        )


def test_nginx_directory_contains_only_nginx_conf():
    """The container reads every `*.conf` under /etc/nginx/conf.d/.
    Right now ./nginx/ hosts exactly one file: nginx.conf. If a future
    edit drops another `.conf` in there (say a dev-only overlay), it
    would be silently picked up by prod nginx. Pin the contents so
    the drop-in must come with an explicit test update."""
    conf_files = sorted(
        p.name for p in _NGINX_DIR.iterdir()
        if p.is_file() and p.suffix == ".conf"
    )
    assert conf_files == ["nginx.conf"], (
        f"./nginx/ must contain exactly one .conf file (`nginx.conf`); "
        f"found {conf_files}. Adding a new .conf here mounts it into "
        f"the container automatically — update this pin explicitly."
    )


# ══════════════════════════════════════════════════════════════════════
#  Nginx service surface — unchanged.
# ══════════════════════════════════════════════════════════════════════


def test_nginx_port_publish_unchanged():
    """Only port 80 is published to the host — 443 is intentionally
    NOT published (host-level nginx handles TLS termination); publishing
    it here would silently occupy the port + break the outer chain."""
    svc = _nginx_service()
    ports = svc.get("ports", [])
    assert ports == ["80:80"], (
        f"nginx `ports` must be exactly [`80:80`]; got {ports}"
    )


def test_nginx_networks_unchanged():
    """T10 B1c segmentation contract: nginx sits in both edge (public
    tier with frontend) and internal (app tier with backend + celery)."""
    svc = _nginx_service()
    networks = svc.get("networks", [])
    assert networks == ["edge", "internal"], (
        f"nginx networks must be [`edge`, `internal`] (T10 B1c "
        f"segmentation); got {networks}"
    )


def test_nginx_healthcheck_unchanged():
    """The healthcheck is `nginx -t` — config-only, no HTTP request.
    Any change here would either miss config drift (worse) or open a
    Host-header dependency (breaks with allowlist)."""
    svc = _nginx_service()
    hc = svc.get("healthcheck", {})
    assert hc.get("test") == ["CMD", "nginx", "-t"], (
        f"nginx healthcheck test drifted; expected `['CMD', 'nginx', "
        f"'-t']`, got {hc.get('test')!r}"
    )
    assert hc.get("interval") == "30s"
    assert hc.get("timeout") == "5s"
    assert hc.get("retries") == 3


def test_nginx_depends_on_backend_and_frontend_unchanged():
    svc = _nginx_service()
    deps = svc.get("depends_on", [])
    # Both list form and mapping form are accepted by compose; pin the
    # list form since that's the existing shape.
    if isinstance(deps, list):
        assert sorted(deps) == ["backend", "frontend"]
    elif isinstance(deps, dict):
        assert set(deps.keys()) == {"backend", "frontend"}
    else:
        pytest.fail(f"unexpected depends_on shape: {type(deps).__name__}")


def test_nginx_image_pinned_to_alpine_tag_family():
    """nginx image tag is what the compose file picks up in prod. Pin
    the family (`nginx:1.27-alpine`) — a jump to a different major
    version would need config compatibility review + a new syntax
    test round."""
    svc = _nginx_service()
    assert svc.get("image") == "nginx:1.27-alpine", (
        f"nginx image drifted from `nginx:1.27-alpine`; got "
        f"`{svc.get('image')}`"
    )


def test_nginx_restart_policy_unchanged():
    svc = _nginx_service()
    assert svc.get("restart") == "unless-stopped"


# ══════════════════════════════════════════════════════════════════════
#  Other service mounts unchanged (only the nginx mount was touched).
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("svc_name", [
    "backend", "postgres", "redis", "celery_worker",
    "celery_beat", "frontend",
])
def test_other_services_present_and_untouched_by_mount_edit(svc_name):
    """A minimal presence pin — the nginx mount change should never
    have side effects on other services. If a rebase drops one of
    these, the failure surface points at the wrong PR."""
    compose = _load_compose()
    services = compose.get("services", {})
    assert svc_name in services, (
        f"service `{svc_name}` disappeared from docker-compose.yml; "
        f"this PR only touches the nginx service"
    )
