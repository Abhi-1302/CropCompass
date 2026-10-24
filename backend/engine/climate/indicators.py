"""Agro-climatic indicators from daily series: rainfall reliability, onset, dry spells, growing season, heat, trends."""

from __future__ import annotations

import calendar
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

DRY_DAY_MM = 2.5  # India Meteorological Department rainy-day threshold


def probability(hits: int, total: int) -> dict:
    return {"p": round(hits / total, 3) if total else None, "k": int(hits), "n": int(total)}


def runs(mask) -> list[tuple[int, int]]:
    """(start, end_exclusive) index pairs of consecutive True values."""
    edges = np.diff(np.r_[0, np.asarray(mask, dtype=np.int8), 0])
    return list(zip(np.flatnonzero(edges == 1).tolist(), np.flatnonzero(edges == -1).tolist(), strict=True))


def longest_run(mask) -> int:
    return max((end - start for start, end in runs(mask)), default=0)


def complete_years(series: pd.Series) -> list[int]:
    counts = series.notna().groupby(series.index.year).sum()
    return [int(y) for y, c in counts.items() if c == (366 if calendar.isleap(int(y)) else 365)]


def month_day(day_of_year: int) -> str:
    return (pd.Timestamp(2001, 1, 1) + pd.Timedelta(days=int(day_of_year) - 1)).strftime("%m-%d")


def offset_to_month_day(month: int, day: int, offset_days: float) -> str:
    return (pd.Timestamp(2001, month, day) + pd.Timedelta(days=round(offset_days))).strftime("%m-%d")


def soil_water_balance(rain, et0, awc_mm: float) -> np.ndarray:
    """Relative store (0-1) of a reference crop; water use slows linearly once half the store is used."""
    store, half = 0.0, 0.5 * awc_mm
    out = np.empty(len(rain))
    for i, (p, e) in enumerate(zip(np.nan_to_num(rain), np.nan_to_num(et0), strict=True)):
        store = min(awc_mm, max(0.0, store + p - e * min(1.0, store / half)))
        out[i] = store / awc_mm
    return out


@dataclass(frozen=True)
class RainEventScan:
    first_reliable: pd.Timestamp | None  # first rain event not followed by a long dry spell
    first_event_failed: bool | None  # True when the very first event was a false start
    decided: bool  # False when the data ends before the search window does


def scan_rain_events(
    rain: pd.Series,
    start: pd.Timestamp,
    end: pd.Timestamp,
    min_mm: float = 20.0,
    window: int = 3,
    dry_spell: int = 10,
    lookahead: int = 30,
    dry_mm: float = DRY_DAY_MM,
) -> RainEventScan:
    """Find the first day in [start, end] on which the last `window` days' rain reaches `min_mm`
    and no dry spell of `dry_spell` days follows within `lookahead` days."""
    pad = window - 1
    seg = rain.loc[start - pd.Timedelta(days=pad) : end + pd.Timedelta(days=lookahead)].to_numpy()
    if np.isnan(seg).any():
        seg = seg[: int(np.flatnonzero(np.isnan(seg))[0])]
    wanted = (end - start).days + 1
    usable = min(wanted, len(seg) - pad - lookahead)
    if usable <= 0:
        return RainEventScan(None, None, False)
    totals = np.convolve(seg, np.ones(window), "valid")  # totals[j] covers the window ending on start + j days
    dry = seg < dry_mm
    first_failed = None
    for j in range(usable):
        if totals[j] >= min_mm:
            after = dry[j + pad + 1 : j + pad + 1 + lookahead]
            reliable = longest_run(after) < dry_spell
            if first_failed is None:
                first_failed = not reliable
            if reliable:
                return RainEventScan(start + pd.Timedelta(days=j), first_failed, True)
    return RainEventScan(None, first_failed, usable == wanted)


def longest_dry_spell(
    rain: pd.Series, start: pd.Timestamp, end: pd.Timestamp, dry_mm: float = DRY_DAY_MM
) -> int | None:
    seg = rain.loc[start:end]
    if len(seg) != (end - start).days + 1 or seg.isna().any():
        return None
    return longest_run(seg.to_numpy() < dry_mm)


