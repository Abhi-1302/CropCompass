from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.engine import make_url

from app.config import Settings
from app.db import make_engine, make_session_factory
from app.models import (
    ClimateCell,
    Farm,
    Plan,
    SeasonRecord,
    SoilProfile,
    User,
    UserSession,
    VegetationSeries,
    WeatherYear,
)
from tests.conftest import csrf, register
from tests.test_history_api import SOYBEAN


@pytest.fixture
def neon_engine():
    env_file = os.environ.get("CROPCOMPASS_NEON_TEST_ENV")
    if not env_file:
        pytest.skip("Set CROPCOMPASS_NEON_TEST_ENV to a disposable Neon branch env file")
    assert Path(env_file).is_file(), "Test environment file must exist"
    settings = Settings(_env_file=env_file)
    target = make_url(settings.database_url)
    production = make_url(Settings().database_url)
    assert target.drivername == "postgresql+psycopg"
    assert (target.host or "").endswith(".neon.tech")
    assert (target.host or "").replace("-pooler", "") != (production.host or "").replace("-pooler", ""), (
        "Refusing to run fixture-based tests against the configured application database"
    )
    engine = make_engine(settings.database_url)
    try:
        with engine.connect() as connection:
            assert connection.connection.driver_connection.pgconn.ssl_in_use
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def session_factory(neon_engine):
    return make_session_factory(neon_engine)


def test_neon_persistence_advice_and_account_cleanup(client, session_factory, neon_engine):
    email = f"neon.qa.{uuid.uuid4().hex}@example.com"
    other_email = f"neon.other.{uuid.uuid4().hex}@example.com"
    created_cells: set[str] = set()
    with session_factory() as db:
        existing_cells = set(db.scalars(select(ClimateCell.id)))
        assert not existing_cells, "Use a fresh disposable branch without shared weather data"
    try:
        register(client, email=email)
        user_id = uuid.UUID(client.get("/api/v1/auth/me").json()["id"])
        created = client.post(
            "/api/v1/farms",
            json={"name": "Neon integration farm", "lat": 17.2, "lon": 78.3},
            headers=csrf(client),
        )
        assert created.status_code == 201, created.text
        farm_id = uuid.UUID(created.json()["id"])
        base = f"/api/v1/farms/{farm_id}"
        with session_factory() as db:
            farm = db.get(Farm, farm_id)
            created_cells.add(farm.cell_id)
            assert farm.data_status == "ready"
            assert farm.created_at.tzinfo is not None
            assert isinstance(db.get(SoilProfile, farm_id).summary, dict)
            checkpoint = db.get(WeatherYear, (farm.cell_id, 2024))
            assert isinstance(checkpoint.series, bytes) and checkpoint.series
            assert isinstance(checkpoint.provenance, dict)

        journal = client.post(f"{base}/seasons", json=SOYBEAN, headers=csrf(client))
        assert journal.status_code == 201, journal.text
        assert client.get(f"{base}/vegetation").json()["status"] == "ready"
        advice = client.post(
            f"{base}/advice/next-crop", json={"season": "rabi", "irrigation": "protective"}, headers=csrf(client)
        )
        assert advice.status_code == 200, advice.text
        choice = advice.json()["options"][0]["id"]
        saved = client.post(
            f"{base}/plans",
            json={
                "kind": "next_crop",
                "title": "Neon persistence check",
                "choice": choice,
                "season": "rabi",
                "irrigation": "protective",
            },
            headers=csrf(client),
        )
        assert saved.status_code == 201, saved.text
        plan_id = uuid.UUID(saved.json()["id"])
        assert client.post("/api/v1/auth/logout", headers=csrf(client)).status_code == 204
        neon_engine.dispose()
        login = client.post("/api/v1/auth/login", json={"email": email, "password": "monsoon-rains-2026"})
        assert login.status_code == 200, login.text
        assert client.get(f"{base}/plans").json()[0]["id"] == str(plan_id)
        assert client.get(f"{base}/seasons").json()[0]["crops"] == SOYBEAN["crops"]
        exported = client.get("/api/v1/account/export")
        assert exported.status_code == 200
        assert exported.json()["farms"][0]["plans"][0]["id"] == str(plan_id)
        with session_factory() as db:
            assert db.get(Plan, plan_id).inputs == saved.json()["inputs"]

        assert client.post("/api/v1/auth/logout", headers=csrf(client)).status_code == 204
        register(client, email=other_email)
        assert client.get(f"{base}/plans").status_code == 404
        assert (
            client.post(
                "/api/v1/account/delete", json={"password": "monsoon-rains-2026"}, headers=csrf(client)
            ).status_code
            == 204
        )
        assert (
            client.post("/api/v1/auth/login", json={"email": email, "password": "monsoon-rains-2026"}).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/account/delete", json={"password": "monsoon-rains-2026"}, headers=csrf(client)
            ).status_code
            == 204
        )
        with session_factory() as db:
            assert db.get(User, user_id) is None
            assert db.get(Farm, farm_id) is None
            assert db.get(Plan, plan_id) is None
            assert db.get(SoilProfile, farm_id) is None
            assert db.get(VegetationSeries, farm_id) is None
            assert db.scalar(select(SeasonRecord.id).where(SeasonRecord.farm_id == farm_id)) is None
            assert db.scalar(select(UserSession.id).where(UserSession.user_id == user_id)) is None
    finally:
        with session_factory() as db:
            user_ids = list(db.scalars(select(User.id).where(User.email.in_([email, other_email]))))
            created_cells.update(db.scalars(select(Farm.cell_id).where(Farm.user_id.in_(user_ids))))
            db.execute(delete(User).where(User.id.in_(user_ids)))
            for cell_id in created_cells - existing_cells:
                if db.scalar(select(Farm.id).where(Farm.cell_id == cell_id)) is None:
                    db.execute(delete(ClimateCell).where(ClimateCell.id == cell_id))
            db.commit()
