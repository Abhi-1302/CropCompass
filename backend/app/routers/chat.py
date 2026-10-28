from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from starlette.concurrency import run_in_threadpool

from app.deps import CurrentSession, CurrentUser, DbSession, SettingsDep, owned_farm
from app.models import ChatMessage, ChatRun, ChatThread, User
from app.services import sprout
from app.services.sprout_context import build_evidence, conversation_context, knowledge
from app.services.sprout_llm import POLICY, ROUTING, GroqModel, ModelFailure, bounded_messages
from app.sprout_schemas import ChatResolution, ChatSendIn, ChatThreadIn

router = APIRouter(prefix="/chat", tags=["sprout"])
logger = logging.getLogger(__name__)


@router.get("/capabilities")
def capabilities(user: CurrentUser, settings: SettingsDep):
    return {
        "enabled": settings.sprout_enabled,
        "available": settings.sprout_ready,
        "name": "Sprout",
        "provider": "Groq",
        "languages": ["en", "hi", "te"],
        "max_message_chars": 2000,
    }


@router.get("/knowledge")
def help_sections(user: CurrentUser):
    return knowledge()


@router.post("/threads", status_code=201)
def create_thread(body: ChatThreadIn, user: CurrentUser, db: DbSession, settings: SettingsDep):
    if not settings.sprout_enabled:
        raise HTTPException(503, "sprout_disabled")
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    if body.farm_id:
        owned_farm(db, user, body.farm_id)
    count = db.scalar(select(func.count()).select_from(ChatThread).where(ChatThread.user_id == user.id))
    if count >= settings.sprout_max_threads:
        raise HTTPException(409, "sprout_thread_limit")
    thread = ChatThread(user_id=user.id, farm_id=body.farm_id, language=body.language)
    db.add(thread)
    db.commit()
    return sprout.thread_view(thread)


@router.get("/threads")
def list_threads(user: CurrentUser, db: DbSession):
    return [
        sprout.thread_view(thread)
        for thread in db.scalars(
            select(ChatThread)
            .where(
                ChatThread.user_id == user.id,
            )
            .order_by(ChatThread.updated_at.desc())
            .limit(100)
        )
    ]


@router.get("/threads/{thread_id}")
def get_thread(thread_id: uuid.UUID, user: CurrentUser, db: DbSession, before: int | None = Query(None, ge=1)):
    thread = sprout.owned_thread(db, user.id, thread_id)
    sprout.expire_runs(db, thread_id)
    query = select(ChatMessage).where(ChatMessage.thread_id == thread_id)
    if before is not None:
        query = query.where(ChatMessage.sequence < before)
    messages = list(db.scalars(query.order_by(ChatMessage.sequence.desc()).limit(31)))
    more = len(messages) > 30
    messages = list(reversed(messages[:30]))
    run = db.scalar(select(ChatRun).where(ChatRun.thread_id == thread_id).order_by(ChatRun.created_at.desc()).limit(1))
    db.commit()
    return {
        "thread": sprout.thread_view(thread),
        "messages": [sprout.message_view(item) for item in messages],
        "before": messages[0].sequence if more else None,
        "run": sprout.run_view(run) if run else None,
    }


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(thread_id: uuid.UUID, user: CurrentUser, db: DbSession):
    thread = sprout.owned_thread(db, user.id, thread_id)
    db.delete(thread)
    db.commit()
    return Response(status_code=204)


@router.post("/threads/{thread_id}/runs/{run_id}/cancel")
def cancel_run(thread_id: uuid.UUID, run_id: uuid.UUID, user: CurrentUser, db: DbSession):
    sprout.owned_thread(db, user.id, thread_id)
    run = db.get(ChatRun, run_id)
    if run is None or run.thread_id != thread_id:
        raise HTTPException(404, "Generation not found")
    if run.state == "running":
        run.cancel_requested = True
        db.commit()
    return sprout.run_view(run)