def _fill_short_gaps(mask: np.ndarray, gap: int = 10, min_len: int = 30) -> np.ndarray:
    mask = mask.copy()
    for start, end in runs(~mask):
        if start > 0 and end < len(mask) and end - start < gap:
            mask[start:end] = True
    for start, end in runs(mask):
        if end - start < min_len:
            mask[start:end] = False
    return mask


def growing_season(
    store: pd.Series, tmean: pd.Series, years: list[int], min_store: float = 0.25, min_temp_c: float = 5.0
) -> dict:
    """FAO agro-ecological-zone style growing period: enough soil water AND warm enough.

    The agricultural year starts on the day least likely to be growing, so two-season climates and
    southern-hemisphere seasons that cross New Year are handled without special cases.
    """
    temp_ok = tmean.rolling(15, center=True, min_periods=1).mean() >= min_temp_c
    grow = (store >= min_store) & temp_ok
    in_years = grow[grow.index.year.isin(years)]
    freq = (
        in_years.groupby(np.minimum(in_years.index.dayofyear, 365)).mean().reindex(range(1, 366), fill_value=0.0)
    ).to_numpy(dtype=float)
    smooth = np.convolve(np.r_[freq[-15:], freq, freq[:15]], np.ones(31) / 31, "valid")
    k0 = int(np.argmin(smooth))
    windows = [
        {"start": month_day((k0 + s) % 365 + 1), "end": month_day((k0 + e - 1) % 365 + 1), "days": int(e - s)}
        for s, e in runs(np.roll(smooth >= 0.5, -k0))
    ]
    values, index = grow.to_numpy(), grow.index
    one_long = two_seasons = 0
    longest: list[int] = []
    for year in years:
        i0 = index.get_indexer([pd.Timestamp(year, 1, 1) + pd.Timedelta(days=k0)])[0]
        if i0 < 0 or i0 + 365 > len(values):
            continue
        lengths = [e - s for s, e in runs(_fill_short_gaps(values[i0 : i0 + 365]))]
        one_long += any(length >= 90 for length in lengths)
        two_seasons += sum(length >= 60 for length in lengths) >= 2
        longest.append(max(lengths, default=0))
    n = len(longest)
    return {
        "agri_year_start": month_day(k0 + 1),
        "windows": windows,
        "p_season_ge_90d": probability(one_long, n),
        "p_two_seasons_ge_60d": probability(two_seasons, n),
        "median_longest_days": int(np.median(longest)) if longest else None,
    }


def rain_stats(rain: pd.Series, years: list[int]) -> dict:
    totals = rain.groupby(rain.index.year).sum().loc[years]
    arr = totals.to_numpy(dtype=float)
    return {
        "mean_mm": round(float(arr.mean())),
        "median_mm": round(float(np.median(arr))),
        "dependable_mm": round(float(np.percentile(arr, 20))),  # exceeded in 8 of 10 years
        "wet_year_mm": round(float(np.percentile(arr, 80))),  # exceeded in 2 of 10 years
        "cv": round(float(arr.std(ddof=1) / arr.mean()), 2),
        "min": {"mm": round(float(arr.min())), "year": int(totals.idxmin())},
        "max": {"mm": round(float(arr.max())), "year": int(totals.idxmax())},
        "by_year": [{"year": int(y), "mm": round(float(v))} for y, v in totals.items()],
    }


def aridity_class(index: float) -> str:
    """UNEP aridity classes (rain / reference evapotranspiration)."""
    if index < 0.05:
        return "hyper-arid"
    if index < 0.2:
        return "arid"
    if index < 0.5:
        return "semi-arid"
    if index < 0.65:
        return "dry sub-humid"
    return "humid"


