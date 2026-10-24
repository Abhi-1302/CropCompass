"""Planner: next-crop advice, rotation explorer, stress tests and saved plans (docs/PLAN.md section 10)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select

from app.deps import CurrentUser, DbSession, owned_farm
from app.models import ClimateCell, Farm, Plan
from app.schemas import NextCropIn, PlanIn, PlanOut, RotationsIn, StressTestIn
from app.services import planner
from app.services.climate_cache import advice_weather_context

router = APIRouter(prefix="/farms/{farm_id}", tags=["planner"])


def _ready_farm(db: DbSession, user: CurrentUser, farm_id: uuid.UUID) -> Farm:
    return owned_farm(db, user, farm_id)


def _limit(request: Request, user: CurrentUser):
    def check() -> None:
        if not request.app.state.limiters["advice"].hit(str(user.id)):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new simulations. Please wait a little.")

    return check


def _call(action):
    try:
        return action()
    except LookupError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


def _weights(body) -> dict | None:
    return body.weights.model_dump() if body.weights else None


@router.post("/advice/next-crop")
def next_crop(farm_id: uuid.UUID, body: NextCropIn, request: Request, db: DbSession, user: CurrentUser) -> dict:
    farm = _ready_farm(db, user, farm_id)
    irrigation = body.irrigation or farm.irrigation
    return _call(lambda: planner.next_crop(db, farm, body.season, irrigation, _weights(body), _limit(request, user)))


@router.post("/advice/rotations")
def rotations(farm_id: uuid.UUID, body: RotationsIn, request: Request, db: DbSession, user: CurrentUser) -> dict:
    farm = _ready_farm(db, user, farm_id)
    irrigation = body.irrigation or farm.irrigation
    return _call(lambda: planner.rotations(db, farm, irrigation, _weights(body), body.residue, _limit(request, user)))


@router.post("/advice/stress-test")
def stress_test(farm_id: uuid.UUID, body: StressTestIn, request: Request, db: DbSession, user: CurrentUser) -> dict:
    farm = _ready_farm(db, user, farm_id)
    payload = {**body.model_dump(), "weights": _weights(body)}
    return _call(lambda: planner.stress(db, farm, payload, _limit(request, user)))


def _plan_view(db: DbSession, farm: Farm, plan: Plan) -> PlanOut:
    row = db.get(ClimateCell, farm.cell_id)
    revision = plan.inputs.get("weather_revision")
    quality = (
        "unverified"
        if not revision or row is None or row.quality != "verified"
        else "current"
        if revision == row.revision
        else "outdated"
    )
    if plan.inputs.get("weather_context", {}).get("mode") == "historical_proxy":
        try:
            context = advice_weather_context(db, row)
            quality = "low_confidence" if revision == context["revision"] else "outdated"
        except LookupError:
            quality = "unverified"
    return PlanOut.model_validate(plan).model_copy(update={"weather_status": quality})


@router.get("/plans", response_model=list[PlanOut])
def list_plans(farm_id: uuid.UUID, db: DbSession, user: CurrentUser) -> list[PlanOut]:
    farm = owned_farm(db, user, farm_id)
    return [
        _plan_view(db, farm, plan)
        for plan in db.scalars(select(Plan).where(Plan.farm_id == farm.id).order_by(Plan.created_at.desc()))
    ]


@router.post("/plans", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def save_plan(farm_id: uuid.UUID, body: PlanIn, request: Request, db: DbSession, user: CurrentUser) -> PlanOut:
    farm = _ready_farm(db, user, farm_id)
    payload = {**body.model_dump(), "weights": _weights(body)}
    return _plan_view(db, farm, _call(lambda: planner.save_plan(db, farm, payload, _limit(request, user))))


@router.delete("/plans/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan(farm_id: uuid.UUID, plan_id: uuid.UUID, db: DbSession, user: CurrentUser) -> Response:
    farm = owned_farm(db, user, farm_id)
    plan = db.get(Plan, plan_id)
    if plan is None or plan.farm_id != farm.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found")
    db.delete(plan)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
