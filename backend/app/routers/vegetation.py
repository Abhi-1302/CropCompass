"""Satellite (MODIS NDVI) history of a farm and the crop catalog."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Request, status

from app.deps import CurrentUser, DbSession, check_build_quota, owned_farm
from app.models import VegetationSeries
from app.services.vegetation import build_vegetation, is_running, needs_download, vegetation_view
from engine.crops.catalog import load_catalog

router = APIRouter(tags=["vegetation"])


def queue_vegetation(request: Request, background: BackgroundTasks, farm_id: uuid.UUID) -> None:
    state = request.app.state
    background.add_task(build_vegetation, state.session_factory, state.settings, farm_id, state.http_client_factory)


@router.get("/farms/{farm_id}/vegetation")
def get_vegetation(
    farm_id: uuid.UUID, request: Request, background: BackgroundTasks, db: DbSession, user: CurrentUser
) -> dict:
    farm = owned_farm(db, user, farm_id)
    if needs_download(db.get(VegetationSeries, farm.id), farm.id):
        queue_vegetation(request, background, farm.id)
    return vegetation_view(db, farm)


@router.post("/farms/{farm_id}/vegetation/refresh", status_code=status.HTTP_202_ACCEPTED)
def refresh_vegetation(
    farm_id: uuid.UUID, request: Request, background: BackgroundTasks, db: DbSession, user: CurrentUser
) -> dict:
    farm = owned_farm(db, user, farm_id)
    if not is_running(farm.id):
        check_build_quota(request, user)
        queue_vegetation(request, background, farm.id)
    return vegetation_view(db, farm)


@router.get("/crops")
def get_crops(region: str | None = None) -> dict:
    return load_catalog(region)
