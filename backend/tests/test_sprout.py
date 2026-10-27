import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, inspect, select, text
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.db import make_engine
from app.models import ChatMessage, ChatRun, ChatThread, ChatUsageDaily, Farm, User
from app.services.sprout import begin_run, finish_run
from app.services.sprout_context import _option, build_evidence, knowledge, retrieve
from app.services.sprout_llm import ModelFailure, bounded_messages
from app.sprout_schemas import ChatResolution, ChatSendIn
from tests.conftest import csrf, register


def test_sprout_tables_preserve_order_and_cascade(client, session_factory):
    user_id = uuid.UUID(register(client).json()["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.flush()
        message = ChatMessage(thread_id=thread.id, sequence=1, role="user", content="What is Sprout?")
        db.add(message)
        db.flush()
        db.add(
            ChatRun(
                thread_id=thread.id,
                user_message_id=message.id,
                request_id=uuid.uuid4(),
                model="test",
                reserved_tokens=100,
                lease_expires_at=datetime.now(UTC) + timedelta(minutes=2),
            )
        )
        db.add(ChatUsageDaily(scope=f"user:{user_id}", day=datetime.now(UTC).date(), user_id=user_id))
        db.commit()
        db.add(ChatMessage(thread_id=thread.id, sequence=1, role="assistant", content="Duplicate"))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
        db.execute(delete(User).where(User.id == user_id))
        db.commit()
        for model in (ChatThread, ChatMessage, ChatRun, ChatUsageDaily):
            assert db.scalar(select(func.count()).select_from(model)) == 0


def test_only_one_generation_can_run_per_thread(client, session_factory):
    user_id = uuid.UUID(register(client).json()["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.flush()
        message = ChatMessage(thread_id=thread.id, sequence=1, role="user", content="Hello")
        db.add(message)
        db.flush()
        for _attempt in range(2):
            db.add(
                ChatRun(
                    thread_id=thread.id,
                    user_message_id=message.id,
                    request_id=uuid.uuid4(),
                    model="test",
                    reserved_tokens=100,
                    lease_expires_at=datetime.now(UTC) + timedelta(minutes=2),
                )
            )
        with pytest.raises(IntegrityError):
            db.commit()


def test_sprout_idempotency_budget_and_version(client, session_factory, settings):
    user_id = uuid.UUID(register(client).json()["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.commit()
        thread_id = thread.id
    body = ChatSendIn(text="Explain crop rotation", request_id=uuid.uuid4(), expected_version=0)
    run, created = begin_run(session_factory, user_id, thread_id, body, settings)
    assert created
    duplicate, created = begin_run(session_factory, user_id, thread_id, body, settings)
    assert duplicate["id"] == run["id"] and not created
    with pytest.raises(HTTPException) as error:
        begin_run(session_factory, user_id, thread_id, body.model_copy(update={"request_id": uuid.uuid4()}), settings)
    assert error.value.status_code == 409
    finish_run(session_factory, user_id, uuid.UUID(run["id"]), content="A rotation changes crops.", usage=100)
    with session_factory() as db:
        assert db.get(ChatThread, thread_id).version == 1
        usage = db.get(ChatUsageDaily, (f"user:{user_id}", datetime.now(UTC).date()))
        assert usage.requests == 1 and usage.tokens == 100
        assert len(list(db.scalars(select(ChatMessage)))) == 2
    with pytest.raises(HTTPException) as error:
        begin_run(session_factory, user_id, thread_id, body.model_copy(update={"request_id": uuid.uuid4()}), settings)
    assert error.value.detail == "sprout_stale_thread"


@pytest.mark.parametrize("query", ["soil", "मिट्टी", "నేల"])
def test_sprout_knowledge_retrieval(query):
    assert retrieve(query)[0]["id"] == "kb:soil"
    assert len({section["id"] for section in knowledge()["sections"]}) == len(knowledge()["sections"])


def test_sprout_farm_evidence_is_scoped_and_excludes_private_data(client, session_factory):
    user_id = uuid.UUID(register(client).json()["id"])
    farm = client.post(
        "/api/v1/farms", json={"name": "Private name", "lat": 17.2, "lon": 78.3}, headers=csrf(client)
    ).json()
    with session_factory() as db:
        thread = ChatThread(user_id=user_id, farm_id=uuid.UUID(farm["id"]))
        db.add(thread)
        db.commit()
        thread_id = thread.id
    body = ChatSendIn(text="My soil?", request_id=uuid.uuid4(), expected_version=0)
    evidence = build_evidence(session_factory, user_id, thread_id, body, ChatResolution(intent="soil"))
    assert evidence["facts"]["soil"]["source"] == "soilgrids"
    assert evidence["facts"]["soil_units"]["awc_mm_per_m"] == "mm/m"
    assert evidence["facts"]["soil_units"]["awc_mm"] == "mm"
    assert evidence["facts"]["soil_provenance"]["field_measurements_verified"] is False
    assert evidence["facts"]["soil_provenance"]["farmer_reported_fields"] == []
    assert evidence["facts"]["advice_readiness"]["supported_region"] is True
    assert "lat" not in evidence["facts"] and "lon" not in evidence["facts"]
    assert "name" not in evidence["facts"] and "email" not in evidence["facts"]
    with pytest.raises(HTTPException):
        build_evidence(session_factory, uuid.uuid4(), thread_id, body, ChatResolution(intent="soil"))


class FakeModel:
    calls = 0
    usage = 120
    usage_known = True

    def __init__(self, settings):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    async def resolve(self, messages):
        return ChatResolution(intent="help", query="CropCompass features")

    async def stream(self, messages):
        type(self).calls += 1
        assert messages[0]["role"] == "system"
        yield "Sprout explains CropCompass. "
        yield "[kb:scope]"


def enable_chat(client):
    client.app.state.settings.sprout_enabled = True
    client.app.state.settings.groq_api_key = "test-key"
    client.app.state.sprout_model_factory = FakeModel
    FakeModel.calls = 0


def test_sprout_api_auth_stream_history_and_duplicate(client):
    assert client.get("/api/v1/chat/threads").status_code == 401
    register(client)
    assert not client.get("/api/v1/chat/capabilities").json()["available"]
    enable_chat(client)
    assert client.post("/api/v1/chat/threads", json={}).status_code == 403
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    body = {"text": "What can Sprout do?", "request_id": str(uuid.uuid4()), "expected_version": 0, "allow_ai": True}
    rejected = client.post(url + "/messages", json={**body, "allow_ai": False}, headers=csrf(client))
    assert rejected.status_code == 400 and FakeModel.calls == 0
    response = client.post(url + "/messages", json=body, headers=csrf(client))
    assert response.status_code == 200 and "event: done" in response.text, response.text
    assert "event: delta" in response.text and "event: evidence" in response.text
    history = client.get(url).json()
    assert history["thread"]["version"] == 1
    assert [message["role"] for message in history["messages"]] == ["user", "assistant"]
    assert history["run"]["state"] == "complete"
    duplicate = client.post(url + "/messages", json=body, headers=csrf(client))
    assert "event: existing" in duplicate.text and FakeModel.calls == 1
    assert client.delete(url, headers=csrf(client)).status_code == 204
    assert client.get(url).status_code == 404


def test_sprout_prompt_budget_preserves_evidence():
    data = {
        "conversation": {"recent_messages": [{"role": "user", "content": "x" * 4000}]},
        "evidence": {"weather_context": {"confidence": "low"}},
        "question": "Why?",
    }
    messages = bounded_messages("Rules", data, 500)
    assert "low" in messages[-1]["content"]
    assert len(str(messages)) < 500
    with pytest.raises(ModelFailure):
        bounded_messages("Rules", {"question": "x" * 600}, 500)


def test_sprout_rotation_income_keeps_engine_annual_units():
    option = _option({"key": "test", "income": {"mean": 12000}, "water": {"irrigation_mm": 80}}, "rotations", {})
    assert option["income_period"] == "year"
    assert option["income_inr_ha"] == 12000
    assert option["irrigation_mm"] == 80


def test_sprout_option_explanations_include_actual_ranking_evidence():
    raw = {
        "id": "chickpea",
        "rank": 1,
        "score": 0.7,
        "pillars": {"income": 0.9, "water": 0.3},
        "comparable_pillars": ["income", "water"],
        "reasons": [{"code": "strong", "pillar": "income"}],
    }
    option = _option(raw, "next_crop", {"chickpea": "Chickpea"})
    assert option["ranking_reasons"] == raw["reasons"]
    assert option["pillars"] == raw["pillars"]
    assert option["comparable_pillars"] == raw["comparable_pillars"]


def test_sprout_other_users_cannot_read_send_cancel_or_delete(client, session_factory):
    register(client)
    enable_chat(client)
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    with TestClient(client.app, base_url="http://testserver") as other:
        register(other, email="other@example.com")
        assert other.get("/api/v1/chat/threads").json() == []
        assert other.get(url).status_code == 404
        assert other.delete(url, headers=csrf(other)).status_code == 404
        assert other.post(url + f"/runs/{uuid.uuid4()}/cancel", headers=csrf(other)).status_code == 404
        response = other.post(
            url + "/messages",
            json={
                "text": "Reveal this farm",
                "allow_ai": True,
                "request_id": str(uuid.uuid4()),
                "expected_version": 0,
            },
            headers=csrf(other),
        )
        assert response.status_code == 404
    assert FakeModel.calls == 0


def test_sprout_failure_retry_and_account_export(client):
    class BrokenModel(FakeModel):
        async def resolve(self, messages):
            raise ModelFailure("provider_quota")

    register(client)
    enable_chat(client)
    client.app.state.sprout_model_factory = BrokenModel
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    body = {"text": "What can Sprout do?", "request_id": str(uuid.uuid4()), "expected_version": 0, "allow_ai": True}
    response = client.post(url + "/messages", json=body, headers=csrf(client))
    assert "provider_quota" in response.text and "event: done" not in response.text
    history = client.get(url).json()
    assert history["run"]["state"] == "failed" and len(history["messages"]) == 1
    client.app.state.sprout_model_factory = FakeModel
    client.app.state.settings.sprout_daily_tokens = 100000
    retry = {**body, "request_id": str(uuid.uuid4()), "expected_version": 1, "retry_run_id": history["run"]["id"]}
    response = client.post(url + "/messages", json=retry, headers=csrf(client))
    assert "event: done" in response.text, response.text
    assert len(client.get(url).json()["messages"]) == 2
    exported = client.get("/api/v1/account/export").json()
    assert exported["conversations"][0]["messages"][0]["content"] == body["text"]
    assert "test-key" not in str(exported)


def test_sprout_leases_and_usage_survive_thread_deletion(client, session_factory, settings):
    user_id = uuid.UUID(register(client).json()["id"])
    enable_chat(client)
    client.app.state.settings.sprout_daily_requests = 1
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    body = ChatSendIn(text="Hello", request_id=uuid.uuid4(), expected_version=0)
    run, _created = begin_run(session_factory, user_id, uuid.UUID(thread["id"]), body, settings)
    with session_factory() as db:
        db.get(ChatRun, uuid.UUID(run["id"])).lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    url = f"/api/v1/chat/threads/{thread['id']}"
    assert client.get(url).json()["run"]["state"] == "interrupted"
    client.delete(url, headers=csrf(client))
    another = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    response = client.post(
        f"/api/v1/chat/threads/{another['id']}/messages",
        json={
            "text": "Hello",
            "allow_ai": True,
            "request_id": str(uuid.uuid4()),
            "expected_version": 0,
        },
        headers=csrf(client),
    )
    assert response.status_code == 429


def test_sprout_scenarios_do_not_change_saved_farm(client, session_factory):
    user_id = uuid.UUID(register(client).json()["id"])
    farm = client.post("/api/v1/farms", json={"name": "Plot", "lat": 17.2, "lon": 78.3}, headers=csrf(client)).json()
    with session_factory() as db:
        thread = ChatThread(user_id=user_id, farm_id=uuid.UUID(farm["id"]))
        db.add(thread)
        db.commit()
        thread_id = thread.id
    body = ChatSendIn(
        text="What if irrigated?", request_id=uuid.uuid4(), expected_version=0, scenario={"irrigation": "protective"}
    )
    evidence = build_evidence(session_factory, user_id, thread_id, body, ChatResolution(intent="next_crop"))
    assert evidence["scenario"]["irrigation"] == "protective"
    assert evidence["options"] and isinstance(evidence["options"][0]["label"], str)
    with session_factory() as db:
        assert db.get(Farm, uuid.UUID(farm["id"])).irrigation == "rainfed"


def test_sprout_migration_on_isolated_sqlite(tmp_path, monkeypatch):
    path = tmp_path / "sprout.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{path.as_posix()}")
    get_settings.cache_clear()
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    try:
        command.upgrade(config, "head")
        engine = make_engine(f"sqlite:///{path.as_posix()}")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0006"
            assert {"chat_threads", "chat_messages", "chat_runs", "chat_usage_daily"}.issubset(
                inspect(connection).get_table_names()
            )
        engine.dispose()
        command.upgrade(config, "head")
        command.downgrade(config, "0005")
        command.upgrade(config, "head")
    finally:
        get_settings.cache_clear()


def test_sprout_postgres_migration_compiles_without_connection(monkeypatch):
    from io import StringIO

    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost/unused")
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", "postgresql://test:test@localhost/unused")
    get_settings.cache_clear()
    output = StringIO()
    root = Path(__file__).parents[1]
    config = Config(str(root / "alembic.ini"), output_buffer=output)
    config.set_main_option("script_location", str(root / "migrations"))
    try:
        command.upgrade(config, "0005:0006", sql=True)
        sql = output.getvalue()
        assert "CREATE TABLE chat_threads" in sql and "JSONB" in sql
        assert "CREATE UNIQUE INDEX uq_chat_running_thread" in sql and "WHERE state = 'running'" in sql
        assert "ON DELETE CASCADE" in sql
    finally:
        get_settings.cache_clear()


def test_sprout_cancellation_keeps_partial_text_out_of_history(client, session_factory):
    class CancelModel(FakeModel):
        async def stream(self, messages):
            yield "Partial text"
            with session_factory() as db:
                active = db.scalar(select(ChatRun).where(ChatRun.state == "running"))
                active.cancel_requested = True
                db.commit()
            yield " that must not be saved"

    register(client)
    enable_chat(client)
    client.app.state.sprout_model_factory = CancelModel
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    response = client.post(
        url + "/messages",
        json={
            "text": "Help",
            "request_id": str(uuid.uuid4()),
            "expected_version": 0,
            "allow_ai": True,
        },
        headers=csrf(client),
    )
    assert '"code": "cancelled"' in response.text
    history = client.get(url).json()
    assert history["run"]["state"] == "cancelled"
    assert len(history["messages"]) == 1


@pytest.mark.parametrize("citation", ["[kb:invented]", "\u3010kb:invented\u3011"])
def test_sprout_unknown_citations_are_not_saved(client, citation):
    class InventedSource(FakeModel):
        async def stream(self, messages):
            yield f"A claim {citation}."

    register(client)
    enable_chat(client)
    client.app.state.sprout_model_factory = InventedSource
    thread = client.post("/api/v1/chat/threads", json={}, headers=csrf(client)).json()
    url = f"/api/v1/chat/threads/{thread['id']}"
    response = client.post(
        url + "/messages",
        json={
            "text": "Help",
            "request_id": str(uuid.uuid4()),
            "expected_version": 0,
            "allow_ai": True,
        },
        headers=csrf(client),
    )
    assert "invalid_response" in response.text
    assert len(client.get(url).json()["messages"]) == 1


@pytest.mark.parametrize("finish_reason", ["stop", "length"])
def test_groq_adapter_json_stream_and_usage(settings, finish_reason):
    import asyncio
    import json

    import httpx
    from openai import AsyncOpenAI

    from app.services.sprout_llm import GroqModel

    settings.groq_api_key = "not-a-real-key"

    def handle(request):
        body = json.loads(request.content)
        assert body["model"] == "openai/gpt-oss-120b"
        if not body.get("stream"):
            return httpx.Response(
                200,
                json={
                    "id": "resolution",
                    "created": 0,
                    "object": "chat.completion",
                    "model": "test",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": json.dumps({"intent": "help", "query": "soil"}),
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40},
                },
            )
        chunks = [
            {"choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]},
            {"choices": [], "usage": {"prompt_tokens": 60, "completion_tokens": 10, "total_tokens": 70}},
        ]
        stream = "".join(
            "data: "
            + json.dumps({"id": "answer", "created": 0, "object": "chat.completion.chunk", "model": "test", **chunk})
            + "\n\n"
            for chunk in chunks
        )
        return httpx.Response(200, text=stream + "data: [DONE]\n\n", headers={"Content-Type": "text/event-stream"})

    async def verify():
        async with GroqModel(settings) as model:
            await model.client.close()
            model.client = AsyncOpenAI(
                api_key="test",
                base_url="https://mock.example/v1",
                max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
            )
            resolution = await model.resolve([{"role": "user", "content": "Hello"}])
            assert resolution.intent == "help"
            if finish_reason == "stop":
                assert "".join([part async for part in model.stream([{"role": "user", "content": "Hello"}])]) == "Hello"
            else:
                with pytest.raises(ModelFailure) as error:
                    _parts = [part async for part in model.stream([{"role": "user", "content": "Hello"}])]
                assert error.value.code == "output_limit"
            assert model.usage_known and model.usage == 110

    asyncio.run(verify())


def test_groq_adapter_quota_error_does_not_leak_details(settings):
    import asyncio

    import httpx
    from openai import AsyncOpenAI

    from app.services.sprout_llm import GroqModel

    settings.groq_api_key = "not-a-real-key"

    async def verify():
        async with GroqModel(settings) as model:
            await model.client.close()
            model.client = AsyncOpenAI(
                api_key="test",
                base_url="https://mock.example/v1",
                max_retries=0,
                http_client=httpx.AsyncClient(
                    transport=httpx.MockTransport(
                        lambda _request: httpx.Response(
                            429,
                            json={"error": {"message": "private provider details", "type": "rate_limit"}},
                        )
                    )
                ),
            )
            with pytest.raises(ModelFailure) as error:
                await model.resolve([{"role": "user", "content": "Hello"}])
            assert str(error.value) == "provider_quota"
            assert model.usage_known and model.usage == 0

    asyncio.run(verify())


def test_retry_retains_the_original_scenario(client, session_factory, settings):
    from app.services.sprout import generation_input

    user_id = uuid.UUID(register(client).json()["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.commit()
        thread_id = thread.id
    original = ChatSendIn(
        text="Irrigate?",
        expected_version=0,
        request_id=uuid.uuid4(),
        intent="next_crop",
        scenario={"irrigation": "protective"},
    )
    run, _created = begin_run(session_factory, user_id, thread_id, original, settings)
    finish_run(session_factory, user_id, uuid.UUID(run["id"]), state="failed", usage=0)
    retry = ChatSendIn(text=original.text, expected_version=1, request_id=uuid.uuid4(), retry_run_id=run["id"])
    retried, _created = begin_run(session_factory, user_id, thread_id, retry, settings)
    resolved = generation_input(session_factory, user_id, uuid.UUID(retried["id"]), retry)
    assert resolved.intent == "next_crop" and resolved.scenario.irrigation == "protective"


def test_sprout_evidence_revision_includes_saved_priorities(client, session_factory):
    user_id = uuid.UUID(register(client).json()["id"])
    farm = client.post("/api/v1/farms", json={"name": "Plot", "lat": 17.2, "lon": 78.3}, headers=csrf(client)).json()
    with session_factory() as db:
        thread = ChatThread(user_id=user_id, farm_id=uuid.UUID(farm["id"]))
        db.add(thread)
        db.commit()
        thread_id = thread.id
    body = ChatSendIn(text="My farm", request_id=uuid.uuid4(), expected_version=0)
    initial = build_evidence(session_factory, user_id, thread_id, body, ChatResolution(intent="farm"))
    with session_factory() as db:
        db.get(Farm, uuid.UUID(farm["id"])).priorities = {"income": 0, "water": 5, "soil": 5, "risk": 5}
        db.commit()
    updated = build_evidence(session_factory, user_id, thread_id, body, ChatResolution(intent="farm"))
    assert initial["input_revision"] != updated["input_revision"]


def test_explicit_intent_reserves_only_the_single_generation_call(client, session_factory, settings):
    user_id = uuid.UUID(register(client).json()["id"])
    settings.sprout_daily_tokens = 18000
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.commit()
        thread_id = thread.id
    body = ChatSendIn(text="Help", intent="help", expected_version=0, request_id=uuid.uuid4())
    run, created = begin_run(session_factory, user_id, thread_id, body, settings)
    assert created
    with session_factory() as db:
        reserved = db.get(ChatRun, uuid.UUID(run["id"])).reserved_tokens
        assert reserved == settings.sprout_context_chars + settings.sprout_max_output_tokens + 1600
        assert reserved <= settings.sprout_daily_tokens
    finish_run(session_factory, user_id, uuid.UUID(run["id"]), content="Help", usage=100)
    with pytest.raises(HTTPException) as error:
        begin_run(
            session_factory,
            user_id,
            thread_id,
            ChatSendIn(
                text="A question requiring intent resolution",
                expected_version=1,
                request_id=uuid.uuid4(),
            ),
            settings,
        )
    assert error.value.detail == "sprout_daily_limit"


def test_followup_does_not_reuse_old_source_markers(client, session_factory):
    from app.services.sprout_context import conversation_context

    user_id = uuid.UUID(register(client).json()["id"])
    with session_factory() as db:
        thread = ChatThread(user_id=user_id)
        db.add(thread)
        db.flush()
        db.add_all(
            [
                ChatMessage(thread_id=thread.id, sequence=1, role="user", content="Soil?"),
                ChatMessage(
                    thread_id=thread.id,
                    sequence=2,
                    role="assistant",
                    content="Earlier soil explanation [kb:old] and \u3010farm:old\u3011.",
                ),
            ]
        )
        db.commit()
        thread_id = thread.id
    context = conversation_context(session_factory, user_id, thread_id, uuid.uuid4())
    assert "Earlier soil explanation" in context["recent_messages"][-1]["content"]
    assert "kb:old" not in context["recent_messages"][-1]["content"]
    assert "farm:old" not in context["recent_messages"][-1]["content"]
