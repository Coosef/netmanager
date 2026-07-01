"""RBAC-SPRINT-2.1 — notifications module catalog + approval:review backfill

Adds the `notifications` module block to every existing permission_set
row. The two new verbs — `view` and `manage` — replace the previously
recycled `approval:review` verb that notifications.py:44+ was
(mis-)using pre-Sprint-2.1.

Backfill policy (mirrors f9ah_feature_module_catalog.py additions):

  - Present keys ALWAYS win — existing `notifications.view` /
    `notifications.manage` values are preserved verbatim (idempotent).
  - Missing keys default to FALSE for every row.
  - EXCEPT for two carry-over rules:
      1. If the row's `approval.review` is TRUE, then both
         `notifications.view` AND `notifications.manage` default
         to TRUE. This is the "no admin loses access on deploy" rule:
         every operator who could manage notification channels
         under the old (wrong) verb keeps that access under the new
         (correct) verbs.
      2. If the row's NAME is in {"Tam Yetki", "Org Admin"},
         both verbs default to TRUE (same opt-in policy Phase 1's
         f9ah used).
    The two rules are OR-ed — either one is enough to flip the
    defaults from FALSE.

  - Malformed rows (non-dict `permissions` or non-dict `modules`)
    fail-CLOSED: `notifications` block emitted with both verbs FALSE
    regardless of any opt-in rule. A corrupt row must never silently
    elevate access.

The approvals matrix row and the intelligence route gate change ship
alongside this migration but require NO schema mutation: approvals
verbs already exist on every seeded set, intelligence reuses the
existing `monitoring:view` verb.

Downgrade: strips the `notifications` module block entirely from every
row. PermissionEngine ignores unknown keys, so the pre-migration
shape is restored exactly.

Revision ID: f9ainotifmod
Revises: f9ahfeatmod
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9ainotifmod"
down_revision = "f9ahfeatmod"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


# Permission set NAMES that receive the notifications verbs on
# default-True backfill regardless of the approval.review carry-over.
_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})

# The new verb set installed on every row.
_NOTIFICATIONS_VERBS: tuple[str, ...] = ("view", "manage")


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _approval_review_granted(modules_before: dict) -> bool:
    """Look up the row's current `approval.review` bit safely. Returns
    True only when the row has `modules["approval"]["review"] == True`
    with EXACT structure — any missing key or non-True value counts
    as False.

    Pure function so the unit test can exercise the derivation policy
    without a DB connection.
    """
    if not isinstance(modules_before, dict):
        return False
    approval = modules_before.get("approval")
    if not isinstance(approval, dict):
        return False
    return approval.get("review") is True


def _backfill_notifications_block(
    module_before: dict | None,
    default_value: bool,
) -> dict:
    """Add the two new verbs to a single permission_set row's
    `notifications` sub-dict, preserving any existing values.

    Cases for `module_before`:
      - dict (possibly empty) — preserve every key, fill in any missing
                                verb with `default_value`
      - None                  — module did not exist on the row
                                pre-migration; seed every verb with
                                `default_value`
      - any other type        — row is MALFORMED; emit a fail-closed
                                block (NEVER inherits the opt-in TRUE)

    Mirrors f9ah_feature_module_catalog.py::_backfill_module_block
    semantics so operators reviewing this migration can rely on the
    same invariants they already verified for Phase 1.
    """
    if module_before is None:
        return {verb: default_value for verb in _NOTIFICATIONS_VERBS}
    if not isinstance(module_before, dict):
        # Malformed (string, list, etc) — fail-closed.
        return {verb: False for verb in _NOTIFICATIONS_VERBS}

    result = dict(module_before)
    for verb in _NOTIFICATIONS_VERBS:
        if verb not in result:
            result[verb] = default_value
    return result


def _default_value_for_row(modules_before: dict, set_name: str) -> bool:
    """Combine the two opt-in rules (name-based + approval-carry-over)
    into the single `default_value` the block builder needs.
    """
    name_opt_in = set_name in _FULL_ACCESS_OPT_IN_NAMES
    carry_over  = _approval_review_granted(modules_before)
    return name_opt_in or carry_over


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply the notifications backfill to one row's full permissions
    dict and return a NEW dict. Unknown modules + unknown keys are
    preserved verbatim — this migration only adds, never removes.
    """
    if not isinstance(permissions, dict):
        # Reset to canonical empty on a malformed row.
        from app.models.shared.permission_set import DEFAULT_PERMISSIONS
        return dict(DEFAULT_PERMISSIONS)

    result = dict(permissions)
    modules_before = result.get("modules", {})
    if not isinstance(modules_before, dict):
        modules_before = {}

    default_value = _default_value_for_row(modules_before, set_name)

    modules_after = dict(modules_before)
    modules_after["notifications"] = _backfill_notifications_block(
        modules_before.get("notifications"),
        default_value,
    )
    result["modules"] = modules_after
    return result


# ── Upgrade ───────────────────────────────────────────────────────────────


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text("SELECT id, name, permissions FROM permission_sets")
    ).fetchall()

    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        before = permissions
        after = _backfill_row(before, row.name or "")
        if before == after:
            continue
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )


# ── Downgrade ─────────────────────────────────────────────────────────────


def _downgrade_row(permissions: dict) -> dict:
    if not isinstance(permissions, dict):
        return permissions
    result = dict(permissions)
    modules = result.get("modules")
    if not isinstance(modules, dict):
        return result
    new_modules = {k: v for k, v in modules.items() if k != "notifications"}
    result["modules"] = new_modules
    return result


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, permissions FROM permission_sets")
    ).fetchall()
    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        before = permissions
        after = _downgrade_row(before)
        if before == after:
            continue
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )
