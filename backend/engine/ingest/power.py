"""NASA POWER daily point API client and grid-cell helpers."""

from __future__ import annotations

import calendar
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime

import httpx
import numpy as np
import pandas as pd

BASE_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
MONTHLY_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"
VALIDATION_VERSION = "annual-monthly-v1"
FIRST_DATE = date(1981, 1, 1)
PARAMETERS = (
    "T2M",
    "T2M_MAX",
    "T2M_MIN",
    "T2MDEW",
    "RH2M",
    "PRECTOTCORR",
    "ALLSKY_SFC_SW_DWN",
    "CLRSKY_SFC_SW_DWN",
    "ALLSKY_SFC_PAR_TOT",
    "WS2M",
    "GWETTOP",
    "GWETROOT",
    "GWETPROF",
    "EVPTRNS",
    "EVLAND",
    "PS",
    "TS",
)
MAX_PARAMETERS = 20
# POWER meteorology comes from the MERRA-2 grid; every farm inside one cell gets identical data.
LAT_STEP, LON_STEP = 0.5, 0.625
FILL_VALUE = -999.0
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_requests = threading.BoundedSemaphore(2)


class PowerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Cell:
    lat: float
    lon: float

    @property
    def id(self) -> str:
        return f"{self.lat:.3f}_{self.lon:.3f}"


@dataclass
class PowerSeries:
    data: pd.DataFrame  # daily DatetimeIndex, float columns, NaN where POWER has no value
    elevation_m: float | None
    units: dict[str, str] = field(default_factory=dict)
    provenance: dict = field(default_factory=dict)


def snap_to_cell(lat: float, lon: float) -> Cell:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Latitude must be within [-90, 90] and longitude within [-180, 180].")
    clat = math.floor(lat / LAT_STEP + 0.5) * LAT_STEP
    clon = math.floor((lon + 180) / LON_STEP + 0.5) * LON_STEP - 180
    if clon >= 180:
        clon -= 360
    return Cell(round(clat, 3), round(clon, 3))


def parse_response(payload: dict) -> PowerSeries:
    try:
        frame = pd.DataFrame(payload["properties"]["parameter"])
    except (KeyError, TypeError) as exc:
        raise PowerError("Unexpected POWER response format") from exc
    frame.index = pd.to_datetime(frame.index, format="%Y%m%d")
    fill = payload.get("header", {}).get("fill_value", FILL_VALUE)
    frame = frame.astype("float64")
    frame = frame.mask(frame == fill).sort_index()
    coords = payload.get("geometry", {}).get("coordinates", [])
    elevation = float(coords[2]) if len(coords) > 2 and coords[2] is not None else None
    units = {name: metadata.get("units", "") for name, metadata in payload.get("parameters", {}).items()}
    return PowerSeries(frame, elevation, units, payload.get("header", {}))


def fetch_daily(
    cell: Cell,
    start: date,
    end: date,
    client: httpx.Client,
    parameters: tuple[str, ...] = PARAMETERS,
    retries: int = 3,
    backoff_s: float = 2.0,
) -> PowerSeries:
    if len(parameters) > MAX_PARAMETERS:
        raise ValueError(f"POWER accepts at most {MAX_PARAMETERS} parameters per point request")
    query = {
        "parameters": ",".join(parameters),
        "community": "AG",
        "latitude": cell.lat,
        "longitude": cell.lon,
        "start": start.strftime("%Y%m%d"),
        "end": end.strftime("%Y%m%d"),
        "format": "JSON",
        "time-standard": "LST",
    }
    return parse_response(_request(BASE_URL, query, client, retries, backoff_s))


