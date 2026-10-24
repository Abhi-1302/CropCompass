"""Offline weather audit/repair. Stop API workers and take a database backup first."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.config import get_settings
from app.db import make_engine, make_session_factory
from app.models import ClimateCell
from app.services.climate_cache import ensure_cell
from app.services.farm_data import default_http_client
from engine.ingest import codec
from engine.ingest.power import Cell


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup-only", action="store_true")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--cell")
    args = parser.parse_args()
    settings = get_settings()
    if args.backup_only:
        url = make_url(settings.database_url)
        if url.get_backend_name() != "sqlite" or not url.database or not Path(url.database).is_file():
            parser.error(
                "Automatic backup requires a local SQLite file. Back up PostgreSQL with your provider before repair."
            )
        target = Path("backups") / f"weather-before-{datetime.now(UTC):%Y%m%dT%H%M%S}.db"
        target.parent.mkdir(exist_ok=True)
        with sqlite3.connect(url.database) as source, sqlite3.connect(target) as destination:
            source.backup(destination)
        print(f"Backup: {target}", flush=True)
        return 0
    factory = make_session_factory(make_engine(settings.database_url))
    failures = 0
    with factory() as db, default_http_client(settings) as client:
        cells = list(db.scalars(select(ClimateCell).order_by(ClimateCell.id)))
        for row in cells:
            if args.cell and row.id != args.cell:
                continue
            print(
                json.dumps(
                    {
                        "cell": row.id,
                        "quality": row.quality,
                        "years": [row.years_done, row.years_total],
                        "through": str(row.last_date),
                    }
                ),
                flush=True,
            )
            if args.audit_only:
                continue
            old = codec.decode(row.series) if row.series else None
            try:
                repaired = ensure_cell(
                    db, Cell(row.lat, row.lon), client, settings.power_stale_days, settings.power_refresh_days
                )
                frame = codec.decode(repaired.series)
                result = {
                    "cell": row.id,
                    "quality": repaired.quality,
                    "revision": repaired.revision,
                    "days": len(frame),
                    "rain_2024_mm": round(float(frame.loc["2024", "PRECTOTCORR"].sum()), 2),
                }
                if old is not None:
                    result["previous_rain_2024_mm"] = round(float(old.loc["2024", "PRECTOTCORR"].sum()), 2)
                print(json.dumps(result), flush=True)
            except Exception as exc:
                failures += 1
                print(json.dumps({"cell": row.id, "quality": "needs_attention", "error": str(exc)}), flush=True)
    return int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(main())
