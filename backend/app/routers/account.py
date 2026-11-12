"""The signed-in user's account: change password, export all data, delete the account."""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deps import CurrentSession, CurrentUser, DbSession, SettingsDep
from app.models import Farm, PasswordReset, Plan, SeasonRecord, SoilProfile, User, UserSession
from app.routers.auth import (
    TOO_MANY,
    clear_session_cookies,
    prepare_session,
    reject_email_as_password,
    set_session_cookies,
)
from app.schemas import (
    AccountDeleteIn,
    FarmOut,
    GuestDeleteIn,
    PasswordChangeIn,
    PlanOut,
    RegisterIn,
    SeasonOut,
    UserOut,
)
from app.security import hash_password, verify_password
from app.services import guests
from app.services.sprout import export_chats

router = APIRouter(prefix="/account", tags=["account"])

WRONG_PASSWORD = "Your current password is not correct."


def _confirm_password(request: Request, user: User, password: str) -> None:
    if user.is_guest or not user.password_hash:
        raise HTTPException(409, "registered_required")
    limiter = request.app.state.limiters["password_checks"]
    key = str(user.id)
    if not limiter.allowed(key):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, TOO_MANY)
    if not verify_password(user.password_hash, password):
        limiter.hit(key)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, WRONG_PASSWORD)
    limiter.reset(key)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PasswordChangeIn, request: Request, session: CurrentSession, user: CurrentUser, db: DbSession
) -> Response:
    _confirm_password(request, user, body.current_password)
    reject_email_as_password(user.email, body.new_password)
    user.password_hash = hash_password(body.new_password)
    db.execute(delete(UserSession).where(UserSession.user_id == user.id, UserSession.id != session.id))
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _farm_export(db: Session, farm: Farm) -> dict:
    soil = db.get(SoilProfile, farm.id)
    seasons = db.scalars(select(SeasonRecord).where(SeasonRecord.farm_id == farm.id).order_by(SeasonRecord.sow_date))
    plans = db.scalars(select(Plan).where(Plan.farm_id == farm.id).order_by(Plan.created_at))
    return {
        **FarmOut.model_validate(farm).model_dump(mode="json"),
        "soil_override": farm.soil_override,
        "soil_map": None if soil is None else {"source": soil.source, "summary": soil.summary},
        "seasons": [SeasonOut.model_validate(record).model_dump(mode="json") for record in seasons],
        "plans": [PlanOut.model_validate(plan).model_dump(mode="json") for plan in plans],
    }


@router.get("/export")
def export_account(user: CurrentUser, db: DbSession) -> Response:
    now = datetime.now(UTC)
    farms = db.scalars(select(Farm).where(Farm.user_id == user.id).order_by(Farm.created_at))
    data = {
        "format": "cropcompass-export",
        "version": 2,
        "exported_at": now.isoformat(),
        "account": {
            "is_guest": user.is_guest,
            "guest_expires_at": user.guest_expires_at.isoformat() if user.guest_expires_at else None,
            "email": user.email,
            "name": user.name,
            "created_at": user.created_at.isoformat(),
            "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
        },
        "farms": [_farm_export(db, farm) for farm in farms],
        "conversations": export_chats(db, user),
    }
    filename = f"cropcompass-export-{now.date().isoformat()}.json"
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    body: AccountDeleteIn, request: Request, user: CurrentUser, db: DbSession, settings: SettingsDep
) -> Response:
    """Delete the account and, through the database's cascades, every farm, season, plan and session."""
    _confirm_password(request, user, body.password)
    db.delete(user)
    db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookies(response, settings)
    return response


@router.post("/convert-guest", response_model=UserOut)
def convert_guest(
    body: RegisterIn,
    request: Request,
    response: Response,
    session: CurrentSession,
    db: DbSession,
    settings: SettingsDep,
):
    user_id, session_id = session.user_id, session.id
    guests.consume(db, "convert", str(user_id), 3600, 10)
    db.commit()
    email = body.email.lower()
    reject_email_as_password(email, body.password)
    password_hash = hash_password(body.password)
    user, _session = guests.guest_session(db, user_id, session_id)
    user.email, user.name, user.password_hash = email, body.name, password_hash
    user.is_guest = False
    user.registered_at = datetime.now(UTC)
    user.guest_last_active_at = user.guest_expires_at = None
    try:
        db.flush()
        db.execute(delete(UserSession).where(UserSession.user_id == user_id))
        token, new_session = prepare_session(db, user, settings)
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists.") from error
    set_session_cookies(response, settings, token, new_session)
    return guests.user_view(user, settings)


@router.post("/guest/delete", status_code=204)
def delete_guest(body: GuestDeleteIn, session: CurrentSession, db: DbSession, settings: SettingsDep):
    if not body.confirm:
        raise HTTPException(422, "Confirmation required")
    user, _session = guests.guest_session(db, session.user_id, session.id)
    db.delete(user)
    db.commit()
    response = Response(status_code=204)
    clear_session_cookies(response, settings)
    return response
