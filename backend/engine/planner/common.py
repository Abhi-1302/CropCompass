"""Shared planner pieces: journal entries, the season calendar, weather (with stress scenarios), current practice."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

from engine.climate.et0 import reference_et
from engine.climate.indicators import complete_years
from engine.crops.catalog import CropParams, crop_params
from engine.models import rothc
from engine.models.water import Irrigation
from engine.planner import rules

SEASONS = ("kharif", "rabi", "summer")
IRRIGATION = {"rainfed": Irrigation.NONE, "protective": Irrigation.PROTECTIVE, "full": Irrigation.FULL}
TYPICAL_FARM_YIELD = 0.6  # share of attainable yield assumed for past crops without a recorded yield
MIN_YEARS = 10


@dataclass(frozen=True)
class JournalEntry:
    crops: tuple[str, ...]
    season: str
    sow_date: date
    harvest_date: date | None
    status: str
    residue: str | None = None
    irrigations: int | None = None
    yield_kg_ha: float | None = None
    problems: tuple[str, ...] = ()
    herbicide: str | None = None


@dataclass(frozen=True)
class FarmInputs:
    frame: pd.DataFrame  # NASA POWER daily data
    lat: float
    elevation_m: float | None
    region: str
    awc_mm_per_m: float
    awc_source: str
    tew_mm: float
    soc_t_ha: float | None
    clay_pct: float | None
    history: tuple[JournalEntry, ...]
    area_ha: float | None = None
    depth_m: float = 1.0  # rootable soil depth
    irrigation: str = "rainfed"  # what the farm usually has
    historical_through: date | None = None


@dataclass(frozen=True)
class Weather:
    index: pd.DatetimeIndex
    rain: np.ndarray
    et0: np.ndarray
    tmax: np.ndarray
    et0_series: pd.Series
    first: date
    last: date  # last day with observed rain
    historical_through: date | None = None


def prepare_weather(
    frame: pd.DataFrame,
    lat: float,
    elevation_m: float | None,
    warming_c: float = 0.0,
    rain_factor: float = 1.0,
    historical_through: date | None = None,
) -> Weather:
    """Daily arrays for the models; a scenario warms every temperature (ET0 recomputed) and scales rain."""
    if warming_c or rain_factor != 1.0:
        frame = frame.copy()
        for column in ("T2M_MAX", "T2M_MIN", "T2MDEW", "T2M"):
            if column in frame:
                frame[column] = frame[column] + warming_c
        frame["PRECTOTCORR"] = frame["PRECTOTCORR"] * rain_factor
    et0 = reference_et(frame, lat, elevation_m or 0.0)
    return Weather(
        index=frame.index,
        rain=frame["PRECTOTCORR"].to_numpy(dtype=float),
        et0=et0.to_numpy(dtype=float),
        tmax=frame["T2M_MAX"].to_numpy(dtype=float),
        et0_series=et0,
        first=frame.index[0].date(),
        last=frame["PRECTOTCORR"].last_valid_index().date(),
        historical_through=historical_through,
    )


def year_starts(
    weather: Weather, anchor: date, span: int, *, include_scenario: bool = False
) -> tuple[list[int], list[int]]:
    """Weather positions and season years of every past year whose `span` days from `anchor` are complete."""
    positions, years = [], []
    for year in range(weather.first.year, anchor.year + 1):
        start = shift_years(anchor, year - anchor.year)
        if start < weather.first or start + timedelta(days=span - 1) > weather.last:
            continue
        if (
            weather.historical_through is not None
            and start + timedelta(days=span - 1) > weather.historical_through
            and not (include_scenario and year == anchor.year)
        ):
            continue
        pos = weather.index.get_loc(pd.Timestamp(start))
        block = slice(pos, pos + span)
        if np.isnan(weather.rain[block]).any() or np.isnan(weather.et0[block]).any():
            continue
        if np.isnan(weather.tmax[block]).any():
            continue
        positions.append(pos)
        years.append(year)
    if len(years) < MIN_YEARS:
        raise ValueError(f"At least {MIN_YEARS} complete years of weather are needed")
    return positions, years


def gather(weather: Weather, positions: list[int], span: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Rain, ET0 and Tmax shaped (span days, years)."""
    grid = np.array(positions)[None, :] + np.arange(span)[:, None]
    return weather.rain[grid], weather.et0[grid], weather.tmax[grid]


