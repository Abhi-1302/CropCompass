from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.models import ClimateCell, Farm
from tests.conftest import csrf, register

TELANGANA = {"name": "Shadnagar plot", "lat": 17.2, "lon": 78.3, "area_ha": 1.5}


def create_farm(client, body=TELANGANA):
    response = client.post("/api/v1/farms", json=body, headers=csrf(client))
    assert response.status_code == 201, response.text
    return response.json()


def test_create_farm_builds_climate_and_soil(client, fake_sources):
    register(client)
    farm = create_farm(client)
    assert farm["cell_id"] == "17.000_78.125"
    assert farm["region"] == "IN"

    detail = client.get(f"/api/v1/farms/{farm['id']}").json()
    assert detail["data_status"] == "ready", detail

    climate = client.get(f"/api/v1/farms/{farm['id']}/climate").json()
    assert climate["period"]["n_years"] >= 30
    assert climate["assumptions"]["awc_source"] == "soilgrids"
    assert len(climate["monthly"]) == 12
    assert climate["monsoon"]["onset"]["p_by_jun_30"]["n"] == climate["period"]["n_years"]
    assert 0 <= climate["current_season"]["rain_percentile"] <= 1

    soil = client.get(f"/api/v1/farms/{farm['id']}/soil").json()
    assert soil["summary"]["topsoil"]["texture"] == "clay loam"
    assert soil["summary"]["awc_mm"] > 0
    assert fake_sources == {"power": datetime.now(UTC).year - 1980, "soil": 1}


def test_farms_in_same_cell_share_one_download(client, fake_sources):
    register(client)
    create_farm(client)
    create_farm(client, {**TELANGANA, "name": "Second plot", "lat": 17.1, "lon": 78.2})
    assert fake_sources["power"] == datetime.now(UTC).year - 1980
    assert fake_sources["soil"] == 2


def test_farm_outside_india_has_no_monsoon_block(client):
    register(client)
    farm = create_farm(client, {"name": "Iowa", "lat": 42.0, "lon": -93.6})
    climate = client.get(f"/api/v1/farms/{farm['id']}/climate").json()
    assert farm["region"] is None
    assert climate["monsoon"] is None
    assert climate["growing_season"]["windows"]


def test_other_users_cannot_see_or_delete_farm(client):
    register(client)
    farm = create_farm(client)
    client.post("/api/v1/auth/logout", headers=csrf(client))
    register(client, email="ravi@example.com", name="Ravi")
    assert client.get(f"/api/v1/farms/{farm['id']}").status_code == 404
    assert client.get(f"/api/v1/farms/{farm['id']}/climate").status_code == 404
    assert client.delete(f"/api/v1/farms/{farm['id']}", headers=csrf(client)).status_code == 404
    assert client.get("/api/v1/farms").json() == []


def test_farm_create_requires_csrf_and_valid_coordinates(client):
    register(client)
    assert client.post("/api/v1/farms", json=TELANGANA).status_code == 403
    bad = client.post("/api/v1/farms", json={**TELANGANA, "lat": 95}, headers=csrf(client))
    assert bad.status_code == 422


def test_update_and_delete_farm(client):
    register(client)
    farm = create_farm(client)
    updated = client.patch(
        f"/api/v1/farms/{farm['id']}", json={"name": "Renamed", "irrigation": "protective"}, headers=csrf(client)
    ).json()
    assert (updated["name"], updated["irrigation"]) == ("Renamed", "protective")
    assert client.delete(f"/api/v1/farms/{farm['id']}", headers=csrf(client)).status_code == 204
    assert client.get(f"/api/v1/farms/{farm['id']}").status_code == 404


def test_signed_out_requests_are_rejected(client):
    assert client.get("/api/v1/farms").status_code == 401


def test_refresh_resumes_a_pending_farm_after_interruption(client, session_factory):
    register(client)
    farm = create_farm(client)
    with session_factory() as db:
        db.get(Farm, uuid.UUID(farm["id"])).data_status = "pending"
        db.commit()
    root = f"/api/v1/farms/{farm['id']}"
    assert client.post(f"{root}/refresh", headers=csrf(client)).status_code == 202
    assert client.get(root).json()["data_status"] == "ready"


