from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User
from tests.conftest import csrf, register


def enable_guests(settings):
    settings.guest_enabled = True
    settings.guest_abuse_hmac_key = "guest-test-secret-not-for-production-12345"


def guest(client):
    response = client.post(
        "/api/v1/auth/guest",
        json={},
        headers={"Origin": "http://testserver", **csrf(client)}
        if client.cookies.get("af_csrf")
        else {"Origin": "http://testserver"},
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


def test_guest_lifecycle(client, settings, session_factory):
    enable_guests(settings)
    identity = guest(client)
    assert identity["is_guest"] and identity["email"] is None
    assert guest(client)["id"] == identity["id"]
    assert client.get("/api/v1/auth/me").json()["guest_expires_at"]
    assert client.get("/api/v1/account/export").json()["account"]["is_guest"]
    old_token = client.cookies.get("af_session")
    response = client.post(
        "/api/v1/account/convert-guest",
        json={
            "name": "New farmer",
            "email": "converted@example.com",
            "password": "guest-conversion-123",
        },
        headers=csrf(client),
    )
    assert response.status_code == 200, response.text
    assert response.json()["id"] == identity["id"]
    assert not response.json()["is_guest"] and response.json()["guest_expires_at"] is None
    assert client.cookies.get("af_session") != old_token
    assert client.post("/api/v1/account/guest/delete", json={"confirm": True}, headers=csrf(client)).status_code == 409


def test_guest_expiry_and_security(client, settings, session_factory):
    import uuid

    enable_guests(settings)
    assert client.post("/api/v1/auth/guest", json={}).status_code == 403
    identity = guest(client)
    assert client.post("/api/v1/account/guest/delete", json={"confirm": True}).status_code == 403
    assert (
        client.post(
            "/api/v1/auth/register",
            json={
                "email": "another@example.com",
                "name": "Other",
                "password": "another-password",
            },
        ).status_code
        == 409
    )
    with session_factory() as db:
        user = db.get(User, uuid.UUID(identity["id"]))
        user.guest_last_active_at = datetime.now(UTC) - timedelta(days=31)
        user.guest_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    assert client.get("/api/v1/auth/me").status_code == 401
    assert not client.cookies.get("af_session")


def test_guest_conflict_and_delete(client, settings):
    enable_guests(settings)
    register(client)
    client.post("/api/v1/auth/logout", headers=csrf(client))
    identity = guest(client)
    conflict = client.post(
        "/api/v1/account/convert-guest",
        json={
            "email": "ASHA@example.com",
            "name": "Other",
            "password": "another-password",
        },
        headers=csrf(client),
    )
    assert conflict.status_code == 409
    assert client.get("/api/v1/auth/me").json()["id"] == identity["id"]
    assert client.post("/api/v1/account/guest/delete", json={"confirm": False}, headers=csrf(client)).status_code == 422
    assert client.post("/api/v1/account/guest/delete", json={"confirm": True}, headers=csrf(client)).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_guest_identity_constraints(session_factory):
    now = datetime.now(UTC)
    with session_factory() as db:
        regular = User(name="Registered", email="regular@example.com", password_hash="test-hash")
        guest = User(
            name="Guest",
            is_guest=True,
            registered_at=None,
            guest_last_active_at=now,
            guest_expires_at=now + timedelta(days=30),
        )
        db.add_all([regular, guest])
        db.commit()
        assert regular.registered_at is not None
        assert guest.email is None and guest.password_hash is None
        assert guest.registered_at is None
        guest.email = "invalid@example.com"
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_guest_farm_conversion_preserves_data_and_isolation(client, settings, session_factory):
    import uuid

    from sqlalchemy import select

    from app.models import Farm, SeasonRecord, UserSession
    from tests.test_history_api import SOYBEAN

    enable_guests(settings)
    identity = guest(client)
    response = client.post("/api/v1/farms", json={"name": "Guest farm", "lat": 17, "lon": 78.125}, headers=csrf(client))
    assert response.status_code == 201, response.text
    farm_id = response.json()["id"]
    record = client.post(f"/api/v1/farms/{farm_id}/seasons", json=SOYBEAN, headers=csrf(client))
    assert record.status_code == 201
    previous_token = client.cookies.get("af_session")
    converted = client.post(
        "/api/v1/account/convert-guest",
        json={
            "email": "kept@example.com",
            "name": "Kept",
            "password": "monsoon-rains-2026",
        },
        headers=csrf(client),
    )
    assert converted.status_code == 200
    assert converted.json()["id"] == identity["id"]
    assert client.get(f"/api/v1/farms/{farm_id}/seasons").json()[0]["id"] == record.json()["id"]
    with session_factory() as db:
        assert db.get(Farm, uuid.UUID(farm_id)).user_id == uuid.UUID(identity["id"])
        assert db.get(SeasonRecord, uuid.UUID(record.json()["id"]))
        from app.security import hash_token

        assert db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(previous_token))) is None
    client.post("/api/v1/auth/logout", headers=csrf(client))
    guest(client)
    assert client.get(f"/api/v1/farms/{farm_id}").status_code == 404
    assert client.get(f"/api/v1/farms/{farm_id}/seasons").status_code == 404
    assert client.get("/api/v1/account/export").json()["farms"] == []


