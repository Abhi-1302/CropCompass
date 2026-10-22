from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.models import Farm, PasswordReset
from tests.conftest import csrf, register

PASSWORD = "monsoon-rains-2026"
NEW_PASSWORD = "kharif-sowing-2027"


def login(client: TestClient, password: str, email: str = "asha@example.com"):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password})


def test_change_password_signs_out_other_sessions(client):
    register(client)
    with TestClient(client.app, base_url="http://testserver") as other:
        assert login(other, PASSWORD).status_code == 200
        url = "/api/v1/account/password"
        wrong = client.post(
            url, json={"current_password": "not-it", "new_password": NEW_PASSWORD}, headers=csrf(client)
        )
        assert wrong.status_code == 400
        assert client.post(url, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}).status_code == 403
        same = {"current_password": PASSWORD, "new_password": "asha@example.com"}
        assert client.post(url, json=same, headers=csrf(client)).status_code == 422
        ok = client.post(url, json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}, headers=csrf(client))
        assert ok.status_code == 204
        assert client.get("/api/v1/auth/me").status_code == 200  # this session stays
        assert other.get("/api/v1/auth/me").status_code == 401  # the other one is signed out
    client.cookies.clear()
    assert login(client, PASSWORD).status_code == 401
    assert login(client, NEW_PASSWORD).status_code == 200


def test_wrong_current_password_is_rate_limited(client):
    register(client)
    body = {"current_password": "wrong-password", "new_password": NEW_PASSWORD}
    for _ in range(5):
        assert client.post("/api/v1/account/password", json=body, headers=csrf(client)).status_code == 400
    assert client.post("/api/v1/account/password", json=body, headers=csrf(client)).status_code == 429


def capture_emails(monkeypatch) -> list[dict]:
    sent: list[dict] = []
    monkeypatch.setattr(
        "app.routers.auth.send_email",
        lambda settings, to, subject, body: sent.append({"to": to, "subject": subject, "body": body}),
    )
    return sent


def test_password_reset_flow(client, monkeypatch):
    sent = capture_emails(monkeypatch)
    register(client)
    client.cookies.clear()

    unknown = client.post("/api/v1/auth/password/forgot", json={"email": "nobody@example.com"})
    known = client.post("/api/v1/auth/password/forgot", json={"email": "ASHA@example.com"})
    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json()  # never reveals whether an account exists
    assert known.json()["delivery"] == "development"
    assert [mail["to"] for mail in sent] == ["asha@example.com"]
    token = re.search(r"/reset-password#token=(\S+)", sent[0]["body"]).group(1)

    reset = "/api/v1/auth/password/reset"
    assert client.post(reset, json={"token": "x" * 43, "password": NEW_PASSWORD}).status_code == 400
    assert client.post(reset, json={"token": token, "password": "short"}).status_code == 422
    assert client.post(reset, json={"token": token, "password": NEW_PASSWORD}).status_code == 204
    assert client.post(reset, json={"token": token, "password": "another-pass-123"}).status_code == 400  # single use
    assert login(client, PASSWORD).status_code == 401
    assert login(client, NEW_PASSWORD).status_code == 200


def test_reset_signs_out_everywhere_and_links_expire(client, monkeypatch, session_factory):
    sent = capture_emails(monkeypatch)
    register(client)
    client.post("/api/v1/auth/password/forgot", json={"email": "asha@example.com"})
    token = re.search(r"#token=(\S+)", sent[-1]["body"]).group(1)
    assert (
        client.post("/api/v1/auth/password/reset", json={"token": token, "password": NEW_PASSWORD}).status_code == 204
    )
    assert client.get("/api/v1/auth/me").status_code == 401

    assert login(client, NEW_PASSWORD).status_code == 200
    client.post("/api/v1/auth/password/forgot", json={"email": "asha@example.com"})
    token = re.search(r"#token=(\S+)", sent[-1]["body"]).group(1)
    with session_factory() as db:
        db.execute(update(PasswordReset).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    assert client.post("/api/v1/auth/password/reset", json={"token": token, "password": PASSWORD}).status_code == 400


def test_forgot_password_is_rate_limited_per_email(client, monkeypatch):
    capture_emails(monkeypatch)
    for _ in range(3):
        assert client.post("/api/v1/auth/password/forgot", json={"email": "asha@example.com"}).status_code == 202
    assert client.post("/api/v1/auth/password/forgot", json={"email": "asha@example.com"}).status_code == 429


def test_unconfigured_deployed_reset_reports_service_state_for_every_email(client, session_factory):
    register(client)
    client.app.state.settings.cookie_secure = True
    url = "/api/v1/auth/password/forgot"
    known = client.post(url, json={"email": "asha@example.com"})
    unknown = client.post(url, json={"email": "nobody@example.com"})
    assert known.json() == unknown.json()
    assert known.json()["delivery"] == "unavailable"
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(PasswordReset)) == 0


def test_configured_reset_reports_request_not_delivery(client, monkeypatch):
    sent = capture_emails(monkeypatch)
    register(client)
    client.app.state.settings.smtp_host = "smtp.example.com"
    response = client.post("/api/v1/auth/password/forgot", json={"email": "asha@example.com"})
    assert response.json()["delivery"] == "email" and len(sent) == 1
    assert "will be attempted" in response.json()["detail"]


def test_export_contains_the_users_data_but_no_secrets(client):
    register(client)
    farm = client.post("/api/v1/farms", json={"name": "Plot", "lat": 17.2, "lon": 78.3}, headers=csrf(client)).json()
    season = {"crops": ["soybean"], "sow_date": "2025-06-20", "harvest_date": "2025-09-28", "status": "harvested"}
    client.post(f"/api/v1/farms/{farm['id']}/seasons", json=season, headers=csrf(client))

    response = client.get("/api/v1/account/export")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    data = response.json()
    assert data["account"]["email"] == "asha@example.com"
    assert data["farms"][0]["name"] == "Plot" and data["farms"][0]["soil_map"]["source"] == "soilgrids"
    assert [s["crops"] for s in data["farms"][0]["seasons"]] == [["soybean"]]
    text = json.dumps(data)
    assert "password" not in text and "token" not in text


def test_delete_account_removes_everything(client, session_factory):
    register(client)
    client.post("/api/v1/farms", json={"name": "Plot", "lat": 17.2, "lon": 78.3}, headers=csrf(client))
    url = "/api/v1/account/delete"
    assert client.post(url, json={"password": "wrong-password"}, headers=csrf(client)).status_code == 400
    assert client.post(url, json={"password": PASSWORD}).status_code == 403  # CSRF token required
    assert client.post(url, json={"password": PASSWORD}, headers=csrf(client)).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401
    assert login(client, PASSWORD).status_code == 401
    with session_factory() as db:
        assert db.scalar(select(func.count()).select_from(Farm)) == 0
