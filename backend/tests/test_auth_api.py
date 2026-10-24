from __future__ import annotations

from tests.conftest import csrf, register


def test_register_me_logout_login_flow(client):
    register(client)
    assert client.get("/api/v1/auth/me").json()["email"] == "asha@example.com"

    assert client.post("/api/v1/auth/logout").status_code == 403  # no CSRF header
    assert client.post("/api/v1/auth/logout", headers=csrf(client)).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401

    bad = client.post("/api/v1/auth/login", json={"email": "asha@example.com", "password": "wrong-password"})
    assert bad.status_code == 401
    assert bad.json()["detail"] == "Invalid email or password."
    ok = client.post("/api/v1/auth/login", json={"email": "ASHA@example.com", "password": "monsoon-rains-2026"})
    assert ok.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 200


def test_session_cookie_is_httponly_and_samesite(client):
    response = register(client)
    cookies = response.headers.get_list("set-cookie")
    session = next(c for c in cookies if c.startswith("af_session="))
    csrf_cookie = next(c for c in cookies if c.startswith("af_csrf="))
    assert "HttpOnly" in session and "samesite=lax" in session.lower()
    assert "HttpOnly" not in csrf_cookie


def test_unknown_email_gets_same_error_as_wrong_password(client):
    register(client)
    response = client.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "whatever-123"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password."


def test_duplicate_email_is_rejected_case_insensitively(client):
    register(client)
    response = client.post(
        "/api/v1/auth/register", json={"email": "Asha@Example.com", "password": "another-pass-123", "name": "A"}
    )
    assert response.status_code == 409


def test_password_rules(client):
    short = client.post("/api/v1/auth/register", json={"email": "a@example.com", "password": "short", "name": "A"})
    assert short.status_code == 422
    same = client.post(
        "/api/v1/auth/register", json={"email": "longname@example.com", "password": "longname@example.com", "name": "A"}
    )
    assert same.status_code == 422


def test_repeated_failed_logins_are_rate_limited(client):
    register(client)
    for _ in range(5):
        client.post("/api/v1/auth/login", json={"email": "asha@example.com", "password": "wrong-password"})
    blocked = client.post("/api/v1/auth/login", json={"email": "asha@example.com", "password": "monsoon-rains-2026"})
    assert blocked.status_code == 429


def test_foreign_origin_is_rejected(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "asha@example.com", "password": "monsoon-rains-2026"},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403


def test_security_headers(client):
    response = client.get("/api/v1/health")
    assert response.json() == {"status": "ok"}
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
