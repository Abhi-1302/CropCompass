from __future__ import annotations

from tests.conftest import csrf, register

FARM = {"name": "Shadnagar plot", "lat": 17.2, "lon": 78.3}
SOYBEAN = {
    "crops": ["soybean"],
    "sow_date": "2024-06-20",
    "harvest_date": "2024-09-25",
    "status": "harvested",
    "residue": "mulched",
    "problems": ["pod_borer"],
    "yield_kg_ha": 1200,
}


def make_farm(client) -> str:
    response = client.post("/api/v1/farms", json=FARM, headers=csrf(client))
    assert response.status_code == 201, response.text
    return response.json()["id"]


def seasons_url(farm_id: str) -> str:
    return f"/api/v1/farms/{farm_id}/seasons"


def test_crop_catalog_is_public_and_complete(client):
    catalog = client.get("/api/v1/crops").json()
    ids = {crop["id"] for crop in catalog["crops"]}
    assert {"chickpea", "pigeonpea", "cotton", "tomato", "other"} <= ids
    assert catalog["families"]["Fabaceae"]["nutrient_role"] == "nitrogen fixer"
    assert "pod_borer" in catalog["problems"]


def test_season_journal_crud(client):
    register(client)
    farm_id = make_farm(client)
    created = client.post(seasons_url(farm_id), json=SOYBEAN, headers=csrf(client))
    assert created.status_code == 201, created.text
    record = created.json()
    assert (record["season"], record["season_year"]) == ("kharif", 2024)

    moved = client.patch(
        f"{seasons_url(farm_id)}/{record['id']}",
        json={"crops": ["chickpea"], "sow_date": "2024-10-20", "harvest_date": "2025-02-10"},
        headers=csrf(client),
    )
    assert moved.status_code == 200, moved.text
    assert (moved.json()["season"], moved.json()["season_year"]) == ("rabi", 2024)

    bad = client.patch(
        f"{seasons_url(farm_id)}/{record['id']}", json={"harvest_date": "2024-01-01"}, headers=csrf(client)
    )
    assert bad.status_code == 422

    assert len(client.get(seasons_url(farm_id)).json()) == 1
    assert client.delete(f"{seasons_url(farm_id)}/{record['id']}", headers=csrf(client)).status_code == 204
    assert client.get(seasons_url(farm_id)).json() == []


def test_january_sowing_belongs_to_previous_rabi(client):
    register(client)
    farm_id = make_farm(client)
    body = {**SOYBEAN, "crops": ["wheat"], "sow_date": "2025-01-05", "harvest_date": "2025-04-10"}
    record = client.post(seasons_url(farm_id), json=body, headers=csrf(client)).json()
    assert (record["season"], record["season_year"]) == ("rabi", 2024)


def test_season_validation(client):
    register(client)
    farm_id = make_farm(client)
    invalid = [
        {**SOYBEAN, "crops": ["banana-tree"]},
        {**SOYBEAN, "crops": ["maize", "maize"]},
        {**SOYBEAN, "problems": ["locusts-from-space"]},
        {**SOYBEAN, "harvest_date": None},
        {**SOYBEAN, "harvest_date": "2024-05-01"},
        {**SOYBEAN, "status": "in_field", "sow_date": "2099-06-01", "harvest_date": None},
        {**SOYBEAN, "crops": []},
    ]
    for body in invalid:
        response = client.post(seasons_url(farm_id), json=body, headers=csrf(client))
        assert response.status_code == 422, (body, response.text)


def test_seasons_are_private(client):
    register(client)
    farm_id = make_farm(client)
    record = client.post(seasons_url(farm_id), json=SOYBEAN, headers=csrf(client)).json()
    client.post("/api/v1/auth/logout", headers=csrf(client))
    register(client, email="ravi@example.com", name="Ravi")
    assert client.get(seasons_url(farm_id)).status_code == 404
    assert client.delete(f"{seasons_url(farm_id)}/{record['id']}", headers=csrf(client)).status_code == 404


def test_vegetation_history_is_downloaded_newest_first(client, fake_modis):
    register(client)
    farm_id = make_farm(client)
    view = client.get(f"/api/v1/farms/{farm_id}/vegetation").json()
    assert view["status"] == "ready"
    assert view["progress"]["done"] == view["progress"]["total"] > 100
    chunks = fake_modis["chunks"]
    newest = max(code for chunk in chunks for code in chunk)
    assert all(len(chunk) <= 10 for chunk in chunks)
    assert any(newest in chunk and len(chunk) == 10 for chunk in chunks[:3])  # 3 parallel workers

    kharif = [s for s in view["seasons"] if s["season"] == "kharif" and not s["in_progress"]]
    assert len(kharif) >= 5
    assert all(s["peak"][5:7] in {"09", "10"} for s in kharif)
    cloud = next(p for p in view["points"] if p["date"].endswith("-07-12"))
    assert cloud["raw"] == 0.12 and cloud["smooth"] > 0.2


def test_logged_season_marks_satellite_season(client):
    register(client)
    farm_id = make_farm(client)
    view = client.get(f"/api/v1/farms/{farm_id}/vegetation").json()
    target = next(s for s in view["seasons"] if s["season_year"] == 2023 and s["season"] == "kharif")
    assert target["logged"] is False
    body = {**SOYBEAN, "sow_date": target["est_sowing"], "harvest_date": target["est_harvest"], "source": "satellite"}
    assert client.post(seasons_url(farm_id), json=body, headers=csrf(client)).status_code == 201
    view = client.get(f"/api/v1/farms/{farm_id}/vegetation").json()
    assert next(s for s in view["seasons"] if s["peak"] == target["peak"])["logged"] is True


def test_vegetation_download_can_resume_after_error(client, fake_modis):
    fake_modis["fail"] = True
    register(client)
    farm_id = make_farm(client)
    failed = client.get(f"/api/v1/farms/{farm_id}/vegetation").json()
    assert failed["status"] == "error" and failed["error"]

    fake_modis["fail"] = False
    resumed = client.post(f"/api/v1/farms/{farm_id}/vegetation/refresh", headers=csrf(client))
    assert resumed.status_code == 202
    assert client.get(f"/api/v1/farms/{farm_id}/vegetation").json()["status"] == "ready"
