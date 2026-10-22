"""Background download of a farm's MODIS NDVI history, and the satellite view of its crop seasons."""

from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, date, datetime, timedelta

import httpx
import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.models import Farm, SeasonRecord, VegetationSeries
from app.security import as_utc
from app.services.farm_data import ClientFactory, default_http_client
from engine.crops.catalog import season_for_peak, season_for_sowing
from engine.ingest.modis import MAX_DATES_PER_REQUEST, ModisError, available_dates, fetch_ndvi
from engine.vegetation.phenology import detect_seasons, smooth

log = logging.getLogger(__name__)

WORKERS = 3
SAVE_EVERY_CHUNKS = 3
# A new 16-day composite normally appears within ~8 days of its period ending.
REFRESH_AFTER_DAYS = 24
MIN_OVERLAP_DAYS = 30
# ORNL takes ~30 s per request regardless of load, so a few parallel calls multiply throughput; cap them globally.
_request_slots = threading.BoundedSemaphore(WORKERS)
_running: set[uuid.UUID] = set()
_running_guard = threading.Lock()


def is_running(farm_id: uuid.UUID) -> bool:
    with _running_guard:
        return farm_id in _running


def missing_chunks(available: list[tuple[str, date]], have: set[str]) -> list[list[str]]:
    """Request-sized runs of consecutive composites not downloaded yet, newest first."""
    runs: list[list[str]] = []
    current: list[str] = []
    for code, day in available:
        if day.isoformat() in have:
            if current:
                runs.append(current)
                current = []
        else:
            current.append(code)
    if current:
        runs.append(current)
    chunks = []
    for run in reversed(runs):
        for end in range(len(run), 0, -MAX_DATES_PER_REQUEST):
            chunks.append(run[max(0, end - MAX_DATES_PER_REQUEST) : end])
    return chunks


def needs_download(row: VegetationSeries | None, farm_id: uuid.UUID) -> bool:
    if is_running(farm_id):
        return False
    if row is None or row.status in ("pending", "partial"):
        return True  # never started, or interrupted (e.g. server restart)
    if row.status == "ready":
        newest = max(row.ndvi) if row.ndvi else None
        behind = newest is None or (datetime.now(UTC).date() - date.fromisoformat(newest)).days > REFRESH_AFTER_DAYS
        return behind and datetime.now(UTC) - as_utc(row.updated_at) > timedelta(days=1)
    return False


def _fetch_chunk(lat: float, lon: float, chunk: list[str], client: httpx.Client) -> dict[date, float | None]:
    with _request_slots:
        return fetch_ndvi(lat, lon, chunk, client)


def _save(db: Session, row: VegetationSeries, ndvi: dict, status: str, total: int, error: str | None = None) -> bool:
    if db.scalar(select(Farm.id).where(Farm.id == row.farm_id)) is None:
        return False  # farm deleted while downloading
    row.ndvi, row.status, row.composites_total, row.error = dict(ndvi), status, total, error
    db.commit()
    return True


def build_vegetation(
    session_factory: sessionmaker,
    settings: Settings,
    farm_id: uuid.UUID,
    client_factory: ClientFactory = default_http_client,
) -> None:
    with _running_guard:
        if farm_id in _running:
            return
        _running.add(farm_id)
    try:
        _download(session_factory, settings, farm_id, client_factory)
    finally:
        with _running_guard:
            _running.discard(farm_id)