def test_activity_and_cleanup(client, settings, session_factory):
    import uuid

    from sqlalchemy import select

    from app.guest_cleanup import cleanup
    from app.models import Farm, UserSession
    from app.security import as_utc

    enable_guests(settings)
    identity = guest(client)
    user_id = uuid.UUID(identity["id"])
    with session_factory() as db:
        user = db.get(User, user_id)
        user.guest_last_active_at = datetime.now(UTC) - timedelta(days=25)
        user.guest_expires_at = datetime.now(UTC) + timedelta(days=5)
        db.commit()
    assert client.get("/api/v1/auth/me").json()["guest_expiring_soon"]
    renewed = client.post("/api/v1/auth/guest/activity", json={}, headers=csrf(client))
    assert renewed.status_code == 200
    assert not renewed.json()["guest_expiring_soon"]
    with session_factory() as db:
        user = db.get(User, user_id)
        session = db.scalar(select(UserSession).where(UserSession.user_id == user_id))
        assert as_utc(user.guest_expires_at) == as_utc(session.expires_at)
        user.guest_last_active_at = datetime.now(UTC) - timedelta(days=31)
        user.guest_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        farm = Farm(name="Expired", user_id=user_id, lat=17, lon=78, cell_id="guest-test")
        db.add(farm)
        db.commit()
        farm_id = farm.id
    assert cleanup(session_factory)["remaining"] == 1
    with session_factory() as db:
        assert db.get(User, user_id)
    result = cleanup(session_factory, execute=True, batch_size=1)
    assert result["deleted"] == 1 and result["remaining"] == 0
    assert cleanup(session_factory, execute=True)["deleted"] == 0
    with session_factory() as db:
        assert db.get(Farm, farm_id) is None
        assert db.scalar(select(UserSession).where(UserSession.user_id == user_id)) is None


def test_creation_limits_survive_deletion(client, settings):
    enable_guests(settings)
    settings.guest_creations_per_ip_hour = 1
    guest(client)
    client.post("/api/v1/account/guest/delete", json={"confirm": True}, headers=csrf(client))
    response = client.post("/api/v1/auth/guest", json={}, headers={"Origin": "http://testserver"})
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0


def test_guest_budget_settles_after_conversion(client, settings, session_factory):
    import uuid

    from app.models import ChatThread, ChatUsageDaily
    from app.services.sprout import begin_run, finish_run
    from app.sprout_schemas import ChatSendIn

    enable_guests(settings)
    identity = guest(client)
    user_id = uuid.UUID(identity["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.commit()
        thread_id = thread.id
    run, created = begin_run(
        session_factory,
        user_id,
        thread_id,
        ChatSendIn(
            text="Help",
            intent="help",
            request_id=uuid.uuid4(),
            expected_version=0,
        ),
        settings,
        network="test-network",
    )
    assert created
    response = client.post(
        "/api/v1/account/convert-guest",
        json={
            "email": "budget@example.com",
            "name": "Budget",
            "password": "monsoon-rains-2026",
        },
        headers=csrf(client),
    )
    assert response.status_code == 200
    finish_run(session_factory, user_id, uuid.UUID(run["id"]), state="cancelled", usage=123)
    with session_factory() as db:
        for scope in ("global", "guest:global", f"user:{user_id}"):
            assert db.get(ChatUsageDaily, (scope, datetime.now(UTC).date())).tokens == 123


def test_migration_preserves_registered_children(tmp_path, monkeypatch):
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.config import get_settings
    from app.db import make_engine

    path = tmp_path / "guest-migration.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path.as_posix()}")
    get_settings.cache_clear()
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    try:
        command.upgrade(config, "0006")
        engine = make_engine(f"sqlite:///{path.as_posix()}")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id,email,password_hash,name,created_at) "
                    "VALUES (:id,'old@example.com','hash','Old',CURRENT_TIMESTAMP)"
                ),
                {"id": "1" * 32},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions (id,user_id,token_hash,csrf_token,created_at,expires_at) "
                    "VALUES (:id,:owner,'token','csrf',CURRENT_TIMESTAMP,'2099-01-01')"
                ),
                {"id": "2" * 32, "owner": "1" * 32},
            )
        command.upgrade(config, "head")
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT count(*) FROM sessions")) == 1
            assert connection.scalar(text("SELECT registered_at = created_at FROM users")) == 1
            assert not connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
            connection.execute(
                text(
                    "INSERT INTO users (id,email,password_hash,name,created_at) "
                    "VALUES (:id,'legacy@example.com','hash','Legacy',CURRENT_TIMESTAMP)"
                ),
                {"id": "3" * 32},
            )
        command.downgrade(config, "0006")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM sessions")) == 1
        engine.dispose()
    finally:
        get_settings.cache_clear()


