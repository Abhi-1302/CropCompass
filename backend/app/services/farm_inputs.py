"""Engine inputs for a farm (weather, soil, journal), plus a key that changes whenever any of them changes."""

from __future__ import annotations

import json
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ClimateCell, Farm, SeasonRecord, SoilProfile
from app.services.climate_cache import advice_weather_context, load_advice_frame, load_frame, require_verified
from app.services.soil import effective_soil
from engine.crops.catalog import has_pack
from engine.planner.common import FarmInputs, JournalEntry


def _entry(record: SeasonRecord) -> JournalEntry:
    return JournalEntry(
        crops=tuple(record.crops),
        season=record.season,
        sow_date=record.sow_date,
        harvest_date=record.harvest_date,
        status=record.status,
        residue=record.residue,
        irrigations=record.irrigations,
        yield_kg_ha=record.yield_kg_ha,
        problems=tuple(record.problems or ()),
        herbicide=record.herbicide,
    )


def data_key(db: Session, farm: Farm, *, advice: bool = False) -> tuple:
    """Cheap fingerprint of everything the engine reads for this farm."""
    if not has_pack(farm.region):
        raise LookupError("Crop advice isn't available for this region yet; climate and soil insights still work.")
    row = db.get(ClimateCell, farm.cell_id)
    revision = advice_weather_context(db, row)["revision"] if advice else require_verified(row).revision
    soil = db.get(SoilProfile, farm.id)
    stamps = db.execute(select(SeasonRecord.id, SeasonRecord.updated_at).where(SeasonRecord.farm_id == farm.id)).all()
    return (
        farm.id,
        revision,
        row.fetched_at.isoformat(),
        soil.fetched_at.isoformat() if soil else None,
        tuple(sorted((str(i), u.isoformat()) for i, u in stamps)),
        farm.region,
        farm.irrigation,
        json.dumps(farm.soil_override, sort_keys=True),
    )


def farm_inputs(db: Session, farm: Farm, *, advice: bool = False) -> FarmInputs:
    row = db.get(ClimateCell, farm.cell_id)
    context = advice_weather_context(db, row) if advice else None
    soil = effective_soil(farm, db.get(SoilProfile, farm.id))
    records = db.scalars(select(SeasonRecord).where(SeasonRecord.farm_id == farm.id))
    return FarmInputs(
        frame=load_advice_frame(db, row, context) if advice else load_frame(row),
        lat=row.lat,
        elevation_m=row.elevation_m,
        region=farm.region,
        awc_mm_per_m=soil["awc_mm_per_m"],
        awc_source=soil["source"],
        tew_mm=soil["tew_mm"],
        soc_t_ha=soil["soc_stock_t_ha_0_30cm"],
        clay_pct=soil["clay_pct"],
        history=tuple(_entry(record) for record in records),
        area_ha=farm.area_ha,
        depth_m=soil["depth_cm"] / 100,
        irrigation=farm.irrigation,
        historical_through=date.fromisoformat(context["checked_through"])
        if context and context["mode"] == "historical_proxy"
        else None,
    )