def _download(session_factory: sessionmaker, settings: Settings, farm_id: uuid.UUID, client_factory: ClientFactory):
    with session_factory() as db:
        farm = db.get(Farm, farm_id)
        if farm is None:
            return
        row = db.get(VegetationSeries, farm_id)
        if row is None:
            row = VegetationSeries(farm_id=farm_id, ndvi={}, status="pending", composites_total=0)
            db.add(row)
            db.commit()
        ndvi = dict(row.ndvi or {})
        total = row.composites_total
        try:
            with client_factory(settings) as client:
                available = available_dates(farm.lat, farm.lon, client)
                total = len(available)
                chunks = missing_chunks(available, set(ndvi))
                if not _save(db, row, ndvi, "partial" if chunks else "ready", total):
                    return
                if not chunks:
                    return
                pool = ThreadPoolExecutor(WORKERS)
                try:
                    futures = [pool.submit(_fetch_chunk, farm.lat, farm.lon, chunk, client) for chunk in chunks]
                    for done, future in enumerate(as_completed(futures), start=1):
                        ndvi.update({day.isoformat(): value for day, value in future.result().items()})
                        if done % SAVE_EVERY_CHUNKS == 0 and not _save(db, row, ndvi, "partial", total):
                            return
                finally:
                    pool.shutdown(wait=False, cancel_futures=True)
            _save(db, row, ndvi, "ready", total)
        except (ModisError, httpx.HTTPError, ValueError) as exc:
            log.warning("Vegetation download failed for farm %s: %s", farm_id, exc)
            db.rollback()
            _save(db, row, ndvi, "error", total, "Could not download the satellite history. You can resume it later.")


def _overlap_days(start_a: date, end_a: date, start_b: date, end_b: date) -> int:
    return max(0, (min(end_a, end_b) - max(start_a, start_b)).days)


def vegetation_view(db: Session, farm: Farm) -> dict:
    row = db.get(VegetationSeries, farm.id)
    if row is None:
        return {
            "status": "pending",
            "running": is_running(farm.id),
            "progress": {"done": 0, "total": 0},
            "error": None,
            "updated_at": None,
            "points": [],
            "seasons": [],
        }
    items = sorted((row.ndvi or {}).items())
    points: list[dict] = []
    seasons: list[dict] = []
    if len(items) >= 5:
        series = pd.Series([np.nan if v is None else v for _, v in items], index=pd.to_datetime([k for k, _ in items]))
        frame = smooth(series)
        points = [
            {
                "date": day.date().isoformat(),
                "raw": None if np.isnan(raw) else round(float(raw), 3),
                "smooth": round(float(fit), 3),
            }
            for day, raw, fit in zip(frame.index, frame["raw"], frame["smooth"], strict=True)
        ]
        records = db.scalars(select(SeasonRecord).where(SeasonRecord.farm_id == farm.id)).all()
        seasons = _describe(detect_seasons(frame["smooth"]), farm.region, records)
    return {
        "status": row.status,
        "running": is_running(farm.id),
        "progress": {"done": len(items), "total": row.composites_total},
        "error": row.error,
        "updated_at": as_utc(row.updated_at).isoformat(),
        "points": points,
        "seasons": seasons,
    }


def _describe(detected, region: str | None, records) -> list[dict]:
    today = datetime.now(UTC).date()
    out = []
    for season in detected:
        sowing, harvest = season.est_sowing, season.est_harvest
        in_progress = season.senescence is None
        if region == "IN":
            # A crop still growing has no real peak yet, so its green-up date decides the season.
            label, year = season_for_sowing(season.green_up) if in_progress else season_for_peak(season.peak)
        else:
            label, year = "other", sowing.year
        end = harvest or today
        logged = any(
            _overlap_days(sowing, end, r.sow_date, r.harvest_date or today) >= MIN_OVERLAP_DAYS for r in records
        )
        out.append(
            {
                "season": label,
                "season_year": year,
                "green_up": season.green_up.isoformat(),
                "peak": season.peak.isoformat(),
                "senescence": season.senescence.isoformat() if season.senescence else None,
                "est_sowing": sowing.isoformat(),
                "est_harvest": harvest.isoformat() if harvest else None,
                "length_days": season.length_days,
                "peak_ndvi": season.peak_ndvi,
                "in_progress": in_progress,
                "logged": logged,
            }
        )
    for item in out:
        peers = [o["peak_ndvi"] for o in out if o["season"] == item["season"] and not o["in_progress"]]
        enough = len(peers) >= 5 and not item["in_progress"]
        item["vigour_percentile"] = round(float(np.mean(np.array(peers) <= item["peak_ndvi"])), 2) if enough else None
    return out