def monthly_climatology(rain, et0, tmax, tmin, years: list[int]) -> list[dict]:
    frame = pd.DataFrame({"rain": rain, "et0": et0, "tmax": tmax, "tmin": tmin})
    frame = frame[frame.index.year.isin(years)]
    by_year_month = [frame.index.year, frame.index.month]
    totals = frame[["rain", "et0"]].groupby(by_year_month).sum().groupby(level=1).mean()
    temps = frame[["tmax", "tmin"]].groupby(frame.index.month).mean()
    hot = (frame["tmax"] >= 35).groupby(by_year_month).sum().groupby(level=1).mean()
    frost = (frame["tmin"] <= 0).groupby(by_year_month).sum().groupby(level=1).mean()
    return [
        {
            "month": m,
            "rain_mm": round(float(totals.loc[m, "rain"])),
            "et0_mm": round(float(totals.loc[m, "et0"])),
            "tmax_c": round(float(temps.loc[m, "tmax"]), 1),
            "tmin_c": round(float(temps.loc[m, "tmin"]), 1),
            "hot_days": round(float(hot.loc[m]), 1),
            "frost_days": round(float(frost.loc[m]), 1),
        }
        for m in range(1, 13)
    ]


def heat_stats(tmax: pd.Series, years: list[int]) -> dict:
    ge35 = [int((tmax.loc[str(y)] >= 35).sum()) for y in years]
    ge40 = [int((tmax.loc[str(y)] >= 40).sum()) for y in years]
    return {"days_ge_35_median": int(np.median(ge35)), "days_ge_40_median": int(np.median(ge40))}


def frost_stats(tmin: pd.Series, years: list[int], southern: bool) -> dict:
    frost_days, frost_free = [], []
    for y in years:
        # Measure across the warm half of the year so the frost-free run is not cut at New Year.
        seg = tmin.loc[f"{y}-07-01" : f"{y + 1}-06-30"] if southern else tmin.loc[str(y)]
        if len(seg) < 365 or seg.isna().any():
            continue
        frost_days.append(int((seg <= 0).sum()))
        frost_free.append(longest_run(seg.to_numpy() > 0))
    if not frost_days:
        return {"has_frost": None, "frost_days_median": None, "frost_free_days_median": None}
    return {
        "has_frost": any(frost_days),
        "frost_days_median": int(np.median(frost_days)),
        "frost_free_days_median": int(np.median(frost_free)),
    }


def mann_kendall(values) -> dict | None:
    """Mann-Kendall trend test (two-sided, tie-corrected) with Sen's slope per decade."""
    x = np.asarray(values, dtype=float)
    x = x[~np.isnan(x)]
    n = len(x)
    if n < 10:
        return None
    i, j = np.triu_indices(n, k=1)
    diffs = x[j] - x[i]
    s = float(np.sign(diffs).sum())
    _, ties = np.unique(x, return_counts=True)
    variance = (n * (n - 1) * (2 * n + 5) - float(np.sum(ties * (ties - 1) * (2 * ties + 5)))) / 18
    z = (s - np.sign(s)) / math.sqrt(variance) if variance > 0 else 0.0
    p_value = math.erfc(abs(z) / math.sqrt(2))
    return {
        "slope_per_decade": round(float(np.median(diffs / (j - i))) * 10, 2),
        "p_value": round(p_value, 3),
        "significant": p_value < 0.05,
    }


def current_season(
    rain: pd.Series, store: pd.Series, years: list[int], start_month: int, start_day: int
) -> dict | None:
    """Season-to-date rain and soil-water store compared with the same window in every past year."""
    last = rain.last_valid_index()
    start = pd.Timestamp(last.year, start_month, start_day)
    if start > last:
        start = pd.Timestamp(last.year - 1, start_month, start_day)
    span = pd.Timedelta(days=(last - start).days)
    offset = last.year - start.year
    past_rain, past_store = [], []
    for year in years:
        s = pd.Timestamp(year - offset, start_month, start_day)
        e = s + span
        if s < rain.index[0] or e >= start or e > rain.index[-1]:
            continue
        past_rain.append(float(rain.loc[s:e].sum()))
        past_store.append(float(store.loc[e]))
    if len(past_rain) < 10:
        return None
    current_rain = float(rain.loc[start:last].sum())
    current_store = float(store.loc[last])
    return {
        "start": start.date().isoformat(),
        "until": last.date().isoformat(),
        "rain_mm": round(current_rain),
        "median_mm": round(float(np.median(past_rain))),
        "rain_percentile": round(float(np.mean(np.array(past_rain) <= current_rain)), 2),
        "store_fraction": round(current_store, 2),
        "store_percentile": round(float(np.mean(np.array(past_store) <= current_store)), 2),
        "n_years": len(past_rain),
    }


