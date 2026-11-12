"""Email + password accounts with HttpOnly session cookies and a per-session CSRF token."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.deps import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    CurrentSession,
    CurrentUser,
    DbSession,
    SettingsDep,
    client_ip,
    current_session,
)
from app.models import PasswordReset, User, UserSession
from app.schemas import ForgotPasswordIn, LoginIn, RegisterIn, ResetPasswordIn, UserOut
from app.security import (
    as_utc,
    burn_verify_time,
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    verify_password,
)
from app.services import guests
from app.services.mailer import send_email

router = APIRouter(prefix="/auth", tags=["auth"])

TOO_MANY = "Too many attempts. Please wait a few minutes and try again."
RESET_SENT = "Request accepted. If this account exists, a reset email will be attempted."
RESET_INVALID = "This reset link is invalid or has expired. Please ask for a new one."
RESET_SUBJECT = "Reset your CropCompass password"
RESET_BODY = """Hello {name},

Someone (hopefully you) asked to reset the password of your CropCompass account.
Open this link within {minutes} minutes to choose a new password:

{link}

If you didn't ask for this, ignore this email: your password stays the same.
"""


def reject_email_as_password(email: str, password: str) -> None:
    if password.strip().lower() == email.lower():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Password must not be your email address.")


def clear_session_cookies(response: Response, settings: Settings) -> None:
    for name in (SESSION_COOKIE, CSRF_COOKIE):
        response.delete_cookie(name, path="/", secure=settings.cookie_secure, samesite="lax")


def prepare_session(db: Session, user: User, settings: Settings) -> tuple[str, UserSession]:
    token, csrf = new_token(), new_token()
    now = datetime.now(UTC)
    db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.expires_at < now))
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(token),
        csrf_token=csrf,
        expires_at=user.guest_expires_at if user.is_guest else now + timedelta(days=settings.session_ttl_days),
    )
    db.add(session)
    user.last_login_at = now
    return token, session


def set_session_cookies(response: Response, settings: Settings, token: str, session: UserSession) -> None:
    max_age = max(1, int((as_utc(session.expires_at) - datetime.now(UTC)).total_seconds()))
    common = {"max_age": max_age, "secure": settings.cookie_secure, "samesite": "lax", "path": "/"}
    response.set_cookie(SESSION_COOKIE, token, httponly=True, **common)
    response.set_cookie(CSRF_COOKIE, session.csrf_token, httponly=False, **common)


def _start_session(db: Session, user: User, response: Response, settings: Settings) -> None:
    token, session = prepare_session(db, user, settings)
    db.commit()
    set_session_cookies(response, settings, token, session)


def reject_guest_replacement(request: Request, db: Session) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
        if session and as_utc(session.expires_at) > datetime.now(UTC):
            user = db.get(User, session.user_id)
            if user and user.is_guest and as_utc(user.guest_expires_at) > datetime.now(UTC):
                raise HTTPException(409, "guest_convert_or_logout")


@router.get("/capabilities")
def capabilities(settings: SettingsDep):
    return {
        "guest_enabled": settings.guest_ready,
        "retention_days": settings.guest_retention_days,
        "warning_days": settings.guest_warning_days,
        "activity_interval_seconds": settings.guest_activity_interval_seconds,
        "max_farms": settings.guest_max_farms,
        "sprout_daily_requests": settings.guest_sprout_daily_requests,
    }


@router.post("/guest", response_model=UserOut, status_code=201)
def create_guest(request: Request, response: Response, db: DbSession, settings: SettingsDep):
    if request.headers.get("origin", "").rstrip("/") not in settings.origins:
        raise HTTPException(403, "Origin not allowed")
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "JSON required")
    if request.cookies.get(SESSION_COOKIE):
        session = current_session(request, db)
        user = guests.alive(db.get(User, session.user_id))
        if not user.is_guest:
            raise HTTPException(409, "already_signed_in")
        response.status_code = 200
        return guests.user_view(user, settings)
    if not settings.guest_ready:
        raise HTTPException(503, "guest_unavailable")
    guests.admission(db, request, settings)
    now = datetime.now(UTC)
    user = User(
        name="Guest",
        is_guest=True,
        registered_at=None,
        guest_last_active_at=now,
        guest_expires_at=now + timedelta(days=settings.guest_retention_days),
    )
    db.add(user)
    db.flush()
    _start_session(db, user, response, settings)
    return guests.user_view(user, settings)


@router.post("/guest/activity", response_model=UserOut)
def guest_activity(request: Request, response: Response, session: CurrentSession, db: DbSession, settings: SettingsDep):
    user, session = guests.guest_session(db, session.user_id, session.id)
    now = datetime.now(UTC)
    if (now - as_utc(user.guest_last_active_at)).total_seconds() >= settings.guest_activity_interval_seconds:
        user.guest_last_active_at = now
        user.guest_expires_at = max(as_utc(user.guest_expires_at), now + timedelta(days=settings.guest_retention_days))
    session.expires_at = user.guest_expires_at
    db.commit()
    set_session_cookies(response, settings, request.cookies[SESSION_COOKIE], session)
    return guests.user_view(user, settings)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(body: RegisterIn, request: Request, response: Response, db: DbSession, settings: SettingsDep) -> User:
    reject_guest_replacement(request, db)
    if not request.app.state.limiters["register_ip"].hit(client_ip(request)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY)
    email = body.email.lower()
    reject_email_as_password(email, body.password)
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists.")
    user = User(email=email, name=body.name, password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists.") from exc
    _start_session(db, user, response, settings)
    return user


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: DbSession, settings: SettingsDep) -> User:
    reject_guest_replacement(request, db)
    limiters = request.app.state.limiters
    email = body.email.lower()
    if not limiters["login_ip"].hit(client_ip(request)) or not limiters["login_failures"].allowed(email):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY)
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        burn_verify_time(body.password)
    if (
        user is None
        or user.is_guest
        or not user.password_hash
        or not verify_password(user.password_hash, body.password)
    ):
        limiters["login_failures"].hit(email)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password.")
    limiters["login_failures"].reset(email)
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    _start_session(db, user, response, settings)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(session: CurrentSession, db: DbSession, settings: SettingsDep) -> Response:
    db.delete(session)
    db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookies(response, settings)
    return response


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser, settings: SettingsDep):
    return guests.user_view(user, settings)


@router.post("/password/forgot", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(
    body: ForgotPasswordIn, request: Request, background: BackgroundTasks, db: DbSession, settings: SettingsDep
) -> dict:
    """Email a single-use reset link; the answer is the same whether or not the account exists."""
    limiters = request.app.state.limiters
    email = body.email.lower()
    if not limiters["reset_ip"].hit(client_ip(request)) or not limiters["reset_email"].hit(email):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY)
    delivery = settings.email_delivery
    if delivery == "unavailable":
        return {"detail": "Password-reset email is not configured. Contact the administrator.", "delivery": delivery}
    user = db.scalar(select(User).where(User.email == email))
    if user is not None and not user.is_guest:
        token = new_token()
        db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
        expires = datetime.now(UTC) + timedelta(minutes=settings.password_reset_minutes)
        db.add(PasswordReset(user_id=user.id, token_hash=hash_token(token), expires_at=expires))
        db.commit()
        # The token travels in the URL fragment, which browsers never send to servers or in Referer headers.
        link = f"{settings.public_app_url.rstrip('/')}/reset-password#token={token}"
        body_text = RESET_BODY.format(name=user.name, minutes=settings.password_reset_minutes, link=link)
        background.add_task(send_email, settings, user.email, RESET_SUBJECT, body_text)
    return {
        "detail": RESET_SENT
        if delivery == "email"
        else "Development mode: no email was sent. Contact the local administrator.",
        "delivery": delivery,
    }


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(body: ResetPasswordIn, request: Request, db: DbSession) -> Response:
    limiters = request.app.state.limiters
    if not limiters["reset_token_ip"].hit(client_ip(request)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY)
    row = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hash_token(body.token)))
    if row is None or as_utc(row.expires_at) <= datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, RESET_INVALID)
    user = db.get(User, row.user_id)
    if user is None or user.is_guest or user.email is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, RESET_INVALID)
    reject_email_as_password(user.email, body.password)
    user.password_hash = hash_password(body.password)
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))  # sign out everywhere
    db.commit()
    limiters["login_failures"].reset(user.email)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
