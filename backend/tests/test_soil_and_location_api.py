from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from app.services.geometry import BoundaryError, field_shape
from tests.conftest import csrf, register

FARM = {"name": "Shadnagar plot", "lat": 17.2, "lon": 78.3}
BLACK_SOIL = {
    "soil_type": "black",
    "sand_pct": 20,
    "silt_pct": 25,
    "clay_pct": 55,
    "awc_mm_per_m": 180,
    "depth_cm": 75,
    "organic_carbon_pct": 0.6,
    "ph": 8.1,
}


def make_farm(client, body=FARM) -> dict:
    response = client.post("/api/v1/farms", json=body, headers=csrf(client))
    assert response.status_code == 201, response.text
    return response.json()


def square(lon: float, lat: float, side_deg: float) -> list[list[float]]:
    return [[lon, lat], [lon + side_deg, lat], [lon + side_deg, lat + side_deg], [lon, lat + side_deg], [lon, lat]]


def test_field_shape_area_and_centre():
    area, lat, lon = field_shape([tuple(p) for p in square(78.3, 17.2, 0.001)])
    assert area == pytest.approx(1.18, abs=0.01)  # 106 m x 111 m
    assert (lat, lon) == pytest.approx((17.2005, 78.3005), abs=1e-6)
    with pytest.raises(BoundaryError):
        bow_tie = [(78.3, 17.2), (78.301, 17.201), (78.301, 17.2), (78.3, 17.201), (78.3, 17.2)]
        field_shape(bow_tie)


def test_farm_from_a_drawn_boundary(client):
    register(client)
    ring = square(78.3, 17.2, 0.001)
    farm = make_farm(
        client, {"name": "Field", "lat": 0, "lon": 0, "boundary": {"type": "Polygon", "coordinates": [ring]}}
    )
    assert farm["lat"] == pytest.approx(17.2005) and farm["lon"] == pytest.approx(78.3005)
    assert farm["area_ha"] == pytest.approx(1.18, abs=0.01)
    assert farm["region"] == "IN" and farm["boundary"]["coordinates"][0][0] == [78.3, 17.2]

    open_ring = {"type": "Polygon", "coordinates": [ring[:-1]]}
    bad = client.post("/api/v1/farms", json={**FARM, "boundary": open_ring}, headers=csrf(client))
    assert bad.status_code == 422
    crossing = [[78.3, 17.2], [78.301, 17.201], [78.301, 17.2], [78.3, 17.201], [78.3, 17.2]]
    bad = client.post(
        "/api/v1/farms", json={**FARM, "boundary": {"type": "Polygon", "coordinates": [crossing]}}, headers=csrf(client)
    )
    assert bad.status_code == 422 and "cross" in bad.json()["detail"]


def test_farmer_soil_values_feed_the_models(client):
    register(client)
    farm = make_farm(client)
    url = f"/api/v1/farms/{farm['id']}/soil"
    soil = client.get(url).json()
    assert soil["override"] is None and soil["effective"]["source"] == "soilgrids"
    assert soil["effective"]["texture"] == "clay loam"

    bad = client.put(f"{url}/override", json={**BLACK_SOIL, "clay_pct": 40}, headers=csrf(client))
    assert bad.status_code == 422  # texture must add up to 100%
    partial = {"sand_pct": 20}
    assert client.put(f"{url}/override", json=partial, headers=csrf(client)).status_code == 422

    saved = client.put(f"{url}/override", json=BLACK_SOIL, headers=csrf(client))
    assert saved.status_code == 200, saved.text
    effective = saved.json()["effective"]
    assert (effective["source"], effective["texture"], effective["awc_mm"]) == ("farmer", "clay", 135)
    assert effective["soc_stock_t_ha_0_30cm"] == pytest.approx(0.6 * 1.5 * 30, abs=0.1)  # map bulk density 1.5

    climate = client.get(f"/api/v1/farms/{farm['id']}/climate").json()
    assert climate["assumptions"]["awc_source"] == "farmer" and climate["assumptions"]["awc_mm"] == 135
    assert climate["soil_now"]["capacity_mm"] == 135

    cleared = client.delete(f"{url}/override", headers=csrf(client)).json()
    assert cleared["override"] is None and cleared["effective"]["source"] == "soilgrids"


def test_climate_and_advice_show_the_same_soil_water(client):
    register(client)
    farm = make_farm(client)
    base = f"/api/v1/farms/{farm['id']}"
    climate = client.get(f"{base}/climate").json()
    advice = client.post(f"{base}/advice/next-crop", json={"irrigation": "protective"}, headers=csrf(client)).json()
    assert climate["soil_now"]["mm"] == advice["soil_now"]["mm"]
    assert climate["soil_now"]["percentile"] == advice["soil_now"]["percentile"]

    assumed = climate["soil_now"]["assumed"]
    assert assumed and assumed[0]["crop"] == "maize" and assumed[0]["season"] == "kharif"  # nothing logged yet

    year = assumed[0]["season_year"]
    harvest = min(date(year, 10, 1), datetime.now(UTC).date())
    fallow = {
        "crops": ["fallow"],
        "sow_date": f"{year}-06-20",
        "harvest_date": harvest.isoformat(),
        "status": "harvested",
    }
    assert client.post(f"{base}/seasons", json=fallow, headers=csrf(client)).status_code == 201
    after = client.get(f"{base}/climate").json()["soil_now"]
    assert after["assumed"] == [] and after["replayed"] == []
    assert after["recorded_fallow"] is True


def test_fallow_cannot_be_mixed_with_crops(client):
    register(client)
    farm = make_farm(client)
    body = {"crops": ["fallow", "soybean"], "sow_date": "2025-06-20", "harvest_date": "2025-09-28"}
    response = client.post(f"/api/v1/farms/{farm['id']}/seasons", json=body, headers=csrf(client))
    assert response.status_code == 422


def test_catalog_says_where_prices_come_from(client):
    economics = client.get("/api/v1/crops").json()["economics"]
    assert "chickpea" in economics["price_sources"]["msp_rabi"]
    assert "cotton" in economics["price_sources"]["msp_kharif"]
    assert economics["validated"] is False
