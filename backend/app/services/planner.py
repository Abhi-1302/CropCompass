"""Next-crop advice, rotations, stress tests and saved plans for a farm.

Simulations don't depend on the farmer's priorities, so they are cached per farm data and options and only the
cheap ranking is redone when the sliders move. Cache misses go through `before`, which applies the rate limit.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ClimateCell, Farm, Plan
from app.services.climate_cache import advice_weather_context
from app.services.farm_inputs import data_key, farm_inputs
from app.services.lru import LruCache
from engine.planner import ENGINE_VERSION
from engine.planner.advisor import rank, simulate_next_crop, stress_test
from engine.planner.advisor import soil_water_now as replay_soil_water
from engine.planner.rotations import rank_rotations, simulate_rotations, stress_rotations
from engine.planner.scoring import clean_weights

MAX_PLANS_PER_FARM = 20
Hook = Callable[[], None] | None

_next_runs: LruCache[dict] = LruCache(32)
_rotation_runs: LruCache[object] = LruCache(6)
_rotation_ranks: LruCache[dict] = LruCache(64)
_stress: LruCache[dict] = LruCache(32)
_soil_now: LruCache[dict] = LruCache(64)


def _today():
    return datetime.now(UTC).date()


def weights_for(farm: Farm, weights: dict | None) -> dict:
    return clean_weights(weights if weights is not None else farm.priorities)


def _weights_key(weights: dict) -> tuple:
    return tuple(sorted(weights.items()))


def _with_weather(db: Session, farm: Farm, result: dict) -> dict:
    context = advice_weather_context(db, db.get(ClimateCell, farm.cell_id))
    result = {**result, "weather_context": context}
    if context["confidence"] == "low" and "confidence" in result:
        result["confidence"] = {
            "level": "low",
            "flags": [*result["confidence"]["flags"], "weather_proxy"],
        }
    return result


def soil_water_now(db: Session, farm: Farm) -> dict:
    """Today's soil water from the journal replay, the same figure the next-crop advice starts from."""
    key = (*data_key(db, farm, advice=True), "soil_now")
    return _soil_now.get_or_compute(key, lambda: replay_soil_water(farm_inputs(db, farm, advice=True)), None)


def next_crop(db: Session, farm: Farm, season: str | None, irrigation: str, weights: dict | None, before: Hook) -> dict:
    today = _today()
    key = (*data_key(db, farm, advice=True), "next", season, irrigation, today)
    run = _next_runs.get_or_compute(
        key, lambda: simulate_next_crop(farm_inputs(db, farm, advice=True), season, irrigation, today), before
    )
    return _with_weather(db, farm, rank(run, weights_for(farm, weights)))


def _rotation_run(db: Session, farm: Farm, irrigation: str, before: Hook):
    today = _today()
    key = (*data_key(db, farm, advice=True), "rotations", irrigation, today)
    run = _rotation_runs.get_or_compute(
        key, lambda: simulate_rotations(farm_inputs(db, farm, advice=True), irrigation, today), before
    )
    return key, run


def rotations(db: Session, farm: Farm, irrigation: str, weights: dict | None, residue: str, before: Hook) -> dict:
    key, run = _rotation_run(db, farm, irrigation, before)
    w = weights_for(farm, weights)
    return _with_weather(
        db,
        farm,
        _rotation_ranks.get_or_compute(
            (*key, _weights_key(w), residue), lambda: rank_rotations(run, w, residue), before
        ),
    )


def stress(db: Session, farm: Farm, body: dict, before: Hook) -> dict:
    w = weights_for(farm, body.get("weights"))
    irrigation = body.get("irrigation") or farm.irrigation
    if body["kind"] == "next_crop":
        today = _today()
        key = (*data_key(db, farm, advice=True), "stress-next", body.get("season"), irrigation, today, _weights_key(w))
        return _with_weather(
            db,
            farm,
            _stress.get_or_compute(
                key,
                lambda: stress_test(farm_inputs(db, farm, advice=True), body.get("season"), irrigation, today, w),
                before,
            ),
        )
    if not body.get("rotations"):
        raise ValueError("Choose up to 5 rotations to stress-test")
    run_key, run = _rotation_run(db, farm, irrigation, before)
    key = (*run_key, "stress", tuple(body["rotations"]), _weights_key(w))
    return _with_weather(
        db, farm, _stress.get_or_compute(key, lambda: stress_rotations(run, body["rotations"], w), before)
    )


def save_plan(db: Session, farm: Farm, body: dict, before: Hook) -> Plan:
    count = db.scalar(select(func.count()).select_from(Plan).where(Plan.farm_id == farm.id))
    if count >= MAX_PLANS_PER_FARM:
        raise LookupError(f"A farm can keep up to {MAX_PLANS_PER_FARM} plans. Delete one first.")
    irrigation = body.get("irrigation") or farm.irrigation
    if body["kind"] == "next_crop":
        result = next_crop(db, farm, body.get("season"), irrigation, body.get("weights"), before)
        option = next((o for o in result["options"] if o["id"] == body["choice"]), None)
        inputs = {
            "season": result["season"],
            "season_year": result["season_year"],
            "as_of": result["as_of"],
            "soil_now": result["soil_now"],
        }
    else:
        result = rotations(db, farm, irrigation, body.get("weights"), body["residue"], before)
        candidates = [*result["options"], *([result["current"]] if result["current"] else [])]
        option = next((o for o in candidates if o["key"] == body["choice"]), None)
        inputs = {"first_year": result["first_year"], "residue": result["residue"]}
    if option is None:
        raise ValueError("That choice isn't among the current options; refresh the advice and try again")
    plan = Plan(
        farm_id=farm.id,
        kind=body["kind"],
        title=body["title"],
        inputs={
            **inputs,
            "irrigation": irrigation,
            "weights": result["weights"],
            "weather_revision": result["weather_context"]["revision"],
            "weather_context": result["weather_context"],
        },
        option=option,
        engine_version=ENGINE_VERSION,
    )
    db.add(plan)
    db.commit()
    return plan
