"""NASA POWER data cached per grid cell in the database, plus an in-process LRU of decoded frames."""

from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256

import httpx
import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ClimateCell, WeatherYear
from engine.ingest import codec
from engine.ingest.power import FIRST_DATE, VALIDATION_VERSION, Cell, PowerError, fetch_monthly, fetch_verified_year

_MAX_FRAMES = 32
_cell_locks: dict[str, threading.Lock] = {}
_cell_locks_guard = threading.Lock()
_frames: OrderedDict[tuple[str, str], pd.DataFrame] = OrderedDict()
_frames_guard = threading.Lock()


def _lock_for(cell_id: str) -> threading.Lock:
    with _cell_locks_guard:
        return _cell_locks.setdefault(cell_id, threading.Lock())


def ensure_cell(
    db: Session,
    cell: Cell,
    client: httpx.Client,
    stale_days: int,
    refresh_days: int,
    today: date | None = None,
) -> ClimateCell:
    """Publish only fully verified history; each annual checkpoint survives an interrupted build."""
    today = today or datetime.now(UTC).date()
    with _lock_for(cell.id):
        row = db.get(ClimateCell, cell.id)
        now = datetime.now(UTC)
        if (
            row is not None
            and row.quality == "verified"
            and row.validation_version == VALIDATION_VERSION
            and (today - row.last_date).days <= stale_days
        ):
            row.last_used_at = now
            db.commit()
            return row
        if row is None:
            row = ClimateCell(
                id=cell.id, lat=cell.lat, lon=cell.lon, series=b"", first_date=FIRST_DATE, last_date=FIRST_DATE
            )
            db.add(row)
        row.quality, row.quality_error = "downloading", None
        row.years_total = today.year - FIRST_DATE.year + 1
        row.years_done = 0
        db.commit()
        try:
            monthly = fetch_monthly(cell, FIRST_DATE.year, today.year, client)
            frames = []
            refresh_start = (today - timedelta(days=refresh_days)).year
            for year in range(FIRST_DATE.year, today.year + 1):
                checkpoint = db.get(WeatherYear, (cell.id, year))
                reusable = (
                    checkpoint is not None
                    and checkpoint.validation_version == VALIDATION_VERSION
                    and year < refresh_start
                )
                if not reusable:
                    row.quality = "validating"
                    db.commit()
                    fetched = fetch_verified_year(cell, year, today, monthly, client)
                    if checkpoint is None:
                        checkpoint = WeatherYear(cell_id=cell.id, year=year)
                        db.add(checkpoint)
                    checkpoint.series = codec.encode(fetched.data)
                    checkpoint.provenance = {
                        "header": fetched.provenance,
                        "units": fetched.units,
                        "time_standard": "LST",
                        "monthly_check": "POWER consistency, not independent ground truth",
                    }
                    checkpoint.validation_version = VALIDATION_VERSION
                    checkpoint.checked_at = datetime.now(UTC)
                    row.elevation_m = fetched.elevation_m if fetched.elevation_m is not None else row.elevation_m
                frames.append(codec.decode(checkpoint.series))
                row.years_done += 1
                row.quality = "downloading"
                db.commit()
            frame = pd.concat(frames).sort_index()
            if not frame.index.equals(pd.date_range(FIRST_DATE, frame.index[-1])):
                raise PowerError("Verified annual checkpoints do not form a complete daily history")
            row.series = codec.encode(frame)
            row.first_date, row.last_date = frame.index[0].date(), frame.index[-1].date()
            row.revision = str(uuid.uuid4())
            row.validation_version = VALIDATION_VERSION
            row.quality, row.quality_error = "verified", None
            row.fetched_at = row.last_used_at = row.validated_at = datetime.now(UTC)
            db.commit()
        except Exception as exc:
            db.rollback()
            row.quality, row.quality_error = "needs_attention", str(exc)[:1000]
            db.commit()
            raise
        return row


def require_verified(row: ClimateCell | None) -> ClimateCell:
    if row is None or row.quality != "verified" or not row.revision or row.validation_version != VALIDATION_VERSION:
        raise LookupError(
            "Weather is not verified. Refresh to resume validation; historical planning advice may still be available."
        )
    return row


