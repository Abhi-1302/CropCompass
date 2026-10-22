"""Crop fit: how each crop of the farm's region pack would do there, simulated across past years."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status

from app.deps import CurrentUser, DbSession, owned_farm
from app.services.cropfit import farm_crop_fit

router = APIRouter(tags=["crops"])


@router.get("/farms/{farm_id}/crop-fit")
def get_crop_fit(
    farm_id: uuid.UUID,
    request: Request,
    db: DbSession,
    user: CurrentUser,
    season: Literal["kharif", "rabi", "summer"] | None = None,
    irrigation: Literal["rainfed", "protective", "full"] | None = None,
) -> dict:
    farm = owned_farm(db, user, farm_id)
    if farm.data_status != "ready":
        raise HTTPException(status.HTTP_409_CONFLICT, "This farm's data is still being prepared.")

    def check() -> None:
        if not request.app.state.limiters["advice"].hit(str(user.id)):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new simulations. Please wait a little.")

    try:
        return farm_crop_fit(db, farm, season, irrigation or farm.irrigation, check)
    except LookupError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
