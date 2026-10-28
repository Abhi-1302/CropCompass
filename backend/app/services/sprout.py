from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import ChatMessage, ChatRun, ChatThread, ChatUsageDaily, Farm, User, UserSession
from app.security import as_utc
from app.sprout_schemas import ChatSendIn


def owned_thread(db: Session, user_id: uuid.UUID, thread_id: uuid.UUID) -> ChatThread:
    thread = db.scalar(select(ChatThread).where(ChatThread.id == thread_id, ChatThread.user_id == user_id))
    if thread is None:
        raise HTTPException(404, "Conversation not found")
    if thread.farm_id:
        farm = db.get(Farm, thread.farm_id)
        if farm is None or farm.user_id != user_id:
            raise HTTPException(404, "Conversation not found")
    return thread


def expire_runs(db: Session, thread_id: uuid.UUID | None = None) -> None:
    statement = update(ChatRun).where(ChatRun.state == "running", ChatRun.lease_expires_at <= datetime.now(UTC))
    if thread_id is not None:
        statement = statement.where(ChatRun.thread_id == thread_id)
    db.execute(statement.values(state="interrupted", error_code="interrupted", finished_at=datetime.now(UTC)))


def thread_view(thread: ChatThread) -> dict:
    return {
        "id": str(thread.id),
        "farm_id": str(thread.farm_id) if thread.farm_id else None,
        "title": thread.title,
        "language": thread.language,
        "scenario": thread.scenario,
        "version": thread.version,
        "updated_at": thread.updated_at.isoformat(),
    }


def message_view(message: ChatMessage) -> dict:
    return {
        "id": str(message.id),
        "sequence": message.sequence,
        "role": message.role,
        "content": message.content,
        "evidence": message.evidence if message.role == "assistant" else {},
        "created_at": message.created_at.isoformat(),
    }


def run_view(run: ChatRun) -> dict:
    return {
        "id": str(run.id),
        "request_id": str(run.request_id),
        "user_message_id": str(run.user_message_id),
        "state": run.state,
        "cancel_requested": run.cancel_requested,
        "error_code": run.error_code,
    }


def _reserve(db: Session, user_id: uuid.UUID, settings: Settings, tokens: int) -> None:
    day = datetime.now(UTC).date()
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    for scope, owner, requests_limit, token_limit in (
        ("global", None, settings.sprout_global_daily_requests, settings.sprout_global_daily_tokens),
        (f"user:{user_id}", user_id, settings.sprout_daily_requests, settings.sprout_daily_tokens),
    ):
        db.execute(
            insert(ChatUsageDaily)
            .values(
                scope=scope,
                day=day,
                user_id=owner,
                requests=0,
                tokens=0,
            )
            .on_conflict_do_nothing(index_elements=["scope", "day"])
        )
        updated = db.execute(
            update(ChatUsageDaily)
            .where(
                ChatUsageDaily.scope == scope,
                ChatUsageDaily.day == day,
                ChatUsageDaily.requests < requests_limit,
                ChatUsageDaily.tokens + tokens <= token_limit,
            )
            .values(requests=ChatUsageDaily.requests + 1, tokens=ChatUsageDaily.tokens + tokens)
        )
        if updated.rowcount != 1:
            raise HTTPException(429, "sprout_daily_limit")
    active = db.scalar(select(func.count()).select_from(ChatRun).where(ChatRun.state == "running"))
    if active >= settings.sprout_max_concurrent:
        raise HTTPException(429, "sprout_busy")


def begin_run(factory, user_id: uuid.UUID, thread_id: uuid.UUID, body: ChatSendIn, settings: Settings):
    payload_hash = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    try:
        with factory() as db:
            thread = owned_thread(db, user_id, thread_id)
            existing = db.scalar(
                select(ChatRun).where(
                    ChatRun.thread_id == thread_id,
                    ChatRun.request_id == body.request_id,
                )
            )
            if existing:
                if existing.payload_hash != payload_hash:
                    raise HTTPException(409, "sprout_request_conflict")
                return run_view(existing), False
            expire_runs(db)
            if db.scalar(select(ChatRun.id).where(ChatRun.thread_id == thread_id, ChatRun.state == "running")):
                raise HTTPException(409, "sprout_running")
            model_calls = 2 if body.intent is None or body.retry_run_id is not None else 1
            reservation = settings.sprout_context_chars * model_calls + settings.sprout_max_output_tokens + 1600
            _reserve(db, user_id, settings, reservation)
            changed = db.execute(
                update(ChatThread)
                .where(
                    ChatThread.id == thread_id,
                    ChatThread.version == body.expected_version,
                )
                .values(version=ChatThread.version + 1, updated_at=datetime.now(UTC))
            )
            if changed.rowcount != 1:
                raise HTTPException(409, "sprout_stale_thread")
            if body.retry_run_id:
                previous = db.get(ChatRun, body.retry_run_id)
                if (
                    previous is None
                    or previous.thread_id != thread_id
                    or previous.state
                    not in {
                        "failed",
                        "cancelled",
                        "interrupted",
                    }
                ):
                    raise HTTPException(409, "sprout_retry_unavailable")
                message = db.get(ChatMessage, previous.user_message_id)
                latest = db.scalar(select(func.max(ChatMessage.sequence)).where(ChatMessage.thread_id == thread_id))
                if message.sequence != latest or message.content != body.text:
                    raise HTTPException(409, "sprout_retry_unavailable")
            else:
                turns = db.scalar(
                    select(func.count())
                    .select_from(ChatMessage)
                    .where(
                        ChatMessage.thread_id == thread_id,
                        ChatMessage.role == "user",
                    )
                )
                if turns >= settings.sprout_max_turns:
                    raise HTTPException(409, "sprout_thread_full")
                sequence = db.scalar(select(func.max(ChatMessage.sequence)).where(ChatMessage.thread_id == thread_id))
                message = ChatMessage(
                    thread_id=thread_id,
                    sequence=(sequence or 0) + 1,
                    role="user",
                    content=body.text,
                    evidence={"request": body.model_dump(mode="json")},
                )
                db.add(message)
                db.flush()
            if thread.version == 1:
                thread.title = body.text[:80]
            thread.language = body.language
            run = ChatRun(
                thread_id=thread_id,
                user_message_id=message.id,
                request_id=body.request_id,
                payload_hash=payload_hash,
                model=settings.sprout_model,
                reserved_tokens=reservation,
                lease_expires_at=datetime.now(UTC) + timedelta(seconds=settings.sprout_timeout_s * 2 + 60),
            )
            db.add(run)
            db.commit()
            return run_view(run), True
    except IntegrityError as error:
        raise HTTPException(409, "sprout_request_conflict") from error


