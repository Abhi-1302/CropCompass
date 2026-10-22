"""Stress-test scenarios: warmer climate (ET0 and heat recomputed), less rain, and analog subsets of past years."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from engine.climate.indicators import scan_rain_events

DRIEST_SHARE = 0.2
LATE_ONSET_SHARE = 0.25


@dataclass(frozen=True)
class Scenario:
    key: str
    warming_c: float = 0.0
    rain_factor: float = 1.0
    subset: str | None = None  # "driest" or "late_onset": a subset of the baseline years


DELTAS = (
    Scenario("warm_1_5", warming_c=1.5),
    Scenario("warm_2", warming_c=2.0),
    Scenario("rain_minus_15", rain_factor=0.85),
)
SUBSETS = (Scenario("driest", subset="driest"), Scenario("late_onset", subset="late_onset"))


def driest_years(rain: np.ndarray, share: float = DRIEST_SHARE) -> np.ndarray:
    """Columns (years) in the driest `share` by total rain over the simulated span; rain is (days, years)."""
    totals = rain.sum(axis=0)
    count = max(1, round(share * len(totals)))
    mask = np.zeros(len(totals), dtype=bool)
    mask[np.argsort(totals)[:count]] = True
    return mask


def late_onset_years(rain: pd.Series, years: list[int], share: float = LATE_ONSET_SHARE) -> np.ndarray | None:
    """Years whose monsoon onset (the climate page's rule) was among the latest `share`; None if undecidable."""
    offsets = []
    for year in years:
        scan = scan_rain_events(rain, pd.Timestamp(year, 6, 1), pd.Timestamp(year, 9, 30))
        if not scan.decided:
            offsets.append(np.nan)
            continue
        onset = scan.first_reliable
        offsets.append((onset - pd.Timestamp(year, 6, 1)).days if onset is not None else 122)
    offsets = np.array(offsets, dtype=float)
    known = np.isfinite(offsets)
    if known.sum() < 10:
        return None
    cutoff = np.quantile(offsets[known], 1 - share)
    return known & (offsets >= cutoff)