def test_postgres_guest_migration_compiles(monkeypatch):
    from io import StringIO
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    from app.config import get_settings

    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost/unused")
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", "postgresql://test:test@localhost/unused")
    get_settings.cache_clear()
    output = StringIO()
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"), output_buffer=output)
    config.set_main_option("script_location", str(root / "migrations"))
    try:
        command.upgrade(config, "0006:0007", sql=True)
        sql = output.getvalue()
        assert "ck_user_identity" in sql and "CREATE TABLE guest_counters" in sql
        assert "ALTER COLUMN email DROP NOT NULL" in sql
        assert "guest_budget_charged" in sql
    finally:
        get_settings.cache_clear()


def test_durable_counter_concurrent_limit(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    from fastapi import HTTPException
    from sqlalchemy import select

    from app.db import Base, make_engine, make_session_factory
    from app.models import GuestCounter
    from app.services.guests import consume

    engine = make_engine(f"sqlite:///{(tmp_path / 'counters.db').as_posix()}")
    Base.metadata.create_all(engine)
    factory = make_session_factory(engine)

    def attempt(_index):
        with factory() as db:
            try:
                consume(db, "test", "shared", 86400, 3)
                db.commit()
                return True
            except HTTPException as error:
                assert error.status_code == 429
                return False

    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            assert sum(pool.map(attempt, range(16))) == 3
        with factory() as db:
            assert db.scalar(select(GuestCounter.count).where(GuestCounter.action == "test")) == 3
    finally:
        engine.dispose()


def test_guest_sprout_stream_quota_and_deletion(client, settings, session_factory):
    import uuid

    from sqlalchemy import select

    from app.models import ChatMessage, ChatThread, ChatUsageDaily
    from tests.test_sprout import FakeModel, enable_chat

    enable_guests(settings)
    enable_chat(client)
    settings.guest_sprout_daily_requests = 1
    identity = guest(client)
    thread_response = client.post("/api/v1/chat/threads", json={}, headers=csrf(client))
    assert thread_response.status_code == 201
    thread = thread_response.json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    body = {
        "text": "What can CropCompass do?",
        "intent": "help",
        "request_id": str(uuid.uuid4()),
        "expected_version": 0,
        "allow_ai": True,
    }
    response = client.post(url + "/messages", json=body, headers=csrf(client))
    assert response.status_code == 200 and "event: done" in response.text, response.text
    assert "event: existing" in client.post(url + "/messages", json=body, headers=csrf(client)).text
    assert FakeModel.calls == 1
    limited = client.post(
        url + "/messages", json={**body, "request_id": str(uuid.uuid4()), "expected_version": 1}, headers=csrf(client)
    )
    assert limited.status_code == 429
    assert client.post("/api/v1/account/guest/delete", json={"confirm": True}, headers=csrf(client)).status_code == 204
    with session_factory() as db:
        assert db.get(ChatThread, uuid.UUID(thread["id"])) is None
        assert db.scalar(select(ChatMessage.id)) is None
        assert db.get(ChatUsageDaily, (f"user:{identity['id']}", datetime.now(UTC).date())) is None
        assert db.get(ChatUsageDaily, ("guest:global", datetime.now(UTC).date())).tokens == 120


def test_guest_limits_and_disabled_creation(client, settings):
    assert not client.get("/api/v1/auth/capabilities").json()["guest_enabled"]
    assert client.post("/api/v1/auth/guest", json={}, headers={"Origin": "http://testserver"}).status_code == 503
    enable_guests(settings)
    identity = guest(client)
    settings.guest_enabled = False
    assert guest(client)["id"] == identity["id"]
    assert client.get("/api/v1/account/export").status_code == 200
    assert client.post("/api/v1/auth/guest/activity", json={}, headers=csrf(client)).status_code == 200
    settings.guest_max_farms = 1
    first = client.post("/api/v1/farms", json={"name": "One", "lat": 17, "lon": 78.125}, headers=csrf(client))
    assert first.status_code == 201
    second = client.post("/api/v1/farms", json={"name": "Two", "lat": 17, "lon": 78.125}, headers=csrf(client))
    assert second.status_code == 409 and second.json()["detail"] == "guest_farm_limit"