def load_frame(row: ClimateCell) -> pd.DataFrame:
    """Decoded daily frame for a cell; the blob is read from the DB only on a cache miss (saves egress)."""
    require_verified(row)
    key = (row.id, row.revision)
    with _frames_guard:
        frame = _frames.get(key)
        if frame is not None:
            _frames.move_to_end(key)
            return frame
    frame = codec.decode(row.series)
    with _frames_guard:
        _frames[key] = frame
        while len(_frames) > _MAX_FRAMES:
            _frames.popitem(last=False)
    return frame


def advice_weather_context(db: Session, row: ClimateCell | None, today: date | None = None) -> dict:
    today = today or datetime.now(UTC).date()
    if row is None:
        raise LookupError("Weather history is still being prepared.")
    if row.quality == "verified" and row.revision and row.validation_version == VALIDATION_VERSION:
        return {
            "mode": "observed",
            "confidence": "standard",
            "revision": row.revision,
            "checked_through": row.last_date.isoformat(),
            "reference_year": None,
            "proxy_from": None,
            "proxy_through": None,
        }
    checkpoints = db.execute(
        select(WeatherYear.year, WeatherYear.checked_at)
        .where(
            WeatherYear.cell_id == row.id,
            WeatherYear.validation_version == VALIDATION_VERSION,
            WeatherYear.year < today.year,
        )
        .order_by(WeatherYear.year)
    ).all()
    years = [checkpoint.year for checkpoint in checkpoints]
    if len(years) < 30 or years != list(range(years[0], today.year)):
        raise LookupError("Advice needs at least 30 consecutive checked years through last December. Refresh data.")
    fingerprint = sha256(
        repr((VALIDATION_VERSION, [(entry.year, entry.checked_at.isoformat()) for entry in checkpoints])).encode()
    ).hexdigest()[:24]
    return {
        "mode": "historical_proxy",
        "confidence": "low",
        "revision": f"proxy-v1:{fingerprint}:{today.isoformat()}",
        "checked_through": date(years[-1], 12, 31).isoformat(),
        "reference_year": years[-1],
        "proxy_from": date(today.year, 1, 1).isoformat() if today.month != 1 or today.day != 1 else None,
        "proxy_through": (today - timedelta(days=1)).isoformat() if today.month != 1 or today.day != 1 else None,
    }


def load_advice_frame(db: Session, row: ClimateCell, context: dict) -> pd.DataFrame:
    if context["mode"] == "observed":
        return load_frame(row)
    key = (row.id, context["revision"])
    with _frames_guard:
        if key in _frames:
            _frames.move_to_end(key)
            return _frames[key]
    checkpoints = db.scalars(
        select(WeatherYear)
        .where(
            WeatherYear.cell_id == row.id,
            WeatherYear.validation_version == VALIDATION_VERSION,
            WeatherYear.year <= context["reference_year"],
        )
        .order_by(WeatherYear.year)
    ).all()
    frames = []
    for checkpoint in checkpoints:
        frame = codec.decode(checkpoint.series)
        if not frame.index.equals(pd.date_range(f"{checkpoint.year}-01-01", f"{checkpoint.year}-12-31")):
            raise LookupError("Checked weather checkpoint is incomplete. Refresh data before using advice.")
        frames.append(frame)
    history = pd.concat(frames)
    if context["proxy_from"]:
        dates = pd.date_range(context["proxy_from"], context["proxy_through"])
        reference = history.loc[str(context["reference_year"])]
        source_dates = [
            date(context["reference_year"], day.month, 28 if day.month == 2 and day.day == 29 else day.day)
            for day in dates
        ]
        proxy = reference.loc[pd.to_datetime(source_dates)].copy()
        proxy.index = dates
        history = pd.concat([history, proxy])
    with _frames_guard:
        _frames[key] = history
        while len(_frames) > _MAX_FRAMES:
            _frames.popitem(last=False)
    return history
