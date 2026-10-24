"""Next-crop advisor: today's soil and any crop in the field, then every past year's weather from today on.

docs/PLAN.md 5.4. The journal is replayed with this year's NASA POWER weather up to the last observed day, which
gives today's soil water and any crop still growing. Each candidate crop and sowing date is then simulated with
the weather that followed the same date in every past year ("today's state + 45 possible futures"). The same
futures started from each year's own soil on this date give the normal-year odds for comparison.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

from engine.crops.catalog import CropParams, crop_params, economics_settings, load_catalog, simulation_settings
from engine.models.water import Irrigation, Slot, SoilState, Sowing, make_slot, simulate
from engine.planner import rules, scoring
from engine.planner.common import (
    IRRIGATION,
    FarmInputs,
    JournalEntry,
    Weather,
    default_season,
    end_date,
    gather,
    main_crop,
    past_crops,
    prepare_weather,
    season_instance,
    window_dates,
    year_starts,
)
from engine.planner.cropfit import soil_of
from engine.planner.outcomes import crop_outcome, season_carbon, take
from engine.planner.scenarios import DELTAS, driest_years, late_onset_years

LEAD_DAYS = 240  # journal replay before today, from a dry start
SOWING_STEP_DAYS = 10
SOWING_OPTIONS = 3
TAIL_DAYS = 30
TOP_N = 5


@dataclass(frozen=True)
class Replayed:
    entry: JournalEntry
    crop: CropParams
    offset: int  # sowing day (or first day of the sowing window) within the replay run
    duration: int
    window_end: int | None = None  # set for assumed crops, which are sown on rain within [offset, window_end]
    assumed: bool = False


@dataclass
class Context:
    farm: FarmInputs
    settings: dict
    season: str
    year: int
    irrigation: str
    today: date
    as_of: date  # last day with observed weather
    start: date  # first simulated future day
    windows: dict[str, tuple[date, date]]
    options: dict[str, list[date]]  # sowing dates to try, per crop that can still be sown
    candidates: list[CropParams]
    excluded: list[dict]
    history: list[JournalEntry]
    replay: list[Replayed]
    in_field: Replayed | None
    ready: date  # earliest sowing: today, or after the crop in the field is harvested


def _replay(farm: FarmInputs, start: date, settings: dict) -> list[Replayed]:
    """Crops in the field before `start`: the journal's, plus the pack's usual crop for a season it skips."""
    anchor = start - timedelta(days=LEAD_DAYS)
    history = [entry for entry in farm.history if entry.status != "planned"]
    spans = [(entry.sow_date, end_date(entry, farm.region)) for entry in history]
    replay = []
    for entry, (sow, end) in zip(history, spans, strict=True):
        crop = main_crop(entry, farm.region)
        if crop is None or sow >= start or end < anchor:
            continue
        first = max(sow, anchor)
        replay.append(Replayed(entry, crop, (first - anchor).days, max((end - first).days, 1)))
    for item in settings.get("baseline_practice", []):
        crop, season = crop_params(farm.region, item["crop"]), item["season"]
        if crop is None or season not in crop.sowing:
            continue
        for year in sorted({anchor.year - 1, anchor.year, start.year}):
            first, last = window_dates(crop.sowing[season], season, year)
            latest_harvest = last + timedelta(days=crop.duration)
            if first >= start or latest_harvest <= anchor:
                continue
            if any(sow <= latest_harvest and first <= end for sow, end in spans):
                continue  # the journal covers this season (with a crop, or as fallow)
            entry = JournalEntry((crop.id,), season, first, None, "assumed", residue=item.get("residue"))
            if last >= anchor:
                offset, window_end, duration = (max(first, anchor) - anchor).days, (last - anchor).days, crop.duration
            else:  # sown before the replay starts: already growing on day 0
                offset, window_end, duration = 0, None, (first + timedelta(days=crop.duration) - anchor).days
            replay.append(Replayed(entry, crop, offset, duration, window_end, assumed=True))
    return sorted(replay, key=lambda r: r.offset)


def _context(farm: FarmInputs, weather: Weather, season: str | None, irrigation: str, today: date) -> Context:
    settings = simulation_settings(farm.region)
    catalog = load_catalog(farm.region)
    season = season or default_season(today)
    all_crops = [
        params
        for crop in catalog["crops"]
        if season in crop["seasons"] and (params := crop_params(farm.region, crop["id"])) is not None
    ]
    if not all_crops:
        raise ValueError(f"No crops in this pack are sown in the {season} season")
    year = season_instance(season, all_crops, today)
    windows = {c.id: window_dates(c.sowing[season], season, year) for c in all_crops}
    as_of = weather.last
    start = as_of + timedelta(days=1)
    anchor = start - timedelta(days=LEAD_DAYS)

    history = [entry for entry in farm.history if entry.status != "planned"]
    replay = _replay(farm, start, settings)
    in_field = next((r for r in reversed(replay) if not r.assumed and r.offset + r.duration > LEAD_DAYS), None)
    turnaround = settings["turnaround_days"]
    ready = max(today, start)
    if in_field is not None:
        ready = max(ready, anchor + timedelta(days=in_field.offset + in_field.duration + turnaround))

    options, candidates, excluded = {}, [], []
    for crop in all_crops:
        first, last = windows[crop.id]
        earliest = max(first, ready)
        if earliest > last:
            excluded.append({"id": crop.id, "reason": "window_closed", "window_end": last.isoformat()})
            continue
        dates = [earliest + timedelta(days=SOWING_STEP_DAYS * k) for k in range(SOWING_OPTIONS)]
        options[crop.id] = [d for d in dates if d <= last]
        candidates.append(crop)
    if not candidates:
        raise ValueError(f"Every {season} sowing window has closed for this year")
    return Context(
        farm,
        settings,
        season,
        year,
        irrigation,
        today,
        as_of,
        start,
        windows,
        options,
        candidates,
        excluded,
        history,
        replay,
        in_field,
        ready,
    )


def _replay_slots(n: int, replay: list[Replayed], farm: FarmInputs, settings: dict) -> list[Slot]:
    usual = IRRIGATION[farm.irrigation]

    def mode(r: Replayed) -> Irrigation:
        if r.assumed:
            return usual
        return Irrigation.PROTECTIVE if r.entry.irrigations else Irrigation.NONE

    return [
        make_slot(
            n,
            window_start=r.offset,
            window_end=r.offset if r.window_end is None else r.window_end,
            sowing=Sowing.ASAP if r.window_end is None or usual == Irrigation.FULL else Sowing.MOISTURE,
            duration=r.duration,
            stage_ends=r.crop.stage_ends(r.duration),
            kc=r.crop.kc,
            root_m=r.crop.root_m,
            p=r.crop.p,
            heat_c=None,
            irrigation=mode(r),
            max_irrigations=settings["protective_irrigations"] if r.assumed else (r.entry.irrigations or 0),
        )
        for r in replay
    ]


def _replay_states(
    farm: FarmInputs, settings: dict, replay: list[Replayed], start: date, weather: Weather
) -> tuple[SoilState, list[int], int]:
    """Soil on `start` in every year (the replay run with that year's weather); the last is this year."""
    anchor = start - timedelta(days=LEAD_DAYS)
    positions, run_years = year_starts(weather, anchor, LEAD_DAYS, include_scenario=True)
    if run_years[-1] != anchor.year:
        raise ValueError("This season's weather record is incomplete")
    _, balance = simulate(
        *gather(weather, positions, LEAD_DAYS),
        _replay_slots(len(run_years), replay, farm, settings),
        soil_of(farm),
        turnaround_days=settings["turnaround_days"],
        sowing_rain_mm=settings["sowing_rain_mm"],
        sowing_soil_fraction=settings["sowing_soil_fraction"],
        initial_fraction=0.0,
    )
    years = [y + start.year - anchor.year for y in run_years]
    return balance.end, years, len(years) - 1


def _soil_on_start(ctx: Context, weather: Weather) -> tuple[SoilState, list[int], int]:
    return _replay_states(ctx.farm, ctx.settings, ctx.replay, ctx.start, weather)


def _soil_summary(farm: FarmInputs, states: SoilState, current: int, replay: list[Replayed], start: date) -> dict:
    capacity = farm.awc_mm_per_m * farm.depth_m
    water = np.asarray(states.root_zone_mm) + np.asarray(states.below_mm)
    past = water[:current]
    return {
        "mm": round(float(water[current])),
        "fraction": round(float(water[current] / capacity), 2),
        "typical_mm": round(float(np.median(past))),
        "percentile": round(float(np.mean(past <= water[current])), 2),
        "capacity_mm": round(capacity),
        "replayed": [r.crop.id for r in replay if not r.assumed],
        "recorded_fallow": any(
            "fallow" in entry.crops
            and entry.status != "planned"
            and entry.sow_date < start
            and end_date(entry, farm.region) >= start - timedelta(days=LEAD_DAYS)
            for entry in farm.history
        ),
        "assumed": [
            {"crop": r.crop.id, "season": r.entry.season, "season_year": r.entry.sow_date.year}
            for r in replay
            if r.assumed
        ],
        "since": (start - timedelta(days=LEAD_DAYS)).isoformat(),
        "as_of": (start - timedelta(days=1)).isoformat(),
    }


def soil_water_now(farm: FarmInputs) -> dict:
    """Soil water on the last day with weather, compared with the same day in past years (as in the advice)."""
    weather = prepare_weather(farm.frame, farm.lat, farm.elevation_m, historical_through=farm.historical_through)
    settings = simulation_settings(farm.region)
    start = weather.last + timedelta(days=1)
    replay = _replay(farm, start, settings)
    states, _, current = _replay_states(farm, settings, replay, start, weather)
    return _soil_summary(farm, states, current, replay, start)


def _pick(state: SoilState, index) -> SoilState:
    return SoilState(*(np.asarray(getattr(state, f))[index] for f in SoilState.__dataclass_fields__))


@dataclass
class Futures:
    years: list[int]
    plans: list[tuple[CropParams, date]]
    actual: object  # SlotResult per (plan, year)
    normal: object | None
    rain: np.ndarray  # (days, years) future rain, for analog subsets


def _futures(ctx: Context, weather: Weather, states: SoilState, state_years: list[int], current: int, normal: bool):
    plans = [(crop, day) for crop in ctx.candidates for day in ctx.options[crop.id]]
    last_end = max((ctx.windows[c.id][1] - ctx.start).days for c in ctx.candidates)
    span = last_end + max(c.duration for c in ctx.candidates) + TAIL_DAYS
    positions, years = year_starts(weather, ctx.start, span)
    known = {y: i for i, y in enumerate(state_years[:current])}
    keep = [j for j, y in enumerate(years) if y in known]
    positions, years = [positions[j] for j in keep], [years[j] for j in keep]
    n_years, n_plans = len(years), len(plans)
    groups = 2 if normal else 1
    n = groups * n_plans * n_years

    in_field = ctx.in_field
    lead_slot = in_field.crop if in_field else None
    first = make_slot(
        n,
        active=in_field is not None,
        window_start=0,
        window_end=0,
        sowing=Sowing.ASAP,
        duration=in_field.duration if in_field else 1,
        stage_ends=lead_slot.stage_ends(in_field.duration) if in_field else (1, 1, 1, 1),
        kc=lead_slot.kc if in_field else (0.0, 0.0, 0.0),
        root_m=lead_slot.root_m if in_field else 0.2,
        p=lead_slot.p if in_field else 0.5,
        heat_c=None,
        irrigation=Irrigation.PROTECTIVE if in_field and in_field.entry.irrigations else Irrigation.NONE,
        max_irrigations=(in_field.entry.irrigations or 0) if in_field else 0,
    )
    mode = IRRIGATION[ctx.irrigation]

    def per_plan(values) -> np.ndarray:
        return np.tile(np.repeat(np.asarray(values), n_years, axis=0), (groups,) + (1,) * (np.ndim(values) - 1))

    second = Slot(
        active=np.ones(n, dtype=bool),
        window_start=per_plan([(day - ctx.start).days for _, day in plans]),
        window_end=per_plan([(ctx.windows[c.id][1] - ctx.start).days for c, _ in plans]),
        sowing=np.full(n, Sowing.ASAP if mode == Irrigation.FULL else Sowing.MOISTURE),
        duration=per_plan([c.duration for c, _ in plans]),
        stage_ends=per_plan([c.stage_ends() for c, _ in plans]),
        kc=per_plan([c.kc for c, _ in plans]).astype(float),
        root_m=per_plan([c.root_m for c, _ in plans]).astype(float),
        p=per_plan([c.p for c, _ in plans]).astype(float),
        heat_c=per_plan([np.nan if c.heat_c is None else c.heat_c for c, _ in plans]).astype(float),
        irrigation=np.full(n, int(mode)),
        max_irrigations=np.full(n, ctx.settings["protective_irrigations"]),
    )
    year_rows = np.array([known[y] for y in years])
    index = np.concatenate([np.full(n_plans * n_years, current)] + ([np.tile(year_rows, n_plans)] if normal else []))
    start_state = _pick(states, index)
    growing = np.where(np.asarray(start_state.crop_slot) >= 0, 0, -1) if in_field else np.full(n, -1)
    start_state = SoilState(
        start_state.root_zone_mm,
        start_state.below_mm,
        start_state.root_depth_m,
        start_state.surface_depletion_mm,
        growing,
        start_state.crop_age_days,
    )
    rain, et0, tmax = gather(weather, positions, span)
    results, _ = simulate(
        rain,
        et0,
        tmax,
        [first, second],
        soil_of(ctx.farm),
        turnaround_days=ctx.settings["turnaround_days"],
        sowing_rain_mm=ctx.settings["sowing_rain_mm"],
        sowing_soil_fraction=ctx.settings["sowing_soil_fraction"],
        start=start_state,
        columns=np.tile(np.arange(n_years), groups * n_plans),
    )
    block = n_plans * n_years
    actual = take(results[1], slice(0, block))
    normal_result = take(results[1], slice(block, 2 * block)) if normal else None
    return Futures(years, plans, actual, normal_result, rain)


def _effects(ctx: Context, crop: CropParams, sowing: date) -> list[rules.Effect]:
    return rules.evaluate(crop, sowing, past_crops(ctx.history, ctx.farm.region), ctx.farm.region)


def _evaluate(ctx: Context, futures: Futures, mask: np.ndarray | None = None) -> dict[str, list]:
    """Outcomes for every (crop, sowing date) plan: actual soil, and normal soil when simulated."""
    n_years = len(futures.years)
    keep = np.ones(n_years, dtype=bool) if mask is None else mask
    years = [y for y, k in zip(futures.years, keep, strict=True) if k]
    n_price = economics_settings(ctx.farm.region)["n_price_per_kg"]
    out: dict[str, list] = {}
    for p, (crop, day) in enumerate(futures.plans):
        effects = _effects(ctx, crop, day)
        factor, _ = rules.combine(effects)
        rows = np.arange(p * n_years, (p + 1) * n_years)[keep]
        common = {"factor": factor, "effects": effects, "n_price": n_price, "reference": ctx.start, "lead": 0}
        window = ctx.windows[crop.id]
        actual = crop_outcome(crop, take(futures.actual, rows), years, window=window, **common)
        normal = (
            crop_outcome(crop, take(futures.normal, rows), years, window=window, **common)
            if futures.normal is not None
            else None
        )
        out.setdefault(crop.id, []).append((day, actual, normal, effects))
    return out


def _best(plans: list) -> tuple:
    """The sowing date with the best mean income (fewer failures on ties)."""
    return max(plans, key=lambda plan: (np.nan_to_num(plan[1][1]["income_mean"], nan=-1e12), -plan[1][1]["failure"]))


def _diversity(ctx: Context, crop: CropParams) -> float:
    last = max(ctx.history, key=lambda e: e.sow_date, default=None)
    families = {c.family for c in (crop_params(ctx.farm.region, i) for i in (last.crops if last else ())) if c}
    return 0.0 if crop.family in families else 1.0


def _planting(crop: CropParams, summary: dict, day: date) -> tuple:
    return crop, tuple(summary["yield"][f"p{q}"] or 0 for q in (10, 50, 90)), day


def simulate_next_crop(farm: FarmInputs, season: str | None, irrigation: str, today: date) -> dict:
    """Weight-independent part of the advice (cacheable): every crop's best sowing date and its outcomes."""
    weather = prepare_weather(farm.frame, farm.lat, farm.elevation_m, historical_through=farm.historical_through)
    ctx = _context(farm, weather, season, irrigation, today)
    states, state_years, current = _soil_on_start(ctx, weather)
    futures = _futures(ctx, weather, states, state_years, current, normal=True)
    evaluated = _evaluate(ctx, futures)

    crops, plantings = [], []
    for crop in ctx.candidates:
        plans = evaluated[crop.id]
        day, (summary, ind), (normal_summary, _), effects = _best(plans)
        _, blocked = rules.combine(effects)
        summary = {
            **summary,
            "blocked": blocked,
            "sowing": {
                **summary["sowing"],
                "best": day.isoformat(),
                "options": [
                    {
                        "date": d.isoformat(),
                        "failure": s["yield"]["failure"],
                        "p50": s["yield"]["p50"],
                        "income_mean": s["income"]["mean"],
                    }
                    for d, (s, _), _, _ in plans
                ],
            },
            "normal": {
                "failure": normal_summary["yield"]["failure"],
                "p50": normal_summary["yield"]["p50"],
                "income_mean": normal_summary["income"]["mean"],
                "water_met": normal_summary["water"]["met"],
            },
        }
        ind = {**ind, "diversity": _diversity(ctx, crop)}
        crops.append({"summary": summary, "indicators": ind})
        plantings.append(_planting(crop, summary, day))

    carbon_by_crop, carbon = season_carbon(farm, weather, ctx.history, ctx.start, ctx.settings, ctx.season, plantings)
    for item, value in zip(crops, carbon_by_crop or [None] * len(crops), strict=True):
        item["summary"]["carbon"] = value
        item["indicators"]["soc_change"] = value["kept"]["mid"] if value else 0.0

    econ = economics_settings(farm.region)
    return {
        "kind": "next_crop",
        "season": ctx.season,
        "season_year": ctx.year,
        "irrigation": irrigation,
        "as_of": ctx.as_of.isoformat(),
        "earliest_sowing": ctx.ready.isoformat(),
        "period": {"first_year": futures.years[0], "last_year": futures.years[-1], "n_years": len(futures.years)},
        "soil_now": _soil_summary(farm, states, current, ctx.replay, ctx.start),
        "in_field": None
        if ctx.in_field is None
        else {
            "crop": ctx.in_field.crop.id,
            "sow_date": ctx.in_field.entry.sow_date.isoformat(),
            "expected_harvest": (ctx.ready - timedelta(days=ctx.settings["turnaround_days"])).isoformat(),
        },
        "carbon": carbon,
        "economics": {"currency": econ["currency"], "validated": econ["validated"]},
        "confidence": scoring.confidence(
            pack_validated=econ["validated"],
            awc_source=farm.awc_source,
            has_carbon=carbon is not None,
            n_years=len(futures.years),
            has_history=bool(ctx.history),
        ),
        "crops": crops,
        "excluded": ctx.excluded,
    }


INDICATORS = (
    "income_mean",
    "income_p10",
    "failure",
    "irrigation_mm",
    "water_productivity",
    "soc_change",
    "n_fixed",
    "cover_months",
    "diversity",
    "pest_flags",
)


def indicator_arrays(items: list[dict]) -> dict[str, np.ndarray]:
    def value(item: dict, key: str) -> float:
        ind = item["indicators"]
        if key == "water_productivity":
            eta = ind.get("eta_mm") or np.nan
            return ind.get("gross_mean", np.nan) / eta if eta and np.isfinite(eta) and eta > 0 else np.nan
        raw = ind.get(key)
        return np.nan if raw is None else float(raw)

    return {key: np.array([value(item, key) for item in items]) for key in INDICATORS}


def rank(run: dict, weights: dict | None) -> dict:
    """Order a simulated run by the farmer's priorities; blocked and near-certain-failure crops are listed apart."""
    w = scoring.clean_weights(weights)
    items = run["crops"]
    open_items = [item for item in items if not item["summary"]["blocked"]]
    viable = [item for item in open_items if not scoring.unsuitable(item["indicators"]["failure"])]
    ranked = []
    if viable:
        ind = indicator_arrays(viable)
        pillars = scoring.pillar_scores(ind)
        score = scoring.weighted_score(pillars, w)
        front = scoring.pareto_front(pillars)
        order = np.argsort(-score, kind="stable")
        for position, i in enumerate(order, start=1):
            ranked.append(
                {
                    **viable[i]["summary"],
                    "rank": position,
                    "score": round(float(score[i]), 3),
                    "comparable_pillars": [key for key in scoring.PILLARS if np.ptp(pillars[key]) > 1e-9],
                    "pillars": {key: round(float(pillars[key][i]), 2) for key in scoring.PILLARS},
                    "pareto": bool(front[i]),
                    "reasons": scoring.pillar_reasons(pillars, ind, i),
                }
            )
    blocked = [item["summary"] for item in items if item["summary"]["blocked"]]
    unsuitable = [item["summary"] for item in open_items if scoring.unsuitable(item["indicators"]["failure"])]
    rest = {k: v for k, v in run.items() if k != "crops"}
    return {**rest, "weights": w, "options": ranked, "blocked": blocked, "unsuitable": unsuitable}


def stress_test(farm: FarmInputs, season: str | None, irrigation: str, today: date, weights: dict | None) -> dict:
    """Rank of every crop under each scenario; a crop is robust when it stays in the top 3 in all of them."""
    w = scoring.clean_weights(weights)
    base_weather = prepare_weather(farm.frame, farm.lat, farm.elevation_m, historical_through=farm.historical_through)
    ctx = _context(farm, base_weather, season, irrigation, today)
    states, state_years, current = _soil_on_start(ctx, base_weather)
    soil: dict[str, dict] = {}

    def ranked(evaluated: dict) -> dict[str, dict]:
        best = {crop_id: _best(plans) for crop_id, plans in evaluated.items()}
        open_ids = [crop_id for crop_id, plan in best.items() if not rules.combine(plan[3])[1]]
        ids = [crop_id for crop_id in open_ids if not scoring.unsuitable(best[crop_id][1][1]["failure"])]
        items = [{"indicators": {**best[i][1][1], **soil[i]}} for i in ids]
        score = scoring.weighted_score(scoring.pillar_scores(indicator_arrays(items)), w) if items else []
        position = {ids[j]: p for p, j in enumerate(np.argsort(-np.asarray(score), kind="stable"), start=1)}
        out = {}
        for crop_id in open_ids:
            summary = best[crop_id][1][0]
            out[crop_id] = {
                "rank": position.get(crop_id),
                "failure": summary["yield"]["failure"],
                "p50": summary["yield"]["p50"],
                "income_mean": summary["income"]["mean"],
                "income_p10": summary["income"]["p10"],
            }
        return out

    baseline_futures = _futures(ctx, base_weather, states, state_years, current, normal=False)
    baseline = _evaluate(ctx, baseline_futures)
    # Soil indicators come from past weather in every scenario, as in the advice itself.
    best = {crop.id: _best(baseline[crop.id]) for crop in ctx.candidates}
    plantings = [_planting(crop, best[crop.id][1][0], best[crop.id][0]) for crop in ctx.candidates]
    carbon, _ = season_carbon(farm, base_weather, ctx.history, ctx.start, ctx.settings, ctx.season, plantings)
    for crop, value in zip(ctx.candidates, carbon or [None] * len(ctx.candidates), strict=True):
        soil[crop.id] = {"diversity": _diversity(ctx, crop), "soc_change": value["kept"]["mid"] if value else 0.0}

    scenarios: dict[str, dict] = {"baseline": ranked(baseline)}
    for scenario in DELTAS:
        weather = prepare_weather(
            farm.frame, farm.lat, farm.elevation_m, scenario.warming_c, scenario.rain_factor, farm.historical_through
        )
        scenarios[scenario.key] = ranked(_evaluate(ctx, _futures(ctx, weather, states, state_years, current, False)))
    scenarios["driest"] = ranked(_evaluate(ctx, baseline_futures, driest_years(baseline_futures.rain)))
    if ctx.season == "kharif" and ctx.start <= date(ctx.year, 7, 15):
        rain_series = pd.Series(base_weather.rain, index=base_weather.index)
        late = late_onset_years(rain_series, baseline_futures.years)
        if late is not None:
            scenarios["late_onset"] = ranked(_evaluate(ctx, baseline_futures, late))

    def rank_in(scenario: dict, crop_id: str) -> int:
        return (scenario.get(crop_id) or {}).get("rank") or 99

    baseline = scenarios["baseline"]
    top = sorted((i for i in baseline if baseline[i]["rank"] is not None), key=lambda i: baseline[i]["rank"])[:TOP_N]
    return {
        "kind": "next_crop",
        "season": ctx.season,
        "season_year": ctx.year,
        "irrigation": irrigation,
        "weights": w,
        "scenarios": list(scenarios),
        "crops": [
            {
                "id": crop_id,
                "robust": all(rank_in(s, crop_id) <= 3 for s in scenarios.values()),
                "results": {key: s.get(crop_id) for key, s in scenarios.items()},
            }
            for crop_id in top
        ],
    }
