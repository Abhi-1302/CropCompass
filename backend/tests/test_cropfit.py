from __future__ import annotations

from datetime import date

import pytest

from engine.crops.catalog import crop_params
from engine.planner.common import FarmInputs, JournalEntry, default_season, season_instance, window_dates
from engine.planner.cropfit import crop_fit
from tests.conftest import csrf, register, synthetic_power

TODAY = date(2026, 10, 16)
FRAME = synthetic_power(end="2026-10-10")


def farm(*history: JournalEntry, soc: float | None = 48.0) -> FarmInputs:
    return FarmInputs(
        frame=FRAME,
        lat=17.0,
        elevation_m=550.0,
        region="IN",
        awc_mm_per_m=127.0,
        awc_source="soilgrids",
        tew_mm=22.0,
        soc_t_ha=soc,
        clay_pct=30.0,
        history=history,
    )


def by_id(result: dict) -> dict:
    return {crop["id"]: crop for crop in result["crops"]}


def test_season_calendar():
    assert [default_season(date(2026, m, 10)) for m in (1, 2, 5, 10)] == ["rabi", "summer", "kharif", "rabi"]
    assert window_dates(("12-01", "01-31"), "rabi", 2026) == (date(2026, 12, 1), date(2027, 1, 31))
    assert window_dates(("01-05", "02-15"), "rabi", 2026) == (date(2027, 1, 5), date(2027, 2, 15))
    kharif = [crop_params("IN", c) for c in ("maize", "cotton", "soybean")]
    assert season_instance("kharif", kharif, TODAY) == 2027
    assert season_instance("rabi", [crop_params("IN", "chickpea")], TODAY) == 2026


def test_rabi_crop_fit_across_past_years():
    result = crop_fit(farm(), None, "rainfed", TODAY)
    assert (result["season"], result["season_year"]) == ("rabi", 2026)
    assert result["period"]["n_years"] >= 30
    crops = by_id(result)
    assert {"chickpea", "wheat", "mustard"} <= crops.keys() and "cotton" not in crops
    for crop in result["crops"]:
        y = crop["yield"]
        assert y["p10"] <= y["p50"] <= y["p90"] <= y["attainable"]
        assert 0 <= crop["water"]["met"] <= 1
        assert len(y["by_year"]) == result["period"]["n_years"]
    assert crops["chickpea"]["sowing"]["window"] == ["10-01", "11-15"]
    assert crops["chickpea"]["carbon"]["kept"]["mid"] > crops["chickpea"]["carbon"]["removed"]["mid"]
    assert result["carbon"]["baseline_source"] == "default"


def test_irrigation_closes_the_water_gap():
    rainfed = by_id(crop_fit(farm(), "rabi", "rainfed", TODAY))["wheat"]
    irrigated = by_id(crop_fit(farm(), "rabi", "full", TODAY))["wheat"]
    assert irrigated["water"]["met"] == pytest.approx(1.0, abs=0.01)
    assert irrigated["water"]["irrigation_mm"] > 100
    assert irrigated["yield"]["p50"] > rainfed["yield"]["p50"]


def test_a_long_crop_still_in_the_field_delays_the_next_one():
    cotton = JournalEntry(("cotton",), "kharif", date(2026, 6, 15), None, "in_field")
    chickpea = by_id(crop_fit(farm(cotton), "rabi", "rainfed", TODAY))["chickpea"]
    assert chickpea["sowing"]["late"]["p"] == 1.0
    calendar = next(rule for rule in chickpea["rules"] if rule["rule"] == "calendar")
    assert calendar["facts"]["ready"] == "2026-12-07"
    assert any(rule["rule"] == "shared_pest" for rule in chickpea["rules"])


def test_journal_history_feeds_rules_nitrogen_and_carbon_baseline():
    pigeonpea = JournalEntry(
        ("pigeonpea",), "kharif", date(2026, 6, 15), date(2026, 10, 5), "harvested", residue="incorporated"
    )
    result = crop_fit(farm(pigeonpea), "rabi", "rainfed", TODAY)
    assert result["previous"]["replayed"] and result["carbon"]["baseline_source"] == "journal"
    wheat = by_id(result)["wheat"]
    assert (wheat["nitrogen"]["credit"], wheat["nitrogen"]["extra"]) == (
        35,
        20,
    )  # woody stalks ploughed in 27 days before
    assert wheat["nitrogen"]["to_apply"] == 120 - 35 + 20
    chickpea = by_id(result)["chickpea"]
    assert any(rule["rule"] == "same_family" for rule in chickpea["rules"])
    assert chickpea["succession_factor"] < 1
    old = JournalEntry(
        ("pigeonpea",), "kharif", date(2025, 6, 20), date(2026, 1, 5), "harvested", residue="incorporated"
    )
    assert by_id(crop_fit(farm(old), "rabi", "rainfed", TODAY))["wheat"]["nitrogen"]["credit"] == 0


def test_green_manure_and_missing_soil_carbon():
    result = crop_fit(farm(soc=None), "kharif", "rainfed", TODAY)
    sunn_hemp = by_id(result)["sunn_hemp"]
    assert sunn_hemp["nitrogen"]["leaves"] == 80
    assert result["carbon"] is None and sunn_hemp["carbon"] is None
    assert result["season_year"] == 2027


FARM = {"name": "Shadnagar plot", "lat": 17.2, "lon": 78.3}


def test_crop_fit_api(client):
    register(client)
    farm_id = client.post("/api/v1/farms", json=FARM, headers=csrf(client)).json()["id"]
    response = client.get(f"/api/v1/farms/{farm_id}/crop-fit", params={"season": "rabi", "irrigation": "protective"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["irrigation"] == "protective" and body["crops"]
    assert body["soil"]["source"] == "soilgrids"
    assert client.get(f"/api/v1/farms/{farm_id}/crop-fit", params={"season": "monsoon"}).status_code == 422

    abroad = client.post("/api/v1/farms", json={**FARM, "lat": 41.6, "lon": -93.6}, headers=csrf(client)).json()
    blocked = client.get(f"/api/v1/farms/{abroad['id']}/crop-fit")
    assert blocked.status_code == 409 and "region" in blocked.json()["detail"]

    client.cookies.clear()
    register(client, email="ravi@example.com")
    assert client.get(f"/api/v1/farms/{farm_id}/crop-fit").status_code == 404
