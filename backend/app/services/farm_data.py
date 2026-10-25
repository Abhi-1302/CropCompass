"""Background job that builds a farm's data: the climate cell and the soil profile."""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable

import httpx
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import Farm, SoilProfile
from app.services.climate_cache import ensure_cell
from engine.ingest.power import PowerError, snap_to_cell
from engine.ingest.soilgrids import SoilGridsError, fetch_profile
from engine.soil.ptf import summarize_profile

log = logging.getLogger(__name__)
USER_AGENT = "CropCompass/0.1 (NASA Space Apps 2026)"
ClientFactory = Callable[[Settings], httpx.Client]
_running: set[uuid.UUID] = set()
_guard = threading.Lock()


def default_http_client(settings: Settings) -> httpx.Client:
    return httpx.Client(timeout=settings.http_timeout_s, headers={"User-Agent": USER_AGENT}, follow_redirects=True)


def _set_status(session_factory: sessionmaker, farm_id: uuid.UUID, status: str, message: str | None) -> None:
    with session_factory() as db:
        farm = db.get(Farm, farm_id)
        if farm is not None:
            farm.data_status, farm.data_error = status, message
            db.commit()


def build_farm_data(
    session_factory: sessionmaker,
    settings: Settings,
    farm_id: uuid.UUID,
    client_factory: ClientFactory = default_http_client,
) -> None:
    with _guard:
        if farm_id in _running:
            return
        _running.add(farm_id)
    try:
        _build_farm_data(session_factory, settings, farm_id, client_factory)
    finally:
        with _guard:
            _running.discard(farm_id)


def _build_farm_data(
    session_factory: sessionmaker,
    settings: Settings,
    farm_id: uuid.UUID,
    client_factory: ClientFactory,
) -> None:
    notes: list[str] = []
    try:
        with session_factory() as db, client_factory(settings) as client:
            farm = db.get(Farm, farm_id)
            if farm is None:
                return
            if db.get(SoilProfile, farm.id) is None:
                try:
                    layers = fetch_profile(farm.lat, farm.lon, client)
                    db.add(
                        SoilProfile(
                            farm_id=farm.id, source="soilgrids", layers=layers, summary=summarize_profile(layers)
                        )
                    )
                    db.commit()
                except (SoilGridsError, httpx.HTTPError, ValueError) as exc:
                    db.rollback()
                    log.warning("Soil data unavailable for farm %s: %s", farm_id, exc)
                    notes.append("Soil data is unavailable here; a standard soil is assumed until you add yours.")
            ensure_cell(
                db, snap_to_cell(farm.lat, farm.lon), client, settings.power_stale_days, settings.power_refresh_days
            )
    except (PowerError, httpx.HTTPError, ValueError) as exc:
        log.warning("Climate data build failed for farm %s: %s", farm_id, exc)
        _set_status(
            session_factory,
            farm_id,
            "error",
            "Weather download or verification failed. "
            "Historical planning advice may still be available; refresh to resume. "
            "Your journal and soil values are available.",
        )
        return
    except Exception:
        log.exception("Unexpected error while building data for farm %s", farm_id)
        _set_status(session_factory, farm_id, "error", "Something went wrong while preparing this farm's data.")
        return
    _set_status(session_factory, farm_id, "ready", " ".join(notes) or None)