def monsoon_indicators(rain: pd.Series, store: pd.Series, tmax: pd.Series, years: list[int]) -> dict:
    """South-Asian monsoon rules: onset, false start, Jun-Sep rain, Jul-Sep dry spells, season length, rabi heat."""
    onsets: dict[int, pd.Timestamp | None] = {}
    false_starts, jjas, dry, lengths, end_offsets, rabi_heat = [], [], [], [], [], []
    for y in years:
        scan = scan_rain_events(rain, pd.Timestamp(y, 6, 1), pd.Timestamp(y, 9, 30))
        if scan.decided:
            onsets[y] = scan.first_reliable
        early = scan_rain_events(rain, pd.Timestamp(y, 5, 15), pd.Timestamp(y, 9, 30))
        if early.first_event_failed is not None:
            false_starts.append(early.first_event_failed)
        jjas.append(float(rain.loc[f"{y}-06-01" : f"{y}-09-30"].sum()))
        spell = longest_dry_spell(rain, pd.Timestamp(y, 7, 1), pd.Timestamp(y, 9, 30))
        if spell is not None:
            dry.append(spell)
        hot = tmax.loc[f"{y}-02-15" : f"{y}-03-15"]
        if len(hot) and not hot.isna().any():
            rabi_heat.append(int((hot >= 35).sum()) >= 5)
        onset = onsets.get(y)
        if onset is not None:
            seg = store.loc[pd.Timestamp(y, 9, 15) : pd.Timestamp(y + 1, 3, 31)]
            below = seg.index[seg.to_numpy() < 0.2]
            if len(below):
                end = below[0]
            elif len(seg) and seg.index[-1] >= pd.Timestamp(y + 1, 3, 31):
                end = seg.index[-1]
            else:
                continue
            lengths.append((end - onset).days)
            end_offsets.append((end - pd.Timestamp(y, 9, 15)).days)

    found = {y: o for y, o in onsets.items() if o is not None}
    offsets = [(o - pd.Timestamp(y, 6, 1)).days for y, o in found.items()]
    n_onset = len(onsets)
    jjas_median = float(np.median(jjas))
    this_year = None
    current = rain.last_valid_index().year
    if current not in years:
        scan = scan_rain_events(rain, pd.Timestamp(current, 6, 1), pd.Timestamp(current, 9, 30))
        this_year = {
            "year": current,
            "date": scan.first_reliable.date().isoformat() if scan.first_reliable is not None else None,
            "decided": scan.first_reliable is not None or scan.decided,
        }
    return {
        "onset": {
            "median": offset_to_month_day(6, 1, float(np.median(offsets))) if offsets else None,
            "earliest": offset_to_month_day(6, 1, min(offsets)) if offsets else None,
            "latest": offset_to_month_day(6, 1, max(offsets)) if offsets else None,
            "p_by_jun_15": probability(sum((o.month, o.day) <= (6, 15) for o in found.values()), n_onset),
            "p_by_jun_30": probability(sum(o.month == 6 for o in found.values()), n_onset),
            "p_after_jul_15": probability(n_onset - sum((o.month, o.day) <= (7, 15) for o in found.values()), n_onset),
            "by_year": [
                {"year": y, "date": o.date().isoformat() if o is not None else None} for y, o in onsets.items()
            ],
            "this_year": this_year,
            "rule": "First day from Jun 1 when 3-day rain reaches 20 mm, with no 10-day dry spell in the next 30 days",
        },
        "false_start": probability(sum(false_starts), len(false_starts)),
        "jjas_rain": {
            "median_mm": round(jjas_median),
            "p_deficient": probability(sum(v < 0.75 * jjas_median for v in jjas), len(jjas)),
        },
        "dry_spells_jul_sep": {f"ge_{k}d": probability(sum(d >= k for d in dry), len(dry)) for k in (10, 14, 21)},
        "growing_period": {
            "median_days": int(np.median(lengths)) if lengths else None,
            **{f"p_ge_{k}d": probability(sum(v >= k for v in lengths), len(lengths)) for k in (120, 150, 180)},
            "median_end": offset_to_month_day(9, 15, float(np.median(end_offsets))) if end_offsets else None,
        },
        "rabi_terminal_heat": probability(sum(rabi_heat), len(rabi_heat)),
    }
