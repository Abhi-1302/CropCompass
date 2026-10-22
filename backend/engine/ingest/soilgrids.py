"""ISRIC SoilGrids v2.0 REST client (mean predictions, six standard depths, converted to conventional units)."""

from __future__ import annotations

import time

import httpx

BASE_URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
PROPERTIES = ("bdod", "cec", "clay", "nitrogen", "phh2o", "sand", "silt", "soc")
DEPTHS = ("0-5cm", "5-15cm", "15-30cm", "30-60cm", "60-100cm", "100-200cm")
# Units after dividing by the API's d_factor.
UNITS = {
    "bdod": "g/cm3",
    "cec": "cmol(c)/kg",
    "clay": "%",
    "nitrogen": "g/kg",
    "phh2o": "pH",
    "sand": "%",
    "silt": "%",
    "soc": "g/kg",
}
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class SoilGridsError(RuntimeError):
    pass


def _depth_range(label: str) -> tuple[int, int]:
    top, bottom = label.removesuffix("cm").split("-")
    return int(top), int(bottom)


def parse_response(payload: dict) -> list[dict]:
    layers: dict[str, dict] = {}
    try:
        for prop in payload["properties"]["layers"]:
            name = prop["name"]
            factor = prop["unit_measure"]["d_factor"]
            for depth in prop["depths"]:
                label = depth["label"]
                if label not in DEPTHS:
                    continue
                top, bottom = _depth_range(label)
                layer = layers.setdefault(label, {"depth": label, "top_cm": top, "bottom_cm": bottom})
                mean = depth["values"].get("mean")
                layer[name] = None if mean is None else round(mean / factor, 3)
    except (KeyError, TypeError, ValueError) as exc:
        raise SoilGridsError("Unexpected SoilGrids response format") from exc
    return [layers[d] for d in DEPTHS if d in layers]


def fetch_profile(lat: float, lon: float, client: httpx.Client, retries: int = 3, backoff_s: float = 2.0) -> list[dict]:
    query = [("lon", lon), ("lat", lat), ("value", "mean")]
    query += [("property", p) for p in PROPERTIES] + [("depth", d) for d in DEPTHS]
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = client.get(BASE_URL, params=query, headers={"Accept": "application/json"})
        except httpx.TransportError as exc:
            last_error = exc
        else:
            if response.status_code == 200:
                layers = parse_response(response.json())
                if not any(layer.get("clay") is not None for layer in layers):
                    raise SoilGridsError("No soil data at this location (water, urban area or outside coverage)")
                return layers
            if response.status_code not in RETRYABLE_STATUS:
                raise SoilGridsError(f"SoilGrids returned HTTP {response.status_code}")
            last_error = SoilGridsError(f"SoilGrids returned HTTP {response.status_code}")
        if attempt < retries - 1:
            time.sleep(backoff_s * 2**attempt)
    raise SoilGridsError(f"SoilGrids request failed after {retries} attempts") from last_error
