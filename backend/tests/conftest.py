from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Base, make_engine, make_session_factory
from app.main import create_app
from engine.ingest.power import PowerSeries

DEPTHS = [
    ("0-5cm", 0, 5),
    ("5-15cm", 5, 15),
    ("15-30cm", 15, 30),
    ("30-60cm", 30, 60),
    ("60-100cm", 60, 100),
    ("100-200cm", 100, 200),
]
SOIL_LAYERS = [
    {
        "depth": d,
        "top_cm": t,
        "bottom_cm": b,
        "sand": 40.0,
        "silt": 30.0,
        "clay": 30.0,
        "soc": 10.0,
        "bdod": 1.5,
        "phh2o": 6.8,
        "cec": 24.0,
        "nitrogen": 1.5,
    }
    for d, t, b in DEPTHS
]


def synthetic_power(start: str = "1991-01-01", end: str | None = None, seed: int = 7) -> pd.DataFrame:
    """Monsoon-like daily weather (dry winters, wet Jun-Oct) for tests that must not hit the network."""
    end = end or datetime.now(UTC).date().isoformat()
    rng = np.random.default_rng(seed)
    index = pd.date_range(start, end, freq="D")
    doy = index.dayofyear.to_numpy()
    monsoon = np.exp(-(((doy - 220) / 45.0) ** 2))
    rain = rng.gamma(0.6, 12.0, len(index)) * (rng.random(len(index)) < 0.05 + 0.6 * monsoon)
    tmax = 33 + 5 * np.sin(2 * np.pi * (doy - 60) / 365) - 4 * monsoon + rng.normal(0, 1.2, len(index))
    tmin = tmax - 11 + 3 * monsoon
    return pd.DataFrame(
        {
            "PRECTOTCORR": rain,
            "T2M_MAX": tmax,
            "T2M_MIN": tmin,
            "T2MDEW": tmin - 2 + 6 * monsoon,
            "WS2M": 2.5 + monsoon,
            "ALLSKY_SFC_SW_DWN": 20 - 5 * monsoon,
            "PS": 95.0,
        },
        index=index,
    ).round(2)


@pytest.fixture
def settings() -> Settings:
    return Settings(_env_file=None, database_url="sqlite://", cookie_secure=False, allowed_origins="http://testserver")


def modis_composites(first_year: int = 2015, until: date | None = None) -> list[tuple[str, date]]:
    """MOD13Q1 composite dates (day-of-year 1, 17, 33, ...) as (code, date) pairs."""
    until = until or datetime.now(UTC).date() - timedelta(days=10)
    out = []
    for year in range(first_year, until.year + 1):
        for doy in range(1, 366, 16):
            day = date(year, 1, 1) + timedelta(days=doy - 1)
            if day <= until:
                out.append((f"A{year}{doy:03d}", day))
    return out


def synthetic_ndvi(day: date) -> float:
    """One kharif crop a year peaking in late September, plus a cloud dip every July 12."""
    doy = day.timetuple().tm_yday
    value = 0.25 + 0.45 * np.exp(-(((doy - 270) / 35.0) ** 2))
    return round(0.12 if (day.month, day.day) == (7, 12) else value, 4)


@pytest.fixture
def fake_modis(monkeypatch) -> dict:
    calls = {"dates": 0, "chunks": [], "fail": False}
    composites = modis_composites()
    by_code = dict(composites)

    def fake_available_dates(lat, lon, client):
        calls["dates"] += 1
        return composites

    def fake_fetch_ndvi(lat, lon, codes, client):
        if calls["fail"]:
            from engine.ingest.modis import ModisError

            raise ModisError("service unavailable")
        calls["chunks"].append(list(codes))
        return {by_code[code]: synthetic_ndvi(by_code[code]) for code in codes}

    monkeypatch.setattr("app.services.vegetation.available_dates", fake_available_dates)
    monkeypatch.setattr("app.services.vegetation.fetch_ndvi", fake_fetch_ndvi)
    return calls


@pytest.fixture
def session_factory():
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    yield make_session_factory(engine)
    engine.dispose()


@pytest.fixture
def fake_sources(monkeypatch) -> dict:
    calls = {"power": 0, "soil": 0}
    frame = synthetic_power("1981-01-01")

    def fake_fetch_verified_year(cell, year, end, monthly, client):
        calls["power"] += 1
        return PowerSeries(frame.loc[f"{year}-01-01" : min(end, date(year, 12, 31)).isoformat()], elevation_m=500.0)

    def fake_fetch_profile(lat, lon, client, **_kwargs):
        calls["soil"] += 1
        return SOIL_LAYERS

    monkeypatch.setattr("app.services.climate_cache.fetch_verified_year", fake_fetch_verified_year)
    monkeypatch.setattr("app.services.climate_cache.fetch_monthly", lambda *args: {})
    monkeypatch.setattr("app.services.farm_data.fetch_profile", fake_fetch_profile)
    return calls


@pytest.fixture
def client(settings, session_factory, fake_sources, fake_modis):
    with TestClient(create_app(settings, session_factory), base_url="http://testserver") as test_client:
        yield test_client


def register(
    client: TestClient, email: str = "asha@example.com", password: str = "monsoon-rains-2026", name: str = "Asha"
):
    response = client.post("/api/v1/auth/register", json={"email": email, "password": password, "name": name})
    assert response.status_code == 201, response.text
    return response


def csrf(client: TestClient) -> dict:
    return {"X-CSRF-Token": client.cookies.get("af_csrf")}