def default_season(today: date) -> str:
    if 4 <= today.month <= 9:
        return "kharif"
    return "summer" if today.month in (2, 3) else "rabi"


def month_day(value: str) -> tuple[int, int]:
    month, day = (int(part) for part in value.split("-"))
    return month, day


def window_dates(window: tuple[str, str], season: str, season_year: int) -> tuple[date, date]:
    """Calendar dates of a sowing window; rabi windows that start in January belong to the next year."""
    (sm, sd), (em, ed) = month_day(window[0]), month_day(window[1])
    start_year = season_year + 1 if season == "rabi" and sm <= 6 else season_year
    end_year = start_year + 1 if (em, ed) < (sm, sd) else start_year
    return date(start_year, sm, sd), date(end_year, em, ed)


def season_instance(season: str, crops: list[CropParams], today: date) -> int:
    """The coming (or current) season year: the first whose last sowing window has not closed."""
    for year in (today.year - 1, today.year, today.year + 1):
        if max(window_dates(crop.sowing[season], season, year)[1] for crop in crops) >= today:
            return year
    return today.year + 1


def shift_years(day: date, years: int) -> date:
    return date(day.year + years, day.month, min(day.day, 28) if (day.month, day.day) == (2, 29) else day.day)


def main_crop(entry: JournalEntry, region: str) -> CropParams | None:
    return next((p for c in entry.crops if (p := crop_params(region, c)) is not None), None)


def end_date(entry: JournalEntry, region: str) -> date:
    if entry.harvest_date is not None:
        return entry.harvest_date
    params = main_crop(entry, region)
    return entry.sow_date + timedelta(days=params.duration if params else 120)


def md(day: date) -> str:
    return day.strftime("%m-%d")


def past_crops(history: list[JournalEntry], region: str) -> list[rules.PastCrop]:
    return [
        rules.PastCrop(e.crops, e.sow_date, end_date(e, region), e.residue, e.problems, e.herbicide) for e in history
    ]


def monthly_climate(frame: pd.DataFrame, et0: pd.Series) -> rothc.MonthlyClimate:
    years = complete_years(frame["PRECTOTCORR"])
    keep = frame.index.year.isin(years)
    data = pd.DataFrame({"temp": (frame["T2M_MAX"] + frame["T2M_MIN"]) / 2, "rain": frame["PRECTOTCORR"], "pet": et0})[
        keep
    ]
    by_month = data.groupby([data.index.year, data.index.month])
    totals = by_month[["rain", "pet"]].sum().groupby(level=1).mean()
    temps = by_month["temp"].mean().groupby(level=1).mean()
    return rothc.MonthlyClimate(
        temp_c=temps.to_numpy(dtype=float),
        rain_mm=totals["rain"].to_numpy(dtype=float),
        pet_mm=totals["pet"].to_numpy(dtype=float),
    )


@dataclass(frozen=True)
class PracticeItem:
    crop: CropParams
    season: str
    yield_kg_ha: float
    residue: str | None
    sow_date: date
    duration: int


def current_practice(
    farm: FarmInputs, history: list[JournalEntry], reference: date, settings: dict
) -> tuple[list[PracticeItem], str]:
    """What the journal shows for the year before `reference`, else the pack's default practice."""
    items = []
    for entry in history:
        crop = main_crop(entry, farm.region)
        if crop is None or not reference - timedelta(days=365) <= entry.sow_date < reference:
            continue
        yield_kg = entry.yield_kg_ha or TYPICAL_FARM_YIELD * (crop.ym or 0)
        duration = max((end_date(entry, farm.region) - entry.sow_date).days, 1)
        items.append(PracticeItem(crop, entry.season, yield_kg, entry.residue, entry.sow_date, duration))
    if items:
        return items, "journal"
    for practice in settings["baseline_practice"]:
        crop = crop_params(farm.region, practice["crop"])
        start, _ = window_dates(crop.sowing[practice["season"]], practice["season"], reference.year)
        items.append(
            PracticeItem(
                crop, practice["season"], TYPICAL_FARM_YIELD * crop.ym, practice["residue"], start, crop.duration
            )
        )
    return items, "default"


def carbon_item(item: PracticeItem, months: int = 12, year_index: int = 0) -> rothc.CropCarbon:
    sowing = date(2001 + year_index, item.sow_date.month, item.sow_date.day)
    return rothc.crop_carbon(item.crop, item.yield_kg_ha, item.residue, sowing, item.duration, months)
