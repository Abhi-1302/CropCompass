"""Rotation explorer: two-year crop sequences ranked by the farmer's priorities (docs/PLAN.md 5.5 and 7.7).

Each agricultural year (kharif -> rabi -> summer) is simulated once per cropping pattern, carrying soil water from
season to season; a two-year rotation joins two patterns in consecutive historical years. The long dry season
empties the soil of monsoon farms, so water is not carried from one agricultural year to the next. Succession
rules apply inside each year, between the two years and against the farm's journal.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, replace
from datetime import date, timedelta

import numpy as np

from engine.crops.catalog import CropParams, crop_params, economics_settings, load_catalog, simulation_settings
from engine.models import nitrogen, rothc
from engine.models.crop_yield import FAILURE_SHARE, relative_yield
from engine.models.water import Irrigation, Slot, Sowing, simulate
from engine.planner import rules, scoring
from engine.planner.common import (
    IRRIGATION,
    FarmInputs,
    JournalEntry,
    PracticeItem,
    Weather,
    carbon_item,
    current_practice,
    gather,
    md,
    monthly_climate,
    past_crops,
    prepare_weather,
    season_instance,
    shift_years,
    window_dates,
    year_starts,
)
from engine.planner.cropfit import soil_of
from engine.planner.scenarios import DELTAS

SEASONS = ("kharif", "rabi", "summer")
LEAD_DAYS = 150
KEEP = {"kharif": 8, "rabi": 7}
SUMMER_KEEP = {"rainfed": 0, "protective": 2, "full": 3}
POOL = 30  # one-year patterns combined into rotations
TOP = 10
SLACK_DAYS = 15  # a crop may still follow the previous one this long after its window closes
DAYS_PER_MONTH = 30.44
CARBON_YEARS = 10
ROBUST_RANK = 3
DRIEST_SHARE = 0.2


@dataclass(frozen=True)
class Pattern:
    crops: tuple  # CropParams or None (fallow) for kharif, rabi, summer

    @property
    def key(self) -> str:
        return "+".join(c.id if c else "fallow" for c in self.crops)


@dataclass(frozen=True)
class YearSims:
    years: list[int]
    share: np.ndarray  # (patterns, 3 seasons, years) yield share before succession effects; 0 without a crop
    active: np.ndarray  # (patterns, 3)
    eta: np.ndarray
    irrigation: np.ndarray
    sow: np.ndarray  # day offsets from the kharif reference date
    harvest: np.ndarray  # -1 when not harvested


@dataclass(frozen=True)
class RotationRun:
    farm: FarmInputs
    irrigation: str
    year: int  # season year of the first kharif
    reference: date
    windows: dict
    settings: dict
    history: list[JournalEntry]
    patterns: list[Pattern]
    sims: YearSims
    current: int | None  # index of the current practice among the patterns
    current_items: list[PracticeItem]
    current_source: str
    weather: Weather


def _windows(crops: dict[str, list[CropParams]], year: int) -> dict:
    out = {}
    for season, items in crops.items():
        instance = year + 1 if season == "summer" else year
        for crop in items:
            out[(season, crop.id)] = window_dates(crop.sowing[season], season, instance)
    return out


def _calendar(pattern: Pattern, windows: dict, turnaround: int, shift: int = 0) -> list[date | None] | None:
    """Planned sowing date of each crop, or None when a crop can't fit after the one before it."""
    dates, ready = [], None
    for season, crop in zip(SEASONS, pattern.crops, strict=True):
        if crop is None:
            dates.append(None)
            continue
        start, end = (shift_years(d, shift) for d in windows[(season, crop.id)])
        sow = max(start, ready) if ready else start
        if sow > end + timedelta(days=SLACK_DAYS):
            return None
        dates.append(sow)
        ready = sow + timedelta(days=crop.duration + turnaround)
    return dates


