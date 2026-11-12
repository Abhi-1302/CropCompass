from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Farm, GuestCounter, User, UserSession
from app.schemas import UserOut
from app.security import as_utc


def alive(user: User | None) -> User:
    if user is None:
        raise HTTPException(401, "Not signed in")
    if user.is_guest and (user.guest_expires_at is None or as_utc(user.guest_expires_at) <= datetime.now(UTC)):
        raise HTTPException(401, "guest_expired")
    return user


def lock_user(db: Session, user_id: uuid.UUID) -> User | None:
    if db.get_bind().dialect.name == "sqlite":
        db.execute(update(User).where(User.id == user_id).values(is_guest=User.is_guest))
    return db.scalar(select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True))


def guest_session(db: Session, user_id: uuid.UUID, session_id: uuid.UUID) -> tuple[User, UserSession]:
    user = alive(lock_user(db, user_id))
    session = db.get(UserSession, session_id, populate_existing=True)
    if session is None or session.user_id != user.id or as_utc(session.expires_at) <= datetime.now(UTC):
        raise HTTPException(401, "Session expired, please sign in again")
    if not user.is_guest:
        raise HTTPException(409, "guest_required")
    return user, session


def user_view(user: User, settings: Settings) -> UserOut:
    result = UserOut.model_validate(user)
    if user.is_guest and user.guest_expires_at:
        result.guest_expires_at = as_utc(user.guest_expires_at)
        result.guest_expiring_soon = result.guest_expires_at <= datetime.now(UTC) + timedelta(
            days=settings.guest_warning_days
        )
    return result


def network_key(request: Request, settings: Settings) -> str:
    secret = settings.guest_abuse_hmac_key
    if not secret or len(secret) < 32 or (settings.cookie_secure and not settings.guest_proxy_verified):
        raise HTTPException(503, "guest_unavailable")
    address = request.client.host if request.client else "unknown"
    return hmac.new(secret.encode(), address.encode(), hashlib.sha256).hexdigest()


def consume(db: Session, action: str, scope: str, seconds: int, limit: int) -> None:
    now = datetime.now(UTC)
    window = datetime.fromtimestamp(int(now.timestamp()) // seconds * seconds, UTC)
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    db.execute(
        insert(GuestCounter)
        .values(
            action=action,
            scope=scope,
            window_start=window,
            count=0,
            expires_at=window + timedelta(seconds=seconds, hours=48),
        )
        .on_conflict_do_nothing(index_elements=["action", "scope", "window_start"])
    )
    changed = db.execute(
        update(GuestCounter)
        .where(
            GuestCounter.action == action,
            GuestCounter.scope == scope,
            GuestCounter.window_start == window,
            GuestCounter.count < limit,
        )
        .values(count=GuestCounter.count + 1)
    )
    if changed.rowcount != 1:
        retry = max(1, int((window + timedelta(seconds=seconds) - now).total_seconds()))
        raise HTTPException(429, "guest_usage_limited", headers={"Retry-After": str(retry)})


def admission(db: Session, request: Request, settings: Settings) -> None:
    key = network_key(request, settings)
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    db.execute(
        insert(GuestCounter)
        .values(
            action="admission_lock",
            scope="global",
            window_start=epoch,
            count=0,
            expires_at=datetime(9999, 1, 1, tzinfo=UTC),
        )
        .on_conflict_do_nothing(index_elements=["action", "scope", "window_start"])
    )
    db.execute(update(GuestCounter).where(GuestCounter.action == "admission_lock").values(count=0))
    if db.scalar(select(func.count()).select_from(User).where(User.is_guest)) >= settings.guest_max_identities:
        raise HTTPException(429, "guest_capacity_reached", headers={"Retry-After": "3600"})
    consume(db, "create_hour", key, 3600, settings.guest_creations_per_ip_hour)
    consume(db, "create_day", key, 86400, settings.guest_creations_per_ip_day)
    consume(db, "create_global", "global", 86400, settings.guest_creations_global_day)


def build_budget(db: Session, user: User, settings: Settings) -> None:
    if not user.is_guest:
        return
    alive(lock_user(db, user.id))
    consume(db, "build_hour", str(user.id), 3600, settings.guest_data_builds_hour)
    consume(db, "build_day", str(user.id), 86400, settings.guest_data_builds_day)
    consume(db, "build_global", "global", 86400, settings.guest_data_builds_global_day)


def advice_budget(db: Session, user: User, settings: Settings) -> None:
    if user.is_guest:
        alive(lock_user(db, user.id))
        consume(db, "advice_global", "global", 3600, settings.guest_advice_global_hour)


def background_farm(db: Session, farm_id: uuid.UUID) -> Farm | None:
    owner = db.scalar(select(Farm.user_id).where(Farm.id == farm_id))
    if owner is None:
        return None
    try:
        alive(lock_user(db, owner))
    except HTTPException:
        return None
    return db.get(Farm, farm_id, populate_existing=True)
