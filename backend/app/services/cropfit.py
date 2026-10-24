"""Crop fit for a farm: the engine's season simulation for every pack crop, cached per farm data and options."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import Farm
from app.services.farm_inputs import data_key, farm_inputs
from app.services.lru import LruCache
from engine.planner.cropfit import crop_fit

_results: LruCache[dict] = LruCache(64)


def farm_crop_fit(
    db: Session, farm: Farm, season: str | None, irrigation: str, before: Callable[[], None] | None = None
) -> dict:
    today = datetime.now(UTC).date()
    key = (*data_key(db, farm), season, irrigation, today)
    return _results.get_or_compute(key, lambda: crop_fit(farm_inputs(db, farm), season, irrigation, today), before)