def _slot(patterns: list[Pattern], s: int, windows, reference, n_years, mode, protective_max) -> Slot:
    season = SEASONS[s]
    crops = [p.crops[s] for p in patterns]
    stand_in = next(c for p in patterns for c in p.crops if c is not None)

    def rep(values) -> np.ndarray:
        return np.repeat(np.asarray(values), n_years, axis=0)

    def offsets(edge: int) -> list[int]:
        return [LEAD_DAYS + (windows[(season, c.id)][edge] - reference).days if c else 0 for c in crops]

    filled = [c or stand_in for c in crops]
    n = n_years * len(patterns)
    return Slot(
        active=rep([c is not None for c in crops]),
        window_start=rep(offsets(0)),
        window_end=rep(offsets(1)),
        sowing=np.full(n, Sowing.ASAP if mode == Irrigation.FULL else Sowing.MOISTURE),
        duration=rep([c.duration for c in filled]),
        stage_ends=rep([c.stage_ends() for c in filled]),
        kc=rep([c.kc for c in filled]).astype(float),
        root_m=rep([c.root_m for c in filled]).astype(float),
        p=rep([c.p for c in filled]).astype(float),
        heat_c=rep([np.nan if c.heat_c is None else c.heat_c for c in filled]).astype(float),
        irrigation=np.full(n, int(mode)),
        max_irrigations=np.full(n, protective_max),
    )


def _simulate_patterns(farm, weather, settings, irrigation, windows, reference, patterns) -> YearSims:
    mode = IRRIGATION[irrigation]
    latest = max(
        (windows[(SEASONS[s], c.id)][1] - reference).days + c.duration
        for p in patterns
        for s, c in enumerate(p.crops)
        if c is not None
    )
    span = LEAD_DAYS + latest + 60
    anchor = reference - timedelta(days=LEAD_DAYS)
    positions, run_years = year_starts(weather, anchor, span)
    years = [y + reference.year - anchor.year for y in run_years]
    n_years, n_pat = len(years), len(patterns)
    slots = [
        _slot(patterns, s, windows, reference, n_years, mode, settings["protective_irrigations"]) for s in range(3)
    ]
    results, _ = simulate(
        *gather(weather, positions, span),
        slots,
        soil_of(farm),
        turnaround_days=settings["turnaround_days"],
        sowing_rain_mm=settings["sowing_rain_mm"],
        sowing_soil_fraction=settings["sowing_soil_fraction"],
        initial_fraction=0.0,
        columns=np.tile(np.arange(n_years), n_pat),
    )
    shape = (n_pat, n_years)
    share, eta, irr, sow, harvest = (np.zeros((n_pat, 3, n_years)) for _ in range(5))
    for s, result in enumerate(results):
        ky = np.repeat([p.crops[s].ky if p.crops[s] else 1.0 for p in patterns], n_years)
        rel = relative_yield(
            result.eta_mm, result.etc_mm, ky, result.heat_damage, 1.0, result.eta_flowering_mm, result.etc_flowering_mm
        )
        done = (result.harvest_day >= 0) & slots[s].active
        share[:, s] = np.where(done, rel, 0.0).reshape(shape)
        eta[:, s] = np.where(slots[s].active, result.eta_mm, 0.0).reshape(shape)
        irr[:, s] = result.irrigation_mm.reshape(shape)
        sow[:, s] = (result.sow_day - LEAD_DAYS).reshape(shape)
        harvest[:, s] = np.where(result.harvest_day >= 0, result.harvest_day - LEAD_DAYS, -1).reshape(shape)
    active = np.array([[c is not None for c in p.crops] for p in patterns])
    return YearSims(years, share, active, eta, irr, sow, harvest)


def _candidates(farm: FarmInputs, irrigation: str) -> dict[str, list[CropParams]]:
    catalog = load_catalog(farm.region)
    out = {}
    for season in SEASONS:
        allowed = season != "summer" or SUMMER_KEEP[irrigation] > 0
        out[season] = [
            params
            for crop in catalog["crops"]
            if allowed and season in crop["seasons"] and (params := crop_params(farm.region, crop["id"])) is not None
        ]
    return out


