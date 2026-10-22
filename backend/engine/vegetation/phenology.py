"""Crop seasons from a 16-day NDVI series: cloud-dip removal, upper-envelope smoothing, green-up/peak/senescence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

CLOUD_DIP = 0.1  # a composite this far below both neighbours is treated as cloud contamination
MIN_PEAK_NDVI = 0.35
MIN_PROMINENCE = 0.12
MIN_SEASON_DAYS = 40
# Typical offsets for field crops: 50% green-up comes ~3-4 weeks after sowing, 50% senescence ~2 weeks before harvest.
SOWING_LEAD_DAYS = 25
HARVEST_LAG_DAYS = 15


@dataclass(frozen=True)
class Season:
    green_up: date
    peak: date
    senescence: date | None  # None while the crop is still green at the end of the record
    peak_ndvi: float
    amplitude: float

    @property
    def est_sowing(self) -> date:
        return self.green_up - timedelta(days=SOWING_LEAD_DAYS)

    @property
    def est_harvest(self) -> date | None:
        return self.senescence + timedelta(days=HARVEST_LAG_DAYS) if self.senescence else None

    @property
    def length_days(self) -> int | None:
        return (self.senescence - self.green_up).days if self.senescence else None


def _savgol(values: np.ndarray, window: int = 5, order: int = 2) -> np.ndarray:
    half = window // 2
    offsets = np.arange(-half, half + 1)
    coefficients = np.linalg.pinv(np.vander(offsets, order + 1, increasing=True))[0]
    return np.convolve(np.pad(values, half, mode="edge"), coefficients[::-1], mode="valid")


def smooth(ndvi: pd.Series, iterations: int = 2) -> pd.DataFrame:
    """Columns raw / clean / smooth on the composite dates; clouds only ever pull NDVI down, so the
    smoothing is pushed towards the upper envelope (Chen et al. 2004)."""
    series = ndvi.sort_index().astype(float)
    raw = series.to_numpy()
    clean = raw.copy()
    for i in range(1, len(raw) - 1):
        before, now, after = raw[i - 1], raw[i], raw[i + 1]
        if not np.isnan([before, now, after]).any() and now < min(before, after) - CLOUD_DIP:
            clean[i] = np.nan
    filled = pd.Series(clean, index=series.index).interpolate(limit_direction="both").to_numpy()
    if np.isnan(filled).all():
        return pd.DataFrame({"raw": raw, "clean": clean, "smooth": filled}, index=series.index)
    fitted = _savgol(filled)
    for _ in range(iterations):
        filled = np.maximum(filled, fitted)
        fitted = _savgol(filled)
    return pd.DataFrame({"raw": raw, "clean": clean, "smooth": np.clip(fitted, -0.2, 1.0)}, index=series.index)


def _prominence(values: np.ndarray, peak: int) -> float:
    left = peak
    while left > 0 and values[left - 1] <= values[peak]:
        left -= 1
    right = peak
    while right < len(values) - 1 and values[right + 1] <= values[peak]:
        right += 1
    return float(values[peak] - max(values[left : peak + 1].min(), values[peak : right + 1].min()))


def _crossing(dates: pd.DatetimeIndex, values: np.ndarray, start: int, stop: int, level: float, rising: bool) -> date:
    """Date where the curve crosses `level` between indices start..stop, linearly interpolated."""
    step = 1 if stop >= start else -1
    for i in range(start, stop + step, step):
        hit = values[i] >= level if rising else values[i] < level
        if hit:
            if i == start:
                return dates[i].date()
            j = i - step
            span = values[i] - values[j]
            fraction = 0.0 if span == 0 else (level - values[j]) / span
            return (dates[j] + (dates[i] - dates[j]) * float(np.clip(fraction, 0, 1))).date()
    return dates[stop].date()


def detect_seasons(smoothed: pd.Series) -> list[Season]:
    values = smoothed.to_numpy(dtype=float)
    dates = smoothed.index
    if len(values) < 5 or np.isnan(values).any():
        return []
    peaks = [
        i
        for i in range(1, len(values) - 1)
        if values[i] >= values[i - 1] and values[i] > values[i + 1] and values[i] >= MIN_PEAK_NDVI
    ]
    peaks = [p for p in peaks if _prominence(values, p) >= MIN_PROMINENCE]
    seasons = []
    for n, peak in enumerate(peaks):
        lo = peaks[n - 1] if n else 0
        hi = peaks[n + 1] if n + 1 < len(peaks) else len(values) - 1
        left = lo + int(np.argmin(values[lo : peak + 1]))
        right = peak + int(np.argmin(values[peak : hi + 1]))
        rise, fall = values[peak] - values[left], values[peak] - values[right]
        if rise < MIN_PROMINENCE:
            continue
        green_up = _crossing(dates, values, left, peak, values[left] + rise / 2, rising=True)
        senescence = None
        if fall >= MIN_PROMINENCE:
            senescence = _crossing(dates, values, peak, right, values[right] + fall / 2, rising=False)
        season = Season(green_up, dates[peak].date(), senescence, round(float(values[peak]), 3), round(float(rise), 3))
        if season.length_days is None or season.length_days >= MIN_SEASON_DAYS:
            seasons.append(season)

    # A crop still growing when the record ends has no peak yet; the last composite stands in for it.
    start = peaks[-1] if peaks else 0
    trough = start + int(np.argmin(values[start:]))
    rise = values[-1] - values[trough]
    if trough < len(values) - 1 and values[-1] >= values[-2] and values[-1] >= MIN_PEAK_NDVI and rise >= MIN_PROMINENCE:
        green_up = _crossing(dates, values, trough, len(values) - 1, values[trough] + rise / 2, rising=True)
        seasons.append(Season(green_up, dates[-1].date(), None, round(float(values[-1]), 3), round(float(rise), 3)))
    return seasons