def event(kind: str, data: dict) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def generate(request: Request, factory, settings, user_id, session_id, thread_id, run, body):
    run_id = uuid.UUID(run["id"])
    finished = False
    evidence = None
    model = None
    try:
        yield event("started", {"run": run})
        if not await run_in_threadpool(sprout.active_run, factory, user_id, session_id, run_id):
            raise ModelFailure("cancelled")
        context = await run_in_threadpool(
            conversation_context,
            factory,
            user_id,
            thread_id,
            uuid.UUID(run["user_message_id"]),
        )
        model_factory = getattr(request.app.state, "sprout_model_factory", GroqModel)
        async with asyncio.timeout(settings.sprout_timeout_s * 2 + 30), model_factory(settings) as model:
            yield event("status", {"stage": "retrieving"})
            if body.intent:
                resolution = ChatResolution(intent=body.intent, query=body.text)
            else:
                resolution = await model.resolve(
                    bounded_messages(
                        ROUTING,
                        {"conversation": context, "question": body.text},
                        settings.sprout_context_chars,
                    )
                )
            if not await run_in_threadpool(sprout.active_run, factory, user_id, session_id, run_id):
                raise ModelFailure("cancelled")

            def quota():
                if not request.app.state.limiters["advice"].hit(str(user_id)):
                    raise HTTPException(429, "sprout_busy")

            evidence = await run_in_threadpool(build_evidence, factory, user_id, thread_id, body, resolution, quota)
            if context.get("previous_revision") and evidence.get("input_revision") != context["previous_revision"]:
                evidence["notice"] = evidence.get("notice", "selection_changed")
            if not await run_in_threadpool(sprout.active_run, factory, user_id, session_id, run_id):
                raise ModelFailure("cancelled")
            yield event("evidence", evidence)
            messages = bounded_messages(
                POLICY,
                {
                    "language": body.language,
                    "question": body.text,
                    "conversation": context,
                    "evidence": evidence,
                },
                settings.sprout_context_chars,
            )
            yield event("status", {"stage": "answering"})
            pieces = []
            last_check = time.monotonic()
            async for delta in model.stream(messages):
                if time.monotonic() - last_check >= 1:
                    if not await run_in_threadpool(sprout.active_run, factory, user_id, session_id, run_id):
                        raise ModelFailure("cancelled")
                    last_check = time.monotonic()
                pieces.append(delta)
                if sum(len(piece) for piece in pieces) > 12000:
                    raise ModelFailure("incomplete_response")
                yield event("delta", {"text": delta})
            answer = "".join(pieces).strip()
            answer = re.sub(r"\u3010((?:kb|planner|farm):[^\u3011\s]+)\u3011", r"[\1]", answer)
            references = set(re.findall(r"\[((?:kb|planner|farm):[^\]\s]+)\]", answer))
            invalid_references = references - {source["id"] for source in evidence["sources"]}
            if not answer or invalid_references:
                logger.warning(
                    "Sprout response rejected: empty=%s invalid_source_count=%s",
                    not bool(answer),
                    len(invalid_references),
                )
                raise ModelFailure("invalid_response")
            if not await run_in_threadpool(sprout.active_run, factory, user_id, session_id, run_id):
                raise ModelFailure("cancelled")
            message = sprout.finish_run(
                factory,
                user_id,
                run_id,
                content=answer,
                evidence=evidence,
                scenario=evidence["scenario"],
                usage=model.usage if model.usage_known else None,
            )
            finished = True
            if message is None:
                yield event("error", {"code": "cancelled"})
            else:
                yield event("done", {"message": message})
    except asyncio.CancelledError:
        raise
    except (ModelFailure, TimeoutError, HTTPException) as error:
        code = error.code if isinstance(error, ModelFailure) else "provider_error"
        if isinstance(error, HTTPException) and error.status_code == 429:
            code = "sprout_busy"
        state = "cancelled" if code == "cancelled" else "failed"
        sprout.finish_run(
            factory,
            user_id,
            run_id,
            state=state,
            error_code=code,
            usage=model.usage if model and model.usage_known else None,
        )
        finished = True
        yield event("error", {"code": code, "evidence": evidence})
    except Exception:
        sprout.finish_run(factory, user_id, run_id, state="failed", error_code="provider_error")
        finished = True
        yield event("error", {"code": "provider_error", "evidence": evidence})
    finally:
        if not finished:
            sprout.finish_run(factory, user_id, run_id, state="interrupted", error_code="interrupted")


@router.post("/threads/{thread_id}/messages")
async def send_message(
    thread_id: uuid.UUID,
    body: ChatSendIn,
    request: Request,
    user: CurrentUser,
    session: CurrentSession,
    db: DbSession,
    settings: SettingsDep,
):
    if not settings.sprout_ready:
        raise HTTPException(503, "sprout_unavailable")
    if not body.allow_ai:
        raise HTTPException(400, "sprout_consent_required")
    user_id, session_id = user.id, session.id
    if not request.app.state.limiters["sprout"].hit(str(user_id)):
        raise HTTPException(429, "sprout_busy")
    db.rollback()
    factory = request.app.state.session_factory
    run, created = await run_in_threadpool(sprout.begin_run, factory, user_id, thread_id, body, settings)
    if not created:

        async def duplicate():
            yield event("existing", {"run": run})

        return StreamingResponse(duplicate(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
    generation_body = await run_in_threadpool(
        sprout.generation_input,
        factory,
        user_id,
        uuid.UUID(run["id"]),
        body,
    )
    return StreamingResponse(
        generate(request, factory, settings, user_id, session_id, thread_id, run, generation_body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
