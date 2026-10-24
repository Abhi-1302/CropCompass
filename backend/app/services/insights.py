"""Climate profile for a farm, cached per cell data version, soil water capacity and region."""

from __future__ import annotations

import threading
from collections import OrderedDict

from sqlalchemy.orm import Session

from app.models import ClimateCell, Farm, SoilProfile
from app.services.climate_cache import load_frame, require_verified
from app.services.soil import effective_soil
from engine.climate.profile import build_profile

_MAX_PROFILES = 128
_profiles: OrderedDict[tuple, dict] = OrderedDict()
_guard = threading.Lock()


def climate_profile(db: Session, farm: Farm) -> dict:
    row = require_verified(db.get(ClimateCell, farm.cell_id))
    soil = effective_soil(farm, db.get(SoilProfile, farm.id))
    awc = soil["awc_mm"] if soil["source"] != "default" else None
    key = (row.id, row.revision, awc, soil["source"], farm.region)
    with _guard:
        cached = _profiles.get(key)
        if cached is not None:
            _profiles.move_to_end(key)
            return cached
    profile = build_profile(load_frame(row), row.lat, row.elevation_m, awc_mm=awc, region=farm.region)
    profile["assumptions"]["awc_source"] = soil["source"]
    profile["location"] = {"cell_id": row.id, "cell_lat": row.lat, "cell_lon": row.lon, "elevation_m": row.elevation_m}
    with _guard:
        _profiles[key] = profile
        while len(_profiles) > _MAX_PROFILES:
            _profiles.popitem(last=False)
    return profile