def _screen(farm, weather, settings, irrigation, windows, reference, crops, current_items) -> dict:
    """Keep the crops most likely to make good rotations: fewest failures, then best income per season."""
    singles = [
        Pattern(tuple(crop if i == s else None for i in range(3)))
        for s, season in enumerate(SEASONS)
        for crop in crops[season]
    ]
    sims = _simulate_patterns(farm, weather, settings, irrigation, windows, reference, singles)
    n_price = economics_settings(farm.region)["n_price_per_kg"]
    kept = {}
    for s, season in enumerate(SEASONS):
        scored = []
        for i, pattern in enumerate(singles):
            crop = pattern.crops[s]
            if crop is None:
                continue
            share = sims.share[i, s]
            income = share * (crop.ym or 0) * crop.price - crop.cost - crop.n_rec * n_price
            scored.append(((share < FAILURE_SHARE).mean(), -income.mean(), crop))
        scored.sort(key=lambda item: item[:2])
        limit = SUMMER_KEEP[irrigation] if season == "summer" else KEEP[season]
        chosen = [crop for *_, crop in scored[:limit]]
        extras = [item.crop for item in current_items if item.season == season]
        extras += [crop for *_, crop in scored if crop.n_fixed > 0 and not crop.green_manure][:1]
        if season == "kharif":
            extras += [crop for crop in crops[season] if crop.green_manure]
        for crop in extras:
            if crop in crops[season] and crop not in chosen:
                chosen.append(crop)
        kept[season] = chosen
    return kept


def simulate_rotations(farm: FarmInputs, irrigation: str, today: date) -> RotationRun:
    """Weight-independent part of the explorer (cacheable): every feasible one-year pattern, simulated."""
    settings = simulation_settings(farm.region)
    turnaround = settings["turnaround_days"]
    history = [entry for entry in farm.history if entry.status != "planned"]
    weather = prepare_weather(farm.frame, farm.lat, farm.elevation_m, historical_through=farm.historical_through)
    crops = _candidates(farm, irrigation)
    year = season_instance("kharif", crops["kharif"], today)
    windows = _windows(crops, year)
    reference = min(start for (season, _), (start, _) in windows.items() if season == "kharif")
    current_items, source = current_practice(farm, history, reference, settings)
    kept = _screen(farm, weather, settings, irrigation, windows, reference, crops, current_items)

    patterns = [
        Pattern(combo)
        for combo in itertools.product(*([None, *kept[season]] for season in SEASONS))
        if any(combo) and _calendar(Pattern(combo), windows, turnaround) is not None
    ]
    by_season = {item.season: item.crop for item in current_items if (item.season, item.crop.id) in windows}
    current = Pattern(tuple(by_season.get(season) for season in SEASONS))
    current_index = next((i for i, p in enumerate(patterns) if p.key == current.key), None)
    if current_index is None and any(current.crops) and _calendar(current, windows, turnaround) is not None:
        patterns.append(current)
        current_index = len(patterns) - 1
    sims = _simulate_patterns(farm, weather, settings, irrigation, windows, reference, patterns)
    return RotationRun(
        farm,
        irrigation,
        year,
        reference,
        windows,
        settings,
        history,
        patterns,
        sims,
        current_index,
        current_items,
        source,
        weather,
    )


def _effects(run: RotationRun, pattern: Pattern, history: list[rules.PastCrop], shift: int):
    """Rule effects for each crop of `pattern` placed `shift` years after the explorer's first year."""
    dates = _calendar(pattern, run.windows, run.settings["turnaround_days"], shift)
    out, past = [], list(history)
    for crop, sow in zip(pattern.crops, dates, strict=True):
        if crop is None:
            out.append([])
            continue
        out.append(rules.evaluate(crop, sow, past, run.farm.region))
        past.append(rules.PastCrop((crop.id,), sow, sow + timedelta(days=crop.duration)))
    return out, past[len(history) :]


def _slot_terms(pattern: Pattern, effects: list[list[rules.Effect]], n_price: float):
    """Yield factor and money cost (with nitrogen after credits) per season, and whether a rule blocks it."""
    factors, costs, blocked = np.ones(3), np.zeros(3), False
    for s, crop in enumerate(pattern.crops):
        if crop is None:
            continue
        factor, block = rules.combine(effects[s])
        credit = -sum(e.n_kg for e in effects[s] if e.n_kg < 0)
        extra = sum(e.n_kg for e in effects[s] if e.n_kg > 0)
        factors[s] = factor
        costs[s] = crop.cost + nitrogen.fertiliser_need(crop, credit, extra) * n_price
        blocked |= block
    return factors, costs, blocked


@dataclass(frozen=True)
class PairResult:
    a: int
    b: int
    metrics: dict
    effects: list  # (year index, season, effect)
    seasons: list  # per year: season details
    blocked: bool
    shares: tuple  # (year-1 shares (3, pairs), year-2 shares (3, pairs)) after succession effects


