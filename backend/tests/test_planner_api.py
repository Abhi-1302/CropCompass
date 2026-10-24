from __future__ import annotations

import uuid

from app.models import ClimateCell, Farm, Plan
from tests.conftest import csrf, register

FARM = {"name": "Shadnagar plot", "lat": 17.2, "lon": 78.3}


def make_farm(client) -> str:
    register(client)
    return client.post("/api/v1/farms", json=FARM, headers=csrf(client)).json()["id"]


def test_next_crop_advice_and_priorities(client):
    farm_id = make_farm(client)
    url = f"/api/v1/farms/{farm_id}/advice/next-crop"
    advice = client.post(url, json={"season": "rabi", "irrigation": "protective"}, headers=csrf(client))
    assert advice.status_code == 200, advice.text
    body = advice.json()
    assert body["options"][0]["rank"] == 1 and body["weights"] == {"income": 1, "water": 1, "soil": 1, "risk": 1}
    assert {"mm", "fraction", "percentile"} <= body["soil_now"].keys()

    saved = client.patch(
        f"/api/v1/farms/{farm_id}",
        json={"priorities": {"income": 3, "water": 0, "soil": 1, "risk": 2}},
        headers=csrf(client),
    )
    assert saved.json()["priorities"] == {"income": 3, "water": 0, "soil": 1, "risk": 2}
    again = client.post(url, json={"season": "rabi"}, headers=csrf(client)).json()
    assert again["weights"] == {"income": 3, "water": 0, "soil": 1, "risk": 2}
    assert client.post(url, json={"weights": {"income": 9}}, headers=csrf(client)).status_code == 422
    assert client.post(url, json={"season": "rabi"}).status_code == 403  # CSRF token required


def test_rotations_stress_test_and_plans(client):
    farm_id = make_farm(client)
    base = f"/api/v1/farms/{farm_id}"
    explored = client.post(f"{base}/advice/rotations", json={}, headers=csrf(client))
    assert explored.status_code == 200, explored.text
    rotations = explored.json()
    assert rotations["options"] and rotations["current"]["key"] == "maize+fallow+fallow>maize+fallow+fallow"
    keys = [option["key"] for option in rotations["options"][:2]]

    stressed = client.post(
        f"{base}/advice/stress-test", json={"kind": "rotation", "rotations": keys}, headers=csrf(client)
    )
    assert stressed.status_code == 200, stressed.text
    assert [r["key"] for r in stressed.json()["rotations"]] == keys
    missing = client.post(f"{base}/advice/stress-test", json={"kind": "rotation"}, headers=csrf(client))
    assert missing.status_code == 422

    plan = client.post(
        f"{base}/plans", json={"kind": "rotation", "title": "Two-year plan", "choice": keys[0]}, headers=csrf(client)
    )
    assert plan.status_code == 201, plan.text
    assert plan.json()["option"]["key"] == keys[0] and plan.json()["engine_version"]
    bad = client.post(f"{base}/plans", json={"kind": "rotation", "title": "x", "choice": "nope"}, headers=csrf(client))
    assert bad.status_code == 422
    plans = client.get(f"{base}/plans").json()
    assert [p["title"] for p in plans] == ["Two-year plan"]

    client.cookies.clear()
    register(client, email="ravi@example.com")
    assert client.get(f"{base}/plans").status_code == 404
    assert client.post(f"{base}/advice/rotations", json={}, headers=csrf(client)).status_code == 404


def test_plan_delete(client, session_factory):
    farm_id = make_farm(client)
    base = f"/api/v1/farms/{farm_id}"
    advice = client.post(
        f"{base}/advice/next-crop", json={"season": "rabi", "irrigation": "protective"}, headers=csrf(client)
    ).json()
    choice = advice["options"][0]["id"]
    plan = client.post(
        f"{base}/plans",
        json={"kind": "next_crop", "title": "Rabi", "choice": choice, "season": "rabi", "irrigation": "protective"},
        headers=csrf(client),
    ).json()
    assert plan["inputs"]["season"] == "rabi"
    assert plan["weather_status"] == "current" and plan["inputs"]["weather_revision"]
    with session_factory() as db:
        farm = db.get(Farm, uuid.UUID(farm_id))
        cell_id = farm.cell_id
        weather = db.get(ClimateCell, cell_id)
        weather.revision = str(uuid.uuid4())
        db.commit()
    assert client.get(f"{base}/plans").json()[0]["weather_status"] == "outdated"
    with session_factory() as db:
        weather = db.get(ClimateCell, cell_id)
        weather.quality = "needs_attention"
        db.commit()
    assert client.get(f"{base}/plans").json()[0]["weather_status"] == "unverified"
    with session_factory() as db:
        assert db.get(Plan, uuid.UUID(plan["id"])).option == plan["option"]
    assert client.delete(f"{base}/plans/{plan['id']}", headers=csrf(client)).status_code == 204
    assert client.get(f"{base}/plans").json() == []


def test_low_confidence_rotations_stress_and_saved_provenance(client, session_factory):
    farm_id = make_farm(client)
    base = f"/api/v1/farms/{farm_id}"
    with session_factory() as db:
        farm = db.get(Farm, uuid.UUID(farm_id))
        db.get(ClimateCell, farm.cell_id).quality = "needs_attention"
        farm.data_status = "error"
        db.commit()
    response = client.post(f"{base}/advice/rotations", json={}, headers=csrf(client))
    assert response.status_code == 200, response.text
    advice = response.json()
    assert advice["confidence"]["level"] == "low"
    choice = advice["options"][0]["key"]
    stress = client.post(
        f"{base}/advice/stress-test", json={"kind": "rotation", "rotations": [choice]}, headers=csrf(client)
    )
    assert stress.status_code == 200, stress.text
    assert stress.json()["weather_context"] == advice["weather_context"]
    saved = client.post(
        f"{base}/plans",
        json={"kind": "rotation", "choice": choice, "title": "Historical scenario"},
        headers=csrf(client),
    )
    assert saved.status_code == 201, saved.text
    plan = saved.json()
    assert plan["weather_status"] == "low_confidence"
    assert plan["inputs"]["weather_context"] == advice["weather_context"]
    with session_factory() as db:
        db.get(ClimateCell, farm.cell_id).quality = "verified"
        db.commit()
    assert client.get(f"{base}/plans").json()[0]["weather_status"] == "outdated"
    assert client.get(f"{base}/plans").json()[0]["inputs"]["weather_context"]["confidence"] == "low"