def _request(url: str, query: dict, client: httpx.Client, retries: int = 3, backoff_s: float = 2.0) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries):
        delay = backoff_s * 2**attempt
        try:
            with _requests:
                response = client.get(url, params=query)
        except httpx.TransportError as exc:
            last_error = exc
        else:
            if response.status_code == 200:
                return response.json()
            if response.status_code not in RETRYABLE_STATUS:
                raise PowerError(f"POWER returned HTTP {response.status_code}: {response.text[:300]}")
            last_error = PowerError(f"POWER returned HTTP {response.status_code}")
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    requested_delay = float(retry_after)
                except ValueError:
                    try:
                        requested_delay = (parsedate_to_datetime(retry_after) - datetime.now(UTC)).total_seconds()
                    except (TypeError, ValueError):
                        requested_delay = 0
                if requested_delay > 120:
                    raise PowerError("POWER requested a longer pause; refresh later to resume checkpoints")
                delay = max(delay, requested_delay)
        if attempt < retries - 1:
            time.sleep(delay)
    raise PowerError(f"POWER request failed after {retries} attempts") from last_error


def fetch_monthly(cell: Cell, start_year: int, end_year: int, client: httpx.Client) -> dict:
    payload = _request(
        MONTHLY_URL,
        {
            "parameters": "PRECTOTCORR,EVLAND",
            "community": "AG",
            "latitude": cell.lat,
            "longitude": cell.lon,
            "start": str(start_year),
            "end": str(end_year),
            "format": "JSON",
        },
        client,
    )
    for column in ("PRECTOTCORR", "EVLAND"):
        if payload.get("parameters", {}).get(column, {}).get("units") != "mm/day":
            raise PowerError(f"Unexpected monthly {column} units")
    return payload["properties"]["parameter"]


def validate_year(series: PowerSeries, start: date, end: date, monthly: dict) -> list[int]:
    if start.year != end.year or start > end:
        raise PowerError("Weather must be downloaded one calendar year at a time")
    frame = series.data
    expected = pd.date_range(start, end)
    if not frame.index.equals(expected):
        raise PowerError("Missing, duplicate or unexpected daily dates")
    expected_units = {
        "PRECTOTCORR": "mm/day",
        "EVLAND": "mm/day",
        "EVPTRNS": "MJ/m^2/day",
        "T2M": "C",
        "T2M_MAX": "C",
        "T2M_MIN": "C",
        "T2MDEW": "C",
        "TS": "C",
        "RH2M": "%",
        "WS2M": "m/s",
        "PS": "kPa",
        "ALLSKY_SFC_SW_DWN": "MJ/m^2/day",
        "CLRSKY_SFC_SW_DWN": "MJ/m^2/day",
        "ALLSKY_SFC_PAR_TOT": "MJ/m^2/day",
        "GWETROOT": "1",
        "GWETTOP": "1",
        "GWETPROF": "1",
    }
    bounds = {
        "PRECTOTCORR": (0, 2000),
        "EVLAND": (-5, 40),
        "EVPTRNS": (-15, 100),
        "T2M": (-100, 65),
        "T2M_MAX": (-100, 70),
        "T2M_MIN": (-100, 65),
        "T2MDEW": (-110, 65),
        "TS": (-110, 90),
        "RH2M": (0, 100),
        "WS2M": (0, 100),
        "PS": (30, 110),
        "GWETROOT": (0, 1),
        "GWETTOP": (0, 1),
        "GWETPROF": (0, 1),
        "ALLSKY_SFC_SW_DWN": (0, 60),
        "CLRSKY_SFC_SW_DWN": (0, 60),
        "ALLSKY_SFC_PAR_TOT": (0, 35),
    }
    solar = {"ALLSKY_SFC_SW_DWN", "CLRSKY_SFC_SW_DWN", "ALLSKY_SFC_PAR_TOT"}
    for column in PARAMETERS:
        if column not in frame:
            if column in solar and start.year < 1984:
                continue
            raise PowerError(f"Missing weather variable: {column}")
        if series.units.get(column) != expected_units[column]:
            raise PowerError(f"Unexpected daily {column} units: {series.units.get(column)}")
        values = frame[column]
        low, high = bounds[column]
        if ((values.dropna() < low) | (values.dropna() > high)).any():
            bad = values[(values < low) | (values > high)]
            raise PowerError(f"Weather outside physical screening limits: {column} on {bad.index[0].date()}")
        if np.isinf(values).any():
            raise PowerError(f"Non-finite weather values: {column}")
        if column in solar:
            if start.year < 1984:
                continue
            cutoff = pd.Timestamp(date.today()) - pd.Timedelta(days=120)
            missing = values.loc[:cutoff].isna().any()
        else:
            missing = values.isna().any()
        if missing:
            raise PowerError(f"Missing daily observations: {column}")
    if ((frame.T2M_MIN > frame.T2M) | (frame.T2M > frame.T2M_MAX)).any():
        raise PowerError("Inconsistent daily minimum/mean/maximum temperatures")
    unchecked = []
    for month in sorted(set(frame.index.month)):
        days = calendar.monthrange(start.year, month)[1]
        sample = frame.loc[frame.index.month == month]
        key = f"{start.year}{month:02}"
        complete = len(sample) == days
        available = all(
            monthly.get(column, {}).get(key, FILL_VALUE) != FILL_VALUE for column in ("PRECTOTCORR", "EVLAND")
        )
        if not complete or not available:
            unchecked.append(month)
            continue
        for column in ("PRECTOTCORR", "EVLAND"):
            rate = monthly[column][key]
            if rate is None or not math.isfinite(rate):
                raise PowerError(f"Invalid monthly {column} value for {key}")
            difference = abs(float(sample[column].sum()) - rate * days)
            if difference > 0.011 * days + 0.1:
                raise PowerError(f"Daily/monthly disagreement for {column} in {key}: {difference:.2f} mm")
    return unchecked


