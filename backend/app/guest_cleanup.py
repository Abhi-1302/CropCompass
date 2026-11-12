"""Bounded guest retention cleanup; dry-run unless --execute is supplied."""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, text

from app.config import get_settings
from app.db import make_engine, make_session_factory
from app.models import GuestCounter, User
from app.security import as_utc


def cleanup(factory, *, execute=False, batch_size=100, max_batches=20, max_seconds=300):
    if min(batch_size, max_batches, max_seconds) < 1:
        raise ValueError("Cleanup bounds must be positive")
    started = time.monotonic()
    deleted = 0
    batches = 0
    if execute:
        for _batch in range(max_batches):
            if time.monotonic() - started >= max_seconds:
                break
            with factory() as db:
                if db.get_bind().dialect.name == "sqlite":
                    db.execute(text("BEGIN IMMEDIATE"))
                now = datetime.now(UTC)
                users = list(
                    db.scalars(
                        select(User)
                        .where(
                            User.is_guest.is_(True),
                            User.guest_expires_at <= now,
                        )
                        .order_by(User.guest_expires_at, User.id)
                        .limit(batch_size)
                        .with_for_update(skip_locked=True)
                    )
                )
                for user in users:
                    if user.is_guest and as_utc(user.guest_expires_at) <= datetime.now(UTC):
                        db.delete(user)
                db.commit()
                deleted += len(users)
                batches += 1
                if len(users) < batch_size:
                    break
        with factory() as db:
            expired = (
                select(GuestCounter.action, GuestCounter.scope, GuestCounter.window_start)
                .where(GuestCounter.expires_at <= datetime.now(UTC))
                .limit(batch_size * max_batches)
            )
            for action, scope, window in db.execute(expired).all():
                db.execute(
                    delete(GuestCounter).where(
                        GuestCounter.action == action,
                        GuestCounter.scope == scope,
                        GuestCounter.window_start == window,
                    )
                )
            db.commit()
    with factory() as db:
        remaining, oldest = db.execute(
            select(func.count(), func.min(User.guest_expires_at)).where(
                User.is_guest.is_(True),
                User.guest_expires_at <= datetime.now(UTC),
            )
        ).one()
    return {
        "dry_run": not execute,
        "deleted": deleted,
        "batches": batches,
        "remaining": remaining,
        "oldest_expired_seconds": int((datetime.now(UTC) - as_utc(oldest)).total_seconds()) if oldest else 0,
        "duration_seconds": round(time.monotonic() - started, 2),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--max-batches", type=int, default=20)
    parser.add_argument("--max-seconds", type=int, default=300)
    args = parser.parse_args()
    engine = make_engine(get_settings().database_url)
    try:
        result = cleanup(
            make_session_factory(engine),
            execute=args.execute,
            batch_size=args.batch_size,
            max_batches=args.max_batches,
            max_seconds=args.max_seconds,
        )
        print(json.dumps(result))
        return 2 if args.execute and result["remaining"] else 0
    except Exception:
        print(json.dumps({"error": "Guest cleanup failed; no credentials or user data logged."}))
        return 1
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
