"""Farms: CRUD, background data build and per-farm insights."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
from sqlalchemy import func, select

from app.deps import CurrentUser, DbSession, SettingsDep, check_build_quota, owned_farm
from app.models import ClimateCell, Farm, SoilProfile, VegetationSeries
from app.routers.vegetation import queue_vegetation
from app.schemas import FarmCreate, FarmOut, FarmUpdate, SoilOut, SoilOverride
from app.services.climate_cache import advice_weather_context
from app.services.farm_data import build_farm_data
from app.services.geometry import BoundaryError, field_shape
from app.services.insights import climate_profile
from app.services.planner import soil_water_now
from app.services.soil import effective_soil
from engine.crops.catalog import has_pack
from engine.ingest.power import snap_to_cell
from engine.regions import region_for

router = APIRouter(prefix="/farms", tags=["farms"])


def _queue_build(request: Request, background: BackgroundTasks, farm_id: uuid.UUID) -> None:
    state = request.app.state
    background.add_task(build_farm_data, state.session_factory, state.settings, farm_id, state.http_client_factory)


@router.get("", response_model=list[FarmOut])
def list_farms(db: DbSession, user: CurrentUser) -> list[FarmOut]:
    return [
        _farm_view(db, farm)
        for farm in db.scalars(select(Farm).where(Farm.user_id == user.id).order_by(Farm.created_at))
    ]


def _farm_view(db: DbSession, farm: Farm) -> FarmOut:
    view = FarmOut.model_validate(farm)
    weather = db.get(ClimateCell, farm.cell_id)
    if weather and weather.quality != "verified" and has_pack(farm.region):
        try:
            advice_weather_context(db, weather)
            return view.model_copy(update={"data_status": "limited", "data_error": None})
        except LookupError:
            pass
    if weather and weather.quality in {"unverified", "needs_attention"}:
        return view.model_copy(
            update={
                "data_status": "error",
                "data_error": "Weather verification needs attention. Journal and soil values remain available.",
            }
        )
    if weather and weather.quality in {"downloading", "validating"}:
        return view.model_copy(update={"data_status": "pending"})
    return view


@router.post("", response_model=FarmOut, status_code=status.HTTP_201_CREATED)
def create_farm(
    body: FarmCreate,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
    user: CurrentUser,
    settings: SettingsDep,
) -> Farm:
    count = db.scalar(select(func.count()).select_from(Farm).where(Farm.user_id == user.id))
    if count >= settings.max_farms_per_user:
        raise HTTPException(status.HTTP_409_CONFLICT, f"You can have up to {settings.max_farms_per_user} farms.")
    check_build_quota(request, user)
    lat, lon, area_ha, boundary = body.lat, body.lon, body.area_ha, None
    if body.boundary is not None:
        try:
            drawn_ha, lat, lon = field_shape(body.boundary.coordinates[0])
        except BoundaryError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
        area_ha = area_ha or round(drawn_ha, 2)
        boundary = body.boundary.model_dump()
    farm = Farm(
        id=uuid.uuid4(),
        user_id=user.id,
        name=body.name,
        lat=lat,
        lon=lon,
        area_ha=area_ha,
        boundary=boundary,
        irrigation=body.irrigation,
        region=region_for(lat, lon),
        cell_id=snap_to_cell(lat, lon).id,
    )
    db.add(farm)
    db.commit()
    _queue_build(request, background, farm.id)
    queue_vegetation(request, background, farm.id)
    return farm


@router.get("/{farm_id}", response_model=FarmOut)
def get_farm(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> FarmOut:
    return _farm_view(db, owned_farm(db, user, farm_id))


@router.patch("/{farm_id}", response_model=FarmOut)
def update_farm(farm_id: uuid.UUID, body: FarmUpdate, db: DbSession, user: CurrentUser) -> Farm:
    farm = owned_farm(db, user, farm_id)
    for field, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(farm, field, value)
    db.commit()
    return farm


@router.delete("/{farm_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_farm(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> Response:
    db.delete(owned_farm(db, user, farm_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{farm_id}/refresh", response_model=FarmOut, status_code=status.HTTP_202_ACCEPTED)
def refresh_farm(
    farm_id: uuid.UUID, request: Request, background: BackgroundTasks, db: DbSession, user: CurrentUser
) -> Farm:
    farm = owned_farm(db, user, farm_id)
    check_build_quota(request, user)
    farm.data_status, farm.data_error = "pending", None
    db.commit()
    _queue_build(request, background, farm.id)
    return farm


@router.get("/{farm_id}/climate")
def get_climate(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> dict:
    farm = owned_farm(db, user, farm_id)
    if farm.data_status != "ready":
        raise HTTPException(status.HTTP_409_CONFLICT, "This farm's data is still being prepared.")
    try:
        profile = climate_profile(db, farm)
        # Farms with a crop pack get the same journal-based soil water as the advice, instead of a reference crop.
        soil_now = soil_water_now(db, farm) if has_pack(farm.region) else None
    except LookupError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return {**profile, "soil_now": soil_now}


@router.get("/{farm_id}/sources")
def get_sources(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> dict:
    farm = owned_farm(db, user, farm_id)
    weather = db.get(ClimateCell, farm.cell_id)
    soil = db.get(SoilProfile, farm.id)
    satellite = db.get(VegetationSeries, farm.id)
    try:
        context = advice_weather_context(db, weather) if has_pack(farm.region) else None
    except LookupError:
        context = None
    return {
        "advice": {"available": context is not None, "weather_context": context},
        "weather": {
            "status": weather.quality if weather else "pending",
            "years_done": weather.years_done if weather else 0,
            "years_total": weather.years_total if weather else 0,
            "through": weather.last_date if weather and weather.revision else None,
            "updated_at": weather.validated_at if weather else None,
            "revision": weather.revision if weather else None,
            "error": weather.quality_error if weather else None,
        },
        "soil": {
            "status": "farmer" if farm.soil_override else "ready" if soil else "default",
            "updated_at": soil.fetched_at if soil else None,
        },
        "satellite": {
            "status": satellite.status if satellite else "pending",
            "done": len(satellite.ndvi) if satellite else 0,
            "total": satellite.composites_total if satellite else 0,
            "through": max(satellite.ndvi, default=None) if satellite else None,
            "updated_at": satellite.updated_at if satellite else None,
        },
    }


def _soil_view(db: DbSession, farm: Farm) -> SoilOut:
    profile = db.get(SoilProfile, farm.id)
    return SoilOut(
        source=profile.source if profile else "none",
        layers=profile.layers if profile else [],
        summary=profile.summary if profile else {},
        fetched_at=profile.fetched_at if profile else None,
        override=farm.soil_override,
        effective=effective_soil(farm, profile),
    )


@router.get("/{farm_id}/soil", response_model=SoilOut)
def get_soil(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> SoilOut:
    return _soil_view(db, owned_farm(db, user, farm_id))


@router.put("/{farm_id}/soil/override", response_model=SoilOut)
def set_soil_override(farm_id: uuid.UUID, body: SoilOverride, db: DbSession, user: CurrentUser) -> SoilOut:
    farm = owned_farm(db, user, farm_id)
    farm.soil_override = body.model_dump(exclude_none=True)
    db.commit()
    return _soil_view(db, farm)


@router.delete("/{farm_id}/soil/override", response_model=SoilOut)
def clear_soil_override(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> SoilOut:
    farm = owned_farm(db, user, farm_id)
    farm.soil_override = None
    db.commit()
    return _soil_view(db, farm)