def _year_pairs(sims: YearSims, keep: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    first = np.arange(len(sims.years) - 1)
    if keep is not None:
        first = first[keep]
    return first, first + 1


def _evaluate_pairs(run: RotationRun, pairs, sims: YearSims, year_pairs) -> list[PairResult]:
    n_price = economics_settings(run.farm.region)["n_price_per_kg"]
    history = past_crops(run.history, run.farm.region)
    ya, yb = year_pairs
    first_year = {}
    for a in {a for a, _ in pairs}:
        effects, placed = _effects(run, run.patterns[a], history, 0)
        first_year[a] = (effects, placed, *_slot_terms(run.patterns[a], effects, n_price))
    out = []
    for a, b in pairs:
        pa, pb = run.patterns[a], run.patterns[b]
        eff_a, placed_a, f_a, cost_a, block_a = first_year[a]
        eff_b, _ = _effects(run, pb, history + placed_a, 1)
        f_b, cost_b, block_b = _slot_terms(pb, eff_b, n_price)
        share_a = sims.share[a][:, ya] * f_a[:, None]
        share_b = sims.share[b][:, yb] * f_b[:, None]
        value_a = np.array([(c.ym or 0) * c.price if c else 0.0 for c in pa.crops])
        value_b = np.array([(c.ym or 0) * c.price if c else 0.0 for c in pb.crops])
        gross = (share_a * value_a[:, None]).sum(axis=0) + (share_b * value_b[:, None]).sum(axis=0)
        income = (gross - cost_a.sum() - cost_b.sum()) / 2  # per year
        act_a, act_b = sims.active[a][:, None], sims.active[b][:, None]
        fails = ((share_a < FAILURE_SHARE) & act_a).sum() + ((share_b < FAILURE_SHARE) & act_b).sum()
        grown = (act_a.sum() + act_b.sum()) * len(ya)
        eta = sims.eta[a][:, ya].sum(axis=0) + sims.eta[b][:, yb].sum(axis=0)
        irrigation = (sims.irrigation[a][:, ya].sum(axis=0) + sims.irrigation[b][:, yb].sum(axis=0)) / 2
        crops = [c for c in (*pa.crops, *pb.crops) if c is not None]
        n_fixed = sum(
            nitrogen.fixed(c, float(np.median(sh)))
            for pattern, shares in ((pa, share_a), (pb, share_b))
            for c, sh in zip(pattern.crops, shares, strict=True)
            if c is not None
        )
        effects = [(0, SEASONS[s], e) for s in range(3) for e in eff_a[s]]
        effects += [(1, SEASONS[s], e) for s in range(3) for e in eff_b[s]]
        metrics = {
            "income_mean": float(income.mean()),
            "income_p10": float(np.percentile(income, 10)),
            "income_p90": float(np.percentile(income, 90)),
            "gross_mean": float(gross.mean() / 2),
            "eta_mm": float(eta.mean() / 2),
            "failure": float(fails / grown) if grown else 1.0,
            "irrigation_mm": float(irrigation.mean()),
            "n_fixed": n_fixed / 2,
            "cover_months": sum(c.duration for c in crops) / DAYS_PER_MONTH / 2,
            "diversity": float(len({c.family for c in crops if c.family})),
            "pest_flags": float(sum(1 for _, _, e in effects if e.kind == "risk")),
        }
        detail = []
        for y, (pattern, shares, idx) in enumerate(((pa, share_a, a), (pb, share_b, b))):
            seasons = []
            for s, crop in enumerate(pattern.crops):
                if crop is None:
                    seasons.append({"season": SEASONS[s], "crop": None})
                    continue
                done = sims.harvest[idx, s] >= 0
                seasons.append(
                    {
                        "season": SEASONS[s],
                        "crop": crop.id,
                        "sow": md(run.reference + timedelta(days=float(np.median(sims.sow[idx, s][done]))))
                        if done.any()
                        else None,
                        "harvest": md(run.reference + timedelta(days=float(np.median(sims.harvest[idx, s][done]))))
                        if done.any()
                        else None,
                        "p50": round(float(np.median(shares[s])) * (crop.ym or 0)),
                        "failure": round(float((shares[s] < FAILURE_SHARE).mean()), 2),
                    }
                )
            detail.append({"season_year": run.year + y, "seasons": seasons})
        out.append(PairResult(a, b, metrics, effects, detail, block_a or block_b, (share_a, share_b)))
    return out


def _pattern_carbon(run: RotationRun, pattern: Pattern, shares: np.ndarray, residues: dict, year_index: int):
    """24-month carbon inputs and cover of one year of a rotation; `shares` are yield shares per season."""
    dates = _calendar(pattern, run.windows, run.settings["turnaround_days"])
    inputs, cover = np.zeros(24), np.zeros(24, dtype=bool)
    for s, crop in enumerate(pattern.crops):
        if crop is None:
            continue
        item = PracticeItem(
            crop, SEASONS[s], float(shares[s]) * (crop.ym or 0), residues[SEASONS[s]], dates[s], crop.duration
        )
        carbon = carbon_item(item, 24, year_index)
        inputs, cover = inputs + carbon.inputs, cover | carbon.cover
    return inputs, cover


def _soc(run: RotationRun, results: list[PairResult], residue: str) -> np.ndarray:
    """10-year topsoil carbon change (low / mid / high yields) of each rotation against the current practice."""
    farm = run.farm
    if not farm.soc_t_ha or farm.clay_pct is None:
        return np.full((len(results), 3), np.nan)
    base_inputs, base_cover = np.zeros(12), np.zeros(12, dtype=bool)
    for item in run.current_items:
        carbon = carbon_item(item)
        base_inputs, base_cover = base_inputs + carbon.inputs, base_cover | carbon.cover
    recorded = {item.season: item.residue for item in run.current_items}
    inputs, covers = [], []
    for q in (10, 50, 90):
        for result in results:
            total, cover = np.zeros(24), np.zeros(24, dtype=bool)
            for year_index, (idx, shares) in enumerate(zip((result.a, result.b), result.shares, strict=True)):
                is_current = idx == run.current and result.a == result.b
                residues = {s: (recorded.get(s) if is_current else residue) for s in SEASONS}
                part = _pattern_carbon(run, run.patterns[idx], np.percentile(shares, q, axis=1), residues, year_index)
                total, cover = total + part[0], cover | part[1]
            inputs.append(total)
            covers.append(cover)
    deltas = rothc.soc_change_arrays(
        farm.soc_t_ha,
        farm.clay_pct,
        monthly_climate(farm.frame, run.weather.et0_series),
        base_inputs,
        base_cover,
        np.stack(inputs),
        np.stack(covers),
        CARBON_YEARS,
    )
    return deltas.reshape(3, len(results)).T


def _pool(run: RotationRun, weights: dict) -> list[int]:
    """Patterns most worth combining: a quick one-year score with the journal's rules."""
    n_price = economics_settings(run.farm.region)["n_price_per_kg"]
    history = past_crops(run.history, run.farm.region)
    rows = []
    for i, pattern in enumerate(run.patterns):
        effects, _ = _effects(run, pattern, history, 0)
        factors, costs, blocked = _slot_terms(pattern, effects, n_price)
        share = run.sims.share[i] * factors[:, None]
        value = np.array([(c.ym or 0) * c.price if c else 0.0 for c in pattern.crops])
        gross = (share * value[:, None]).sum(axis=0)
        income = gross - costs.sum()
        active = run.sims.active[i]
        grown = [c for c in pattern.crops if c is not None]
        eta = float(run.sims.eta[i].sum(axis=0).mean())
        rows.append(
            {
                "income_mean": np.nan if blocked else income.mean(),
                "income_p10": np.nan if blocked else np.percentile(income, 10),
                "failure": float(((share < FAILURE_SHARE) & active[:, None]).sum() / (active.sum() * share.shape[1])),
                "irrigation_mm": float(run.sims.irrigation[i].sum(axis=0).mean()),
                "water_productivity": float(gross.mean()) / eta if eta > 0 else np.nan,
                "soc_change": float(sum(c.duration for c in grown)),  # proxy: longer cover returns more carbon
                "n_fixed": float(sum(c.n_fixed for c in grown)),
                "cover_months": float(sum(c.duration for c in grown)),
                "diversity": float(len({c.family for c in grown})),
                "pest_flags": float(sum(1 for es in effects for e in es if e.kind == "risk")),
            }
        )
    arrays = {key: np.array([row[key] for row in rows], dtype=float) for key in rows[0]}
    score = np.nan_to_num(scoring.weighted_score(scoring.pillar_scores(arrays), weights), nan=-1.0)
    pool = [int(i) for i in np.argsort(-score, kind="stable")[:POOL]]
    if run.current is not None and run.current not in pool:
        pool.append(run.current)
    return pool


def _metric_arrays(results: list[PairResult], soc: np.ndarray) -> dict[str, np.ndarray]:
    keys = (
        "income_mean",
        "income_p10",
        "failure",
        "irrigation_mm",
        "n_fixed",
        "cover_months",
        "diversity",
        "pest_flags",
    )
    arrays = {key: np.array([r.metrics[key] for r in results]) for key in keys}
    gross = np.array([r.metrics["gross_mean"] for r in results])
    eta = np.array([r.metrics["eta_mm"] for r in results])
    arrays["water_productivity"] = np.divide(gross, eta, out=np.full(len(results), np.nan), where=eta > 0)
    arrays["soc_change"] = soc[:, 1]
    return arrays


def _describe(run: RotationRun, result: PairResult, soc_row: np.ndarray) -> dict:
    m = result.metrics
    notable = [
        {"year": y, "season": season, **effect.to_dict()}
        for y, season, effect in result.effects
        if effect.kind in ("penalty", "benefit", "block") or effect.severity == "high"
    ]
    soc = (
        None
        if np.isnan(soc_row[1])
        else {k: round(float(v), 1) for k, v in zip(("low", "mid", "high"), soc_row, strict=True)}
    )
    return {
        "key": f"{run.patterns[result.a].key}>{run.patterns[result.b].key}",
        "years": result.seasons,
        "blocked": result.blocked,
        "income": {"mean": round(m["income_mean"]), "p10": round(m["income_p10"]), "p90": round(m["income_p90"])},
        "water": {
            "irrigation_mm": round(m["irrigation_mm"]),
            "productivity": round(m["gross_mean"] / m["eta_mm"], 1) if m["eta_mm"] > 0 else None,
        },
        "soil": {
            "soc_change": soc,
            "n_fixed": round(m["n_fixed"]),
            "cover_months": round(m["cover_months"], 1),
            "families": int(m["diversity"]),
        },
        "risk": {"failure": round(m["failure"], 2), "pest_flags": int(m["pest_flags"])},
        "rules": notable,
    }


def _difference(option: dict, current: dict) -> dict:
    soc_option, soc_current = option["soil"]["soc_change"], current["soil"]["soc_change"]
    return {
        "income": option["income"]["mean"] - current["income"]["mean"],
        "income_p10": option["income"]["p10"] - current["income"]["p10"],
        "irrigation_mm": option["water"]["irrigation_mm"] - current["water"]["irrigation_mm"],
        "soc": None if not soc_option or not soc_current else round(soc_option["mid"] - soc_current["mid"], 1),
        "failure": round(option["risk"]["failure"] - current["risk"]["failure"], 2),
    }


def rank_rotations(run: RotationRun, weights: dict | None, residue: str = "incorporated") -> dict:
    w = scoring.clean_weights(weights)
    pool = _pool(run, w)
    pairs = [(a, b) for a in pool for b in pool]
    results = _evaluate_pairs(run, pairs, run.sims, _year_pairs(run.sims))
    soc = _soc(run, results, residue)
    open_idx = [i for i, r in enumerate(results) if not r.blocked]
    if not open_idx:
        raise ValueError("Every rotation is blocked by this field's history")
    arrays = {key: values[open_idx] for key, values in _metric_arrays(results, soc).items()}
    pillars = scoring.pillar_scores(arrays)
    score = scoring.weighted_score(pillars, w)
    front = scoring.pareto_front(pillars)
    ranking = [open_idx[j] for j in np.argsort(-score, kind="stable")]
    position = {i: rank for rank, i in enumerate(ranking, start=1)}
    local = {i: j for j, i in enumerate(open_idx)}

    def entry(i: int) -> dict:
        out = _describe(run, results[i], soc[i])
        if i not in local:
            return {**out, "rank": None}
        j = local[i]
        return {
            **out,
            "rank": position[i],
            "score": round(float(score[j]), 3),
            "comparable_pillars": [key for key in scoring.PILLARS if np.ptp(pillars[key]) > 1e-9],
            "pillars": {key: round(float(pillars[key][j]), 2) for key in scoring.PILLARS},
            "pareto": bool(front[j]),
            "reasons": scoring.pillar_reasons(pillars, arrays, j),
        }

    options = [entry(i) for i in ranking[:TOP]]
    current = None
    if run.current is not None:
        current = entry(pairs.index((run.current, run.current)))
        for option in options:
            option["vs_current"] = _difference(option, current)
    econ = economics_settings(run.farm.region)
    return {
        "kind": "rotation",
        "first_year": run.year,
        "irrigation": run.irrigation,
        "residue": residue,
        "weights": w,
        "period": {
            "first_year": run.sims.years[0],
            "last_year": run.sims.years[-1],
            "n_pairs": len(run.sims.years) - 1,
        },
        "considered": {"patterns": len(run.patterns), "rotations": len(pairs)},
        "current": current,
        "current_source": run.current_source,
        "economics": {"currency": econ["currency"], "validated": econ["validated"]},
        "confidence": scoring.confidence(
            pack_validated=econ["validated"],
            awc_source=run.farm.awc_source,
            has_carbon=run.farm.soc_t_ha is not None,
            n_years=len(run.sims.years),
            has_history=bool(run.history),
        ),
        "options": options,
    }


def stress_rotations(run: RotationRun, keys: list[str], weights: dict | None) -> dict:
    """Re-run the chosen rotations under each scenario and rank them against each other."""
    w = scoring.clean_weights(weights)
    index = {p.key: i for i, p in enumerate(run.patterns)}
    chosen = []
    for key in dict.fromkeys(keys):
        first, _, second = key.partition(">")
        if first in index and second in index:
            chosen.append((key, index[first], index[second]))
    if not chosen:
        raise ValueError("None of these rotations can be stress-tested")
    used = sorted({i for _, a, b in chosen for i in (a, b)})
    remap = {old: new for new, old in enumerate(used)}
    sub_run = replace(run, patterns=[run.patterns[i] for i in used], current=None)
    pairs = [(remap[a], remap[b]) for _, a, b in chosen]

    def ranked(sims: YearSims, keep: np.ndarray | None = None) -> list[dict]:
        results = _evaluate_pairs(replace(sub_run, sims=sims), pairs, sims, _year_pairs(sims, keep))
        arrays = _metric_arrays(results, np.zeros((len(results), 3)))
        score = scoring.weighted_score(scoring.pillar_scores(arrays), w)
        ranks = np.empty(len(results), dtype=int)
        ranks[np.argsort(-score, kind="stable")] = np.arange(1, len(results) + 1)
        return [
            {
                "rank": int(ranks[i]),
                "income_mean": round(r.metrics["income_mean"]),
                "income_p10": round(r.metrics["income_p10"]),
                "failure": round(r.metrics["failure"], 2),
            }
            for i, r in enumerate(results)
        ]

    def resimulate(weather: Weather) -> YearSims:
        return _simulate_patterns(
            run.farm, weather, run.settings, run.irrigation, run.windows, run.reference, sub_run.patterns
        )

    base = resimulate(run.weather)
    table = {"baseline": ranked(base)}
    for scenario in DELTAS:
        weather = prepare_weather(
            run.farm.frame,
            run.farm.lat,
            run.farm.elevation_m,
            scenario.warming_c,
            scenario.rain_factor,
            run.farm.historical_through,
        )
        table[scenario.key] = ranked(resimulate(weather))
    yearly_rain = np.array([np.nansum(run.weather.rain[run.weather.index.year == y]) for y in base.years])
    pair_rain = yearly_rain[:-1] + yearly_rain[1:]
    driest = np.zeros(len(pair_rain), dtype=bool)
    driest[np.argsort(pair_rain)[: max(1, round(DRIEST_SHARE * len(pair_rain)))]] = True
    table["driest"] = ranked(base, driest)
    return {
        "kind": "rotation",
        "weights": w,
        "scenarios": list(table),
        "rotations": [
            {
                "key": key,
                "robust": all(table[s][i]["rank"] <= ROBUST_RANK for s in table),
                "results": {s: table[s][i] for s in table},
            }
            for i, (key, _, _) in enumerate(chosen)
        ],
    }
