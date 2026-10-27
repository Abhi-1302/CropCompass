"""Local-only browser QA factory: temporary SQLite, synthetic sources and a fake LLM."""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app.config import Settings
from app.db import Base, make_engine, make_session_factory
from app.main import create_app
from app.models import User
from app.security import hash_password
from app.sprout_schemas import ChatResolution
from tests.conftest import fake_modis, fake_sources


class PreviewModel:
    usage = 160
    usage_known = True

    def __init__(self, _settings):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        pass

    async def resolve(self, messages):
        payload = json.loads(messages[-1]["content"])
        question = payload["question"].lower()
        intent = "next_crop" if "plant" in question or "crop option" in question else "help"
        return ChatResolution(intent=intent, query=question[:800])

    async def stream(self, messages):
        payload = json.loads(messages[-1]["content"])
        source = payload["evidence"]["sources"][0]["id"]
        answer = {
            "en": (
                "This is an isolated preview response, not a live model recommendation. "
                "CropCompass compares historical scenarios; the sources and figures below come from the backend."
            ),
            "hi": (
                "यह अलग परीक्षण का जवाब है, लाइव मॉडल की सलाह नहीं। CropCompass ऐतिहासिक परिदृश्यों की तुलना करता है। "
                "नीचे के स्रोत और आँकड़े बैकएंड से हैं।"
            ),
            "te": (
                "ఇది ప్రత్యేక పరీక్ష జవాబు, ప్రత్యక్ష మోడల్ సలహా కాదు. CropCompass చారిత్రక దృశ్యాలను పోలుస్తుంది. "
                "కింది మూలాలు, గణాంకాలు బ్యాకెండ్ నుంచి వచ్చాయి."
            ),
        }[payload["language"]] + f" [{source}]"
        for offset in range(0, len(answer), 12):
            await asyncio.sleep(0.03)
            yield answer[offset : offset + 12]


def create_preview_app():
    directory = TemporaryDirectory(prefix="cropcompass-sprout-preview-")
    engine = make_engine(f"sqlite:///{(Path(directory.name) / 'preview.db').as_posix()}")
    Base.metadata.create_all(engine)
    factory = make_session_factory(engine)
    patch = pytest.MonkeyPatch()
    fake_sources.__wrapped__(patch)
    fake_modis.__wrapped__(patch)
    settings = Settings(
        _env_file=None,
        database_url="sqlite://",
        database_url_unpooled=None,
        cookie_secure=False,
        allowed_origins="http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174",
        sprout_enabled=True,
        groq_api_key="local-preview-not-a-real-key",
        smtp_host=None,
        mailjet_api_key=None,
        mailjet_api_secret=None,
        mailjet_from=None,
        sprout_daily_requests=100,
        sprout_daily_tokens=1000000,
        sprout_global_daily_tokens=1000000,
    )
    app = create_app(settings, factory)
    app.state.sprout_model_factory = PreviewModel

    @asynccontextmanager
    async def lifespan(_app):
        yield
        patch.undo()
        engine.dispose()
        directory.cleanup()

    app.router.lifespan_context = lifespan
    with factory() as db:
        db.add(
            User(
                email="sprout.preview@example.com",
                name="Sprout preview",
                password_hash=hash_password("sprout-local-preview"),
            )
        )
        db.commit()
    return app
