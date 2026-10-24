"""Crop fit: how each crop of a region pack would do on one farm in one season, across every past year.

For each historical year the farm's real previous crop is replayed on its recorded dates, then each
candidate is sown by the pack's rules (sowing rain or stored moisture for rain-fed crops) and simulated with
the FAO-56 water balance. Yields combine water deficit, flowering heat and the succession rules; income,
nitrogen and 10-year soil carbon (RothC) are added per crop.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from engine.crops.catalog import crop_params, economics_settings, load_catalog, simulation_settings
from engine.models.water import Irrigation, Slot, SoilWater, Sowing, make_slot, simulate
from engine.planner import rules
from engine.planner.common import (
    IRRIGATION,
    FarmInputs,
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
from engine.planner.outcomes import crop_outcome, season_carbon, take

LEAD_DAYS = 150  # simulated fallow before the season so the soil starts from that year's weather
SPIN_UP_DAYS = 60  # ... or before the previous crop when it is replayed
CARRY_OVER_DAYS = 240  # a crop harvested longer before the season leaves no stored water worth modelling


def candidate_slot(candidates, starts, ends, n_years: int, mode: Irrigation, protective_max: int) -> Slot:
    """One slot holding every candidate crop, each repeated over the weather years."""

    def per_crop(values) -> np.ndarray:
        return np.repeat(np.asarray(values), n_years, axis=0)

    n = n_years * len(candidates)
    return Slot(
        active=np.ones(n, dtype=bool),
        window_start=per_crop(starts),
        window_end=per_crop(ends),
        sowing=np.full(n, Sowing.ASAP if mode == Irrigation.FULL else Sowing.MOISTURE),
        duration=per_crop([c.duration for c in candidates]),
        stage_ends=per_crop([c.stage_ends() for c in candidates]),
        kc=per_crop([c.kc for c in candidates]).astype(float),
        root_m=per_crop([c.root_m for c in candidates]).astype(float),
        p=per_crop([c.p for c in candidates]).astype(float),
        heat_c=per_crop([np.nan if c.heat_c is None else c.heat_c for c in candidates]).astype(float),
        irrigation=np.full(n, int(mode)),
        max_irrigations=np.full(n, protective_max),
    )


def soil_of(farm: FarmInputs) -> SoilWater:
    return SoilWater(farm.awc_mm_per_m, farm.depth_m, farm.tew_mm, min(9.0, 0.4 * farm.tew_mm))


def crop_fit(farm: FarmInputs, season: str | None, irrigation: str, today: date) -> dict:
    settings = simulation_settings(farm.region)
    n_price = economics_settings(farm.region)["n_price_per_kg"]
    catalog = load_catalog(farm.region)
    season = season or default_season(today)
    candidates = [
        params
        for crop in catalog["crops"]
        if season in crop["seasons"] and (params := crop_params(farm.region, crop["id"])) is not None
    ]
    if not candidates:
        raise ValueError(f"No crops in this pack are sown in the {season} season")
    year = season_instance(season, candidates, today)
    windows = {c.id: window_dates(c.sowing[season], season, year) for c in candidates}
    reference = min(start for start, _ in windows.values())
    turnaround = settings["turnaround_days"]

    history = [entry for entry in farm.history if entry.status != "planned"]
    previous = max((e for e in history if e.sow_date < reference), key=lambda e: e.sow_date, default=None)
    prev_crop = main_crop(previous, farm.region) if previous else None
    prev_end = end_date(previous, farm.region) if previous else None
    replay = prev_crop is not None and prev_end >= reference - timedelta(days=CARRY_OVER_DAYS)
    prev_offset = (previous.sow_date - reference).days if replay else 0
    prev_days = max((prev_end - previous.sow_date).days, 1) if replay else 1

    lead = max(LEAD_DAYS, SPIN_UP_DAYS - prev_offset)
    starts = np.array([(windows[c.id][0] - reference).days for c in candidates]) + lead
    ends = np.array([(windows[c.id][1] - reference).days for c in candidates]) + lead
    busy_until = lead + prev_offset + prev_days + turnaround if replay else 0
    span = int(max(ends.max(), busy_until) + max(c.duration for c in candidates) + 30)

    weather = prepare_weather(farm.frame, farm.lat, farm.elevation_m)
    anchor = reference - timedelta(days=lead)
    positions, run_years = year_starts(weather, anchor, span)
    years = [y + reference.year - anchor.year for y in run_years]
    n_years, n_crops = len(years), len(candidates)
    n = n_years * n_crops

    previous_slot = make_slot(
        n,
        active=replay,
        window_start=lead + prev_offset,
        window_end=lead + prev_offset,
        sowing=Sowing.ASAP,
        duration=prev_days,
        stage_ends=prev_crop.stage_ends(prev_days) if replay else (1, 1, 1, 1),
        kc=prev_crop.kc if replay else (0.0, 0.0, 0.0),
        root_m=prev_crop.root_m if replay else 0.2,
        p=prev_crop.p if replay else 0.5,
        heat_c=None,
        irrigation=Irrigation.PROTECTIVE if replay and previous.irrigations else Irrigation.NONE,
        max_irrigations=(previous.irrigations or 0) if replay else 0,
    )
    slot = candidate_slot(candidates, starts, ends, n_years, IRRIGATION[irrigation], settings["protective_irrigations"])
    results, _ = simulate(
        *gather(weather, positions, span),
        [previous_slot, slot],
        soil_of(farm),
        turnaround_days=turnaround,
        sowing_rain_mm=settings["sowing_rain_mm"],
        sowing_soil_fraction=settings["sowing_soil_fraction"],
        initial_fraction=0.0,  # the run starts in the dry season; the lead-in refills the soil from the top
        columns=np.tile(np.arange(n_years), n_crops),
    )

    past = past_crops(history, farm.region)
    prev_ready = prev_end + timedelta(days=turnaround) if previous else None
    crops_out = []
    for i, crop in enumerate(candidates):
        start, end = windows[crop.id]
        planned = max(start, prev_ready) if prev_ready else start
        effects = rules.evaluate(crop, planned, past, farm.region)
        if prev_ready and prev_ready > end:
            facts = {"crop": previous.crops[0], "ready": prev_ready.isoformat(), "window_end": end.isoformat()}
            effects.append(rules.Effect("calendar", "warning", severity="high", facts=facts))
        if today > end:
            effects.append(rules.Effect("window_passed", "warning", facts={"window_end": end.isoformat()}))
        factor, blocked = rules.combine(effects)
        summary, _ = crop_outcome(
            crop,
            take(results[1], slice(i * n_years, (i + 1) * n_years)),
            years,
            factor=factor,
            effects=effects,
            n_price=n_price,
            reference=reference,
            lead=lead,
            window=(start, end),
        )
        crops_out.append({**summary, "blocked": blocked, "succession_factor": round(factor, 3)})

    plantings = [
        (
            crop,
            tuple(out["yield"][f"p{q}"] or 0 for q in (10, 50, 90)),
            date(2001, *map(int, out["sowing"]["median"].split("-"))) if out["sowing"]["median"] else reference,
        )
        for crop, out in zip(candidates, crops_out, strict=True)
    ]
    carbon_by_crop, carbon = season_carbon(farm, weather, history, reference, settings, season, plantings)
    if carbon_by_crop:
        for out, value in zip(crops_out, carbon_by_crop, strict=True):
            out["carbon"] = value

    crops_out.sort(key=lambda o: (o["blocked"], o["yield"]["failure"]["p"] or 0, -o["yield"]["relative"]))
    return {
        "season": season,
        "season_year": year,
        "irrigation": irrigation,
        "period": {"first_year": years[0], "last_year": years[-1], "n_years": n_years},
        "soil": {"awc_mm": round(farm.awc_mm_per_m), "depth_m": farm.depth_m, "source": farm.awc_source},
        "previous": None
        if previous is None
        else {
            "crops": list(previous.crops),
            "sow_date": previous.sow_date.isoformat(),
            "end_date": prev_end.isoformat(),
            "harvested": previous.status == "harvested",
            "replayed": replay,
        },
        "carbon": carbon,
        "crops": crops_out,
    }