def fetch_verified_year(cell: Cell, year: int, end: date, monthly: dict, client: httpx.Client) -> PowerSeries:
    start = date(year, 1, 1)
    end = min(end, date(year, 12, 31))
    series = fetch_daily(cell, start, end, client)
    try:
        return _verify_series(series, cell, start, end, monthly, client)
    except PowerError as annual_error:
        parts = []
        for month in range(1, end.month + 1):
            month_start = date(year, month, 1)
            month_end = min(end, date(year, month, calendar.monthrange(year, month)[1]))
            part = fetch_daily(cell, month_start, month_end, client)
            if part.units != series.units:
                raise PowerError("Inconsistent units between annual and monthly requests") from annual_error
            parts.append(part.data)
        recovered = PowerSeries(
            pd.concat(parts).sort_index(),
            series.elevation_m,
            series.units,
            {**series.provenance, "recovered_from": str(annual_error), "request_window": "month"},
        )
        try:
            return _verify_series(recovered, cell, start, end, monthly, client)
        except PowerError as exc:
            raise PowerError(f"{start} to {end}: {exc}") from exc


def _verify_series(
    series: PowerSeries, cell: Cell, start: date, end: date, monthly: dict, client: httpx.Client
) -> PowerSeries:
    year = start.year
    series.data = trim_to_last_observation(series.data)
    observed_end = series.data.index[-1].date()
    if (end - observed_end).days > 7:
        raise PowerError("Weather coverage ends unexpectedly early")
    unchecked = validate_year(series, start, observed_end, monthly)
    for month in unchecked:
        month_start = date(year, month, 1)
        month_end = min(observed_end, date(year, month, calendar.monthrange(year, month)[1]))
        if (end - month_end).days > 100:
            raise PowerError(f"Monthly verification unavailable for {year}-{month:02}")
        probe = fetch_daily(cell, month_start, month_end, client)
        sample = series.data.loc[str(month_start) : str(month_end), ["PRECTOTCORR", "EVLAND"]]
        if not probe.data.index.equals(sample.index) or not np.allclose(
            sample, probe.data[["PRECTOTCORR", "EVLAND"]], atol=0.02, rtol=0
        ):
            raise PowerError(f"Short-window disagreement for {year}-{month:02}")
    series.data = series.data.reindex(columns=PARAMETERS)
    return series


def merge(old: pd.DataFrame, new: pd.DataFrame) -> pd.DataFrame:
    """Combine a cached series with a fresh download; fresh values win (POWER revises recent days)."""
    return new.combine_first(old).sort_index()


def trim_to_last_observation(frame: pd.DataFrame, column: str = "PRECTOTCORR") -> pd.DataFrame:
    valid = frame[column].dropna()
    if valid.empty:
        raise PowerError("POWER returned no usable data for this location")
    return frame.loc[: valid.index[-1]]
