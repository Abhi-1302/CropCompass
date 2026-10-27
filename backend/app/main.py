"""FastAPI application factory."""

from __future__ import annotations

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import sessionmaker

from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory
from app.deps import UNSAFE_METHODS
from app.ratelimit import RateLimiter
from app.routers import account, auth, chat, crops, farms, planner, seasons, vegetation
from app.services.farm_data import ClientFactory, default_http_client


def create_app(
    settings: Settings | None = None,
    session_factory: sessionmaker | None = None,
    http_client_factory: ClientFactory | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title="CropCompass API",
        version="0.1.0",
        docs_url="/api/docs" if settings.expose_docs else None,
        openapi_url="/api/openapi.json" if settings.expose_docs else None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.session_factory = session_factory or make_session_factory(make_engine(settings.database_url))
    app.state.http_client_factory = http_client_factory or default_http_client
    app.state.limiters = {
        "login_ip": RateLimiter(20, 300),
        "login_failures": RateLimiter(5, 900),
        "register_ip": RateLimiter(10, 3600),
        "reset_ip": RateLimiter(10, 3600),
        "reset_email": RateLimiter(3, 3600),
        "reset_token_ip": RateLimiter(20, 3600),
        "password_checks": RateLimiter(5, 900),
        "data_build": RateLimiter(20, 3600),
        "advice": RateLimiter(60, 3600),
        "sprout": RateLimiter(6, 60),
    }

    @app.middleware("http")
    async def origin_check_and_security_headers(request: Request, call_next):
        if request.method in UNSAFE_METHODS:
            origin = request.headers.get("origin")
            if origin and origin.rstrip("/") not in settings.origins:
                return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if not request.url.path.startswith("/api/docs"):
            response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    api = APIRouter(prefix="/api/v1")
    api.include_router(auth.router)
    api.include_router(account.router)
    api.include_router(farms.router)
    api.include_router(seasons.router)
    api.include_router(vegetation.router)
    api.include_router(crops.router)
    api.include_router(planner.router)
    api.include_router(chat.router)

    @api.get("/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok"}

    app.include_router(api)
    return app


app = create_app()