def active_run(factory, user_id: uuid.UUID, session_id: uuid.UUID, run_id: uuid.UUID) -> bool:
    with factory() as db:
        run = db.get(ChatRun, run_id)
        session = db.get(UserSession, session_id)
        if run is None or run.state != "running" or run.cancel_requested:
            return False
        if session is None or session.user_id != user_id or as_utc(session.expires_at) <= datetime.now(UTC):
            return False
        owned_thread(db, user_id, run.thread_id)
        return as_utc(run.lease_expires_at) > datetime.now(UTC)


def generation_input(factory, user_id, run_id, body: ChatSendIn) -> ChatSendIn:
    if not body.retry_run_id:
        return body
    with factory() as db:
        run = db.get(ChatRun, run_id)
        owned_thread(db, user_id, run.thread_id)
        message = db.get(ChatMessage, run.user_message_id)
        original = ChatSendIn.model_validate(message.evidence["request"])
        return body.model_copy(
            update={
                "intent": original.intent,
                "scenario": original.scenario,
                "reset_scenario": original.reset_scenario,
                "selected_option_ids": original.selected_option_ids,
                "displayed_weather_revision": original.displayed_weather_revision,
            }
        )


def finish_run(
    factory,
    user_id,
    run_id,
    *,
    content=None,
    evidence=None,
    scenario=None,
    usage=None,
    state="complete",
    error_code=None,
):
    with factory() as db:
        run = db.scalar(select(ChatRun).where(ChatRun.id == run_id).with_for_update())
        if run is None or run.state != "running":
            return None
        thread = owned_thread(db, user_id, run.thread_id)
        if run.cancel_requested:
            state, content, error_code = "cancelled", None, "cancelled"
        run.state, run.error_code, run.finished_at = state, error_code, datetime.now(UTC)
        run.usage_tokens = usage
        result = None
        if content is not None and state == "complete":
            last = db.scalar(select(func.max(ChatMessage.sequence)).where(ChatMessage.thread_id == thread.id))
            message = ChatMessage(
                thread_id=thread.id,
                sequence=last + 1,
                role="assistant",
                content=content,
                evidence=evidence or {},
            )
            db.add(message)
            thread.scenario = scenario or {}
            thread.updated_at = datetime.now(UTC)
            db.flush()
            result = message_view(message)
            older = list(
                db.scalars(
                    select(ChatMessage)
                    .where(
                        ChatMessage.thread_id == thread.id,
                        ChatMessage.role == "user",
                        ChatMessage.sequence < max(1, last - 8),
                        ChatMessage.sequence > thread.summary_through,
                    )
                    .order_by(ChatMessage.sequence)
                )
            )
            if older:
                entries = [f"User asked: {item.content[:180]}" for item in older]
                thread.summary = (thread.summary + "\n" + "\n".join(entries))[-1800:]
                thread.summary_through = older[-1].sequence
        if usage is not None:
            adjustment = max(0, usage) - run.reserved_tokens
            db.execute(
                update(ChatUsageDaily)
                .where(
                    ChatUsageDaily.scope.in_(["global", f"user:{user_id}"]),
                    ChatUsageDaily.day == as_utc(run.created_at).date(),
                )
                .values(tokens=ChatUsageDaily.tokens + adjustment)
            )
        db.commit()
        return result


def export_chats(db: Session, user: User) -> list[dict]:
    result = []
    for thread in db.scalars(select(ChatThread).where(ChatThread.user_id == user.id).order_by(ChatThread.created_at)):
        messages = db.scalars(
            select(ChatMessage).where(ChatMessage.thread_id == thread.id).order_by(ChatMessage.sequence)
        )
        result.append({**thread_view(thread), "messages": [message_view(message) for message in messages]})
    return result
