"""Season outcomes from simulated realisations (yield, money, water, heat, nitrogen, soil carbon) for the planners."""

from __future__ import annotations

from dataclasses import fields
from datetime import date, timedelta

import numpy as np

from engine.climate.indicators import probability
from engine.crops.catalog import CropParams
from engine.models import nitrogen, rothc
from engine.models.crop_yield import FAILURE_SHARE, relative_yield
from engine.models.water import SlotResult
from engine.planner import rules
from engine.planner.common import (
    FarmInputs,
    JournalEntry,
    PracticeItem,
    Weather,
    carbon_item,
    current_practice,
    md,
    monthly_climate,
)

QUANTILES = (10, 50, 90)
HEAT_RISK_DAMAGE = 0.1
CARBON_YEARS = 10
DAYS_PER_MONTH = 30.44


def take(result: SlotResult, index) -> SlotResult:
    """The realisations `index` of a slot result."""
    return SlotResult(**{f.name: getattr(result, f.name)[index] for f in fields(result)})


def nitrogen_effects(effects: list[rules.Effect]) -> tuple[float, float]:
    """kg N/ha saved by credits and added by lock-up."""
    return -sum(e.n_kg for e in effects if e.n_kg < 0), sum(e.n_kg for e in effects if e.n_kg > 0)


def crop_outcome(
    crop: CropParams,
    sim: SlotResult,
    years: list[int],
    *,
    factor: float,
    effects: list[rules.Effect],
    n_price: float,
    reference: date,
    lead: int,
    window: tuple[date, date],
) -> tuple[dict, dict]:
    """Summary of one crop over every simulated year, plus raw indicators for scoring."""
    done = sim.harvest_day >= 0
    k = int(done.sum())
    share = relative_yield(
        sim.eta_mm, sim.etc_mm, crop.ky, sim.heat_damage, factor, sim.eta_flowering_mm, sim.etc_flowering_mm
    )[done]
    kg = share * (crop.ym or 0)
    credit, extra = nitrogen_effects(effects)
    n_apply = nitrogen.fertiliser_need(crop, credit, extra)
    income = kg * crop.price - crop.cost - n_apply * n_price
    met = np.divide(sim.eta_mm, sim.etc_mm, out=np.ones(len(done)), where=sim.etc_mm > 0)[done]
    relative = float(np.median(share)) if k else 0.0

    def median(values) -> float | None:
        return float(np.median(np.asarray(values)[done])) if k else None

    def day(values) -> str | None:
        return md(reference + timedelta(days=float(np.median(np.asarray(values)[done] - lead)))) if k else None

    def pct(values, q) -> float | None:
        return round(float(np.percentile(values, q))) if k else None

    summary = {
        "id": crop.id,
        "sowing": {
            "window": [md(window[0]), md(window[1])],
            "median": day(sim.sow_day),
            "late": probability(int(sim.late[done].sum()), k),
            "dry": probability(int(sim.dry_sown[done].sum()), k),
        },
        "harvest": {"median": day(sim.harvest_day)},
        "duration_days": crop.duration,
        "water": {
            "need_mm": round(median(sim.etc_mm)) if k else None,
            "met": round(float(np.median(met)), 2) if k else None,
            "rain_mm": round(median(sim.rain_mm)) if k else None,
            "irrigation_mm": round(median(sim.irrigation_mm)) if k else 0,
            "irrigations": round(median(sim.irrigations)) if k else 0,
            "soil_at_sowing_mm": round(median(sim.water_at_sowing_mm)) if k else None,
        },
        "yield": {
            "attainable": crop.ym,
            **{f"p{q}": pct(kg, q) for q in QUANTILES},
            "relative": round(relative, 2),
            "failure": probability(int((share < FAILURE_SHARE).sum()), k),
            "by_year": [
                {"year": y, "kg_ha": round(float(v))} for y, v in zip(np.array(years)[done].tolist(), kg, strict=True)
            ],
        },
        "income": {"mean": round(float(income.mean())) if k else None, **{f"p{q}": pct(income, q) for q in QUANTILES}},
        "heat": {
            "threshold_c": crop.heat_c,
            "risk": probability(int((sim.heat_damage[done] >= HEAT_RISK_DAMAGE).sum()), k)
            if crop.heat_c is not None
            else None,
        },
        "nitrogen": {
            "recommended": crop.n_rec,
            "credit": credit,
            "extra": extra,
            "to_apply": round(n_apply),
            "fixed": round(nitrogen.fixed(crop, relative)),
            "leaves": round(crop.n_credit),
        },
        "rules": [effect.to_dict() for effect in effects],
        "carbon": None,
    }
    indicators = {
        "income_mean": float(income.mean()) if k else np.nan,
        "income_p10": float(np.percentile(income, 10)) if k else np.nan,
        "gross_mean": float((kg * crop.price).mean()) if k else np.nan,
        "failure": float((share < FAILURE_SHARE).mean()) if k else 1.0,
        "irrigation_mm": median(sim.irrigation_mm) or 0.0,
        "eta_mm": float(sim.eta_mm[done].mean()) if k else np.nan,
        "n_fixed": nitrogen.fixed(crop, relative),
        "cover_months": crop.duration / DAYS_PER_MONTH,
        "pest_flags": sum(1 for e in effects if e.kind == "risk"),
    }
    return summary, indicators


def season_carbon(
    farm: FarmInputs,
    weather: Weather,
    history: list[JournalEntry],
    reference: date,
    settings: dict,
    season: str,
    plantings: list[tuple[CropParams, tuple[float, float, float], date]],
) -> tuple[list[dict] | None, dict | None]:
    """10-year topsoil carbon change if each crop fills `season` every year (residue kept / removed), compared
    with the current practice; None when the farm has no soil-carbon data."""
    if not farm.soc_t_ha or farm.clay_pct is None:
        return None, None
    items, source = current_practice(farm, history, reference, settings)
    others = [item for item in items if item.season != season]
    scenarios = []
    for crop, yields, sowing in plantings:
        for residue in ("incorporated", "removed"):
            for kg in yields:
                planted = PracticeItem(crop, season, kg or 0.0, residue, sowing, crop.duration)
                scenarios.append([*(carbon_item(item) for item in others), carbon_item(planted)])
    deltas = rothc.soc_change(
        farm.soc_t_ha,
        farm.clay_pct,
        monthly_climate(farm.frame, weather.et0_series),
        [carbon_item(item) for item in items],
        scenarios,
        CARBON_YEARS,
    ).reshape(len(plantings), 2, len(QUANTILES))
    per_crop = [
        {
            key: {"low": round(float(row[0]), 1), "mid": round(float(row[1]), 1), "high": round(float(row[2]), 1)}
            for key, row in zip(("kept", "removed"), delta, strict=True)
        }
        for delta in deltas
    ]
    meta = {
        "soc_t_ha": round(farm.soc_t_ha, 1),
        "years": CARBON_YEARS,
        "baseline_source": source,
        "baseline": [{"crop": i.crop.id, "season": i.season, "residue": i.residue} for i in items],
    }
    return per_crop, meta