def test_quarantine_uses_checked_history_for_low_confidence_advice(client, session_factory):
    register(client)
    farm = create_farm(client)
    root = f"/api/v1/farms/{farm['id']}"
    assert client.get(f"{root}/climate").status_code == 200
    assert client.post(f"{root}/advice/next-crop", json={}, headers=csrf(client)).status_code == 200
    with session_factory() as db:
        row = db.get(ClimateCell, farm["cell_id"])
        row.quality = "needs_attention"
        row.series = b"Unverified blob must never be decoded"
        db.get(Farm, uuid.UUID(farm["id"])).data_status = "error"
        db.commit()
    assert client.get(f"{root}/climate").status_code == 409
    advice = client.post(f"{root}/advice/next-crop", json={}, headers=csrf(client))
    assert advice.status_code == 200, advice.text
    context = advice.json()["weather_context"]
    assert context["confidence"] == "low"
    assert context["mode"] == "historical_proxy"
    assert context["reference_year"] == datetime.now(UTC).year - 1
    assert context["checked_through"] == f"{datetime.now(UTC).year - 1}-12-31"
    assert advice.json()["confidence"]["level"] == "low"
    assert "weather_proxy" in advice.json()["confidence"]["flags"]
    assert client.get(f"{root}/sources").json()["advice"]["weather_context"] == context
    assert client.get(f"{root}/crop-fit").status_code == 409
    assert client.get(f"{root}/soil").status_code == 200
    assert client.get(f"{root}/seasons").status_code == 200
    assert client.get(f"{root}/sources").json()["weather"]["status"] == "needs_attention"
    assert client.get(root).json()["data_status"] == "limited"
    assert client.get("/api/v1/farms").json()[0]["data_status"] == "limited"
    with session_factory() as db:
        assert db.get(Farm, uuid.UUID(farm["id"])).data_status == "error"


def test_low_confidence_advice_requires_continuous_checked_history(client, session_factory):
    from app.models import WeatherYear

    register(client)
    farm = create_farm(client)
    root = f"/api/v1/farms/{farm['id']}"
    with session_factory() as db:
        db.get(ClimateCell, farm["cell_id"]).quality = "needs_attention"
        db.delete(db.get(WeatherYear, (farm["cell_id"], datetime.now(UTC).year - 2)))
        db.commit()
    assert client.post(f"{root}/advice/next-crop", json={}, headers=csrf(client)).status_code == 409
    assert client.get(f"{root}/sources").json()["advice"]["available"] is False


def test_advice_proxy_leap_day_and_revision(session_factory):
    from datetime import date

    from app.models import WeatherYear
    from app.services.climate_cache import advice_weather_context, load_advice_frame
    from engine.ingest.codec import encode
    from engine.ingest.power import VALIDATION_VERSION
    from tests.conftest import synthetic_power

    with session_factory() as db:
        row = ClimateCell(
            id="proxy-test", lat=17, lon=78, series=b"", first_date=date(1981, 1, 1), last_date=date(2023, 12, 31)
        )
        db.add(row)
        for year in range(1981, 2024):
            db.add(
                WeatherYear(
                    cell_id=row.id,
                    year=year,
                    series=encode(synthetic_power(f"{year}-01-01", f"{year}-12-31")),
                    provenance={},
                    validation_version=VALIDATION_VERSION,
                )
            )
        db.commit()
        context = advice_weather_context(db, row, date(2024, 3, 2))
        frame = load_advice_frame(db, row, context)
        assert frame.loc["2024-02-29"].equals(frame.loc["2023-02-28"])
        assert frame.loc["2024-03-01"].equals(frame.loc["2023-03-01"])
        assert frame.index[-1].date() == date(2024, 3, 1)
        assert advice_weather_context(db, row, date(2024, 3, 3))["revision"] != context["revision"]
        checkpoint = db.get(WeatherYear, (row.id, 2023))
        checkpoint.checked_at = datetime(2026, 1, 1)
        db.commit()
        assert advice_weather_context(db, row, date(2024, 3, 2))["revision"] != context["revision"]


def test_annual_repair_resumes_without_publishing_partial_history(session_factory, monkeypatch):
    from datetime import date

    import pytest

    from app.services import climate_cache
    from engine.ingest.power import Cell, PowerError, PowerSeries
    from tests.conftest import synthetic_power

    cell = Cell(17, 78.125)
    calls = []
    failing = True

    def fetch(cell, year, end, monthly, client):
        calls.append(year)
        if year == 2024 and failing:
            raise PowerError("Daily/monthly disagreement")
        return PowerSeries(synthetic_power(f"{year}-01-01", min(end, date(year, 12, 31)).isoformat()), 500)

    monkeypatch.setattr(climate_cache, "FIRST_DATE", date(2023, 1, 1))
    monkeypatch.setattr(climate_cache, "fetch_monthly", lambda *args: {})
    monkeypatch.setattr(climate_cache, "fetch_verified_year", fetch)
    with session_factory() as db:
        with pytest.raises(PowerError):
            climate_cache.ensure_cell(db, cell, None, 4, 60, date(2024, 12, 31))
        row = db.get(ClimateCell, cell.id)
        assert row.quality == "needs_attention" and row.revision is None and row.series == b""
        failing = False
        row = climate_cache.ensure_cell(db, cell, None, 4, 60, date(2024, 12, 31))
        assert calls == [2023, 2024, 2024]
        assert row.quality == "verified" and row.revision and row.years_done == 2
        assert len(climate_cache.load_frame(row)) == 731
