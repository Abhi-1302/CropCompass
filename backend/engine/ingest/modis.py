"""NASA ORNL DAAC land-product subset service: MODIS MOD13Q1 (250 m, 16-day) NDVI at a point."""

from __future__ import annotations

import time
from datetime import date

import httpx

BASE_URL = "https://modis.ornl.gov/rst/api/v1"
PRODUCT = "MOD13Q1"
NDVI_BAND = "250m_16_days_NDVI"
MAX_DATES_PER_REQUEST = 10  # service limit
FILL_VALUE = -3000
DEFAULT_SCALE = 0.0001
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class ModisError(RuntimeError):
    pass


def _get(client: httpx.Client, url: str, params: dict, retries: int = 3, backoff_s: float = 5.0) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = client.get(url, params=params, headers={"Accept": "application/json"})
        except httpx.TransportError as exc:
            last_error = exc
        else:
            if response.status_code == 200:
                return response.json()
            if response.status_code not in RETRYABLE_STATUS:
                raise ModisError(f"MODIS service returned HTTP {response.status_code}: {response.text[:200]}")
            last_error = ModisError(f"MODIS service returned HTTP {response.status_code}")
        if attempt < retries - 1:
            time.sleep(backoff_s * 2**attempt)
    raise ModisError(f"MODIS request failed after {retries} attempts") from last_error


def available_dates(lat: float, lon: float, client: httpx.Client) -> list[tuple[str, date]]:
    """(MODIS date code 'AYYYYDDD', calendar date) for every composite available at the location."""
    payload = _get(client, f"{BASE_URL}/{PRODUCT}/dates", {"latitude": lat, "longitude": lon})
    try:
        return [(item["modis_date"], date.fromisoformat(item["calendar_date"])) for item in payload["dates"]]
    except (KeyError, TypeError, ValueError) as exc:
        raise ModisError("Unexpected MODIS dates response") from exc


def parse_subset(payload: dict) -> dict[date, float | None]:
    try:
        scale = float(payload.get("scale", DEFAULT_SCALE))
    except (TypeError, ValueError):
        scale = DEFAULT_SCALE
    try:
        values = {}
        for item in payload["subset"]:
            raw = item["data"][0] if item["data"] else None
            values[date.fromisoformat(item["calendar_date"])] = (
                None if raw is None or raw <= FILL_VALUE else round(raw * scale, 4)
            )
        return values
    except (KeyError, TypeError, ValueError) as exc:
        raise ModisError("Unexpected MODIS subset response") from exc


def fetch_ndvi(lat: float, lon: float, modis_dates: list[str], client: httpx.Client) -> dict[date, float | None]:
    """NDVI for up to ten consecutive composites (pixel containing the point)."""
    if not 0 < len(modis_dates) <= MAX_DATES_PER_REQUEST:
        raise ValueError(f"Request between 1 and {MAX_DATES_PER_REQUEST} composite dates")
    params = {
        "latitude": lat,
        "longitude": lon,
        "band": NDVI_BAND,
        "startDate": modis_dates[0],
        "endDate": modis_dates[-1],
        "kmAboveBelow": 0,
        "kmLeftRight": 0,
    }
    return parse_subset(_get(client, f"{BASE_URL}/{PRODUCT}/subset", params))
