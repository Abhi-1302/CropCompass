"""Request dependencies: DB session, settings, signed-in user and CSRF check."""

from __future__ import annotations

import hmac
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Farm, User, UserSession
from app.security import as_utc, hash_token

SESSION_COOKIE = "af_session"
CSRF_COOKIE = "af_csrf"
CSRF_HEADER = "X-CSRF-Token"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    db = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()


DbSession = Annotated[Session, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]


def current_session(request: Request, db: DbSession) -> UserSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
    if session is None or as_utc(session.expires_at) <= datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please sign in again")
    if request.method in UNSAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent.encode(), session.csrf_token.encode()):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing or invalid CSRF token")
    return session


CurrentSession = Annotated[UserSession, Depends(current_session)]


def current_user(session: CurrentSession, db: DbSession) -> User:
    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def owned_farm(db: Session, user: User, farm_id: uuid.UUID) -> Farm:
    """The farm if it belongs to the user; 404 otherwise (never reveal other users' farms)."""
    farm = db.get(Farm, farm_id)
    if farm is None or farm.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farm not found")
    return farm


def check_build_quota(request: Request, user: User) -> None:
    """Limit how often a user can trigger downloads from NASA and other external services."""
    if not request.app.state.limiters["data_build"].hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many data requests. Please try again later.")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
