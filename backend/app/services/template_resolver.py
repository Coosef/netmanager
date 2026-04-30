"""
TemplateResolver — selects the best DriverTemplate for a given
(os_type, command_type, firmware_version) triplet using a scoring system.

Scoring rules:
  base                     = template.priority  (default 100)
  + firmware regex match   = +50
  + generic (no pattern)   = +10
  + is_verified            = +30
  + success_rate ≥ 90%     = +20
  + success_rate 70–90%    = +10
  - success_rate < 50%     = -25
  skip if not active or failure_count > 30 and success_rate < 0.3
"""
import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.driver_template import DriverTemplate


class TemplateResolver:

    # ---------------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------------

    async def resolve(
        self,
        db: AsyncSession,
        os_type: str,
        command_type: str,
        firmware_version: str | None = None,
    ) -> Optional[DriverTemplate]:
        """Return the single best template, or None if nothing matches."""
        candidates = await self._fetch_candidates(db, os_type, command_type)
        if not candidates:
            return None

        scored = [
            (self._score(t, firmware_version), t)
            for t in candidates
            if not self._should_skip(t)
        ]
        if not scored:
            return None

        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1]

    async def resolve_fallback_chain(
        self,
        db: AsyncSession,
        os_type: str,
        command_type: str,
        firmware_version: str | None = None,
    ) -> list[DriverTemplate]:
        """Return all viable templates ordered by score (for multi-command fallback)."""
        candidates = await self._fetch_candidates(db, os_type, command_type)
        scored = [
            (self._score(t, firmware_version), t)
            for t in candidates
            if not self._should_skip(t)
        ]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for _, t in scored]

    async def record_success(self, db: AsyncSession, template_id: int) -> None:
        now = datetime.now(timezone.utc)
        await db.execute(
            update(DriverTemplate)
            .where(DriverTemplate.id == template_id)
            .values(
                success_count=DriverTemplate.success_count + 1,
                last_success_at=now,
            )
        )
        await db.commit()

    async def record_failure(self, db: AsyncSession, template_id: int) -> None:
        now = datetime.now(timezone.utc)
        await db.execute(
            update(DriverTemplate)
            .where(DriverTemplate.id == template_id)
            .values(
                failure_count=DriverTemplate.failure_count + 1,
                last_failure_at=now,
            )
        )
        await db.commit()

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------

    async def _fetch_candidates(
        self,
        db: AsyncSession,
        os_type: str,
        command_type: str,
    ) -> list[DriverTemplate]:
        q = (
            select(DriverTemplate)
            .where(
                DriverTemplate.os_type == os_type,
                DriverTemplate.command_type == command_type,
                DriverTemplate.is_active.is_(True),
            )
        )
        result = await db.execute(q)
        return list(result.scalars().all())

    def _score(self, template: DriverTemplate, firmware_version: str | None) -> int:
        score = template.priority  # base (default 100)

        # Firmware version specificity
        if template.os_version_pattern:
            if firmware_version:
                try:
                    if re.search(template.os_version_pattern, firmware_version, re.IGNORECASE):
                        score += 50  # specific version match
                    else:
                        score -= 30  # pattern present but doesn't match this firmware
                except re.error:
                    pass
        else:
            score += 10  # generic (no pattern) — slight preference for broad coverage

        # Verification bonus
        if template.is_verified:
            score += 30

        # Health-based adjustment (only when enough data)
        total = template.success_count + template.failure_count
        if total >= 5:
            rate = template.success_count / total
            if rate >= 0.90:
                score += 20
            elif rate >= 0.70:
                score += 10
            elif rate < 0.50:
                score -= 25

        return score

    def _should_skip(self, template: DriverTemplate) -> bool:
        total = template.success_count + template.failure_count
        if total >= 30:
            rate = template.success_count / total
            if rate < 0.30:
                return True  # persistently broken — exclude from selection
        return False


# Module-level singleton
template_resolver = TemplateResolver()
