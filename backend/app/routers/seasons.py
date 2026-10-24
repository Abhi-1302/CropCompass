"""Season journal: the crops a farmer grew on a farm, with dates and outcomes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from app.deps import CurrentUser, DbSession, owned_farm
from app.models import SeasonRecord
from app.schemas import SeasonIn, SeasonOut, SeasonUpdate
from app.services.seasons import SeasonError, normalize_season

router = APIRouter(prefix="/farms/{farm_id}/seasons", tags=["seasons"])

MAX_SEASONS_PER_FARM = 200
FIELDS = tuple(SeasonIn.model_fields)


@router.get("", response_model=list[SeasonOut])
def list_seasons(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[SeasonRecord]:
    farm = owned_farm(db, user, farm_id)
    query = select(SeasonRecord).where(SeasonRecord.farm_id == farm.id).order_by(SeasonRecord.sow_date.desc())
    return list(db.scalars(query))


@router.post("", response_model=SeasonOut, status_code=status.HTTP_201_CREATED)
def create_season(farm_id: uuid.UUID, body: SeasonIn, db: DbSession, user: CurrentUser) -> SeasonRecord:
    farm = owned_farm(db, user, farm_id)
    count = db.scalar(select(func.count()).select_from(SeasonRecord).where(SeasonRecord.farm_id == farm.id))
    if count >= MAX_SEASONS_PER_FARM:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A farm can hold up to {MAX_SEASONS_PER_FARM} seasons.")
    try:
        values = normalize_season(body.model_dump(), farm.region)
    except SeasonError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    record = SeasonRecord(farm_id=farm.id, **values)
    db.add(record)
    db.commit()
    return record


def _owned_season(db: DbSession, farm_id: uuid.UUID, season_id: uuid.UUID) -> SeasonRecord:
    record = db.get(SeasonRecord, season_id)
    if record is None or record.farm_id != farm_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Season not found")
    return record


@router.patch("/{season_id}", response_model=SeasonOut)
def update_season(
    farm_id: uuid.UUID, season_id: uuid.UUID, body: SeasonUpdate, db: DbSession, user: CurrentUser
) -> SeasonRecord:
    farm = owned_farm(db, user, farm_id)
    record = _owned_season(db, farm.id, season_id)
    changes = body.model_dump(exclude_unset=True)
    for required in ("crops", "sow_date", "status"):
        if required in changes and changes[required] is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{required} can't be empty.")
    merged = {field: getattr(record, field) for field in FIELDS} | changes
    if "sow_date" in changes and "season" not in changes:
        merged["season"] = None  # re-derive the season from the new sowing date
    try:
        values = normalize_season(merged, farm.region)
    except SeasonError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    for field, value in values.items():
        setattr(record, field, value)
    db.commit()
    return record


@router.delete("/{season_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_season(farm_id: uuid.UUID, season_id: uuid.UUID, db: DbSession, user: CurrentUser) -> Response:
    farm = owned_farm(db, user, farm_id)
    db.delete(_owned_season(db, farm.id, season_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
