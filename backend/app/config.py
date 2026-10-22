"""Runtime settings, read from environment variables or backend/.env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./dev.db"
    cookie_secure: bool = True
    session_ttl_days: int = 14
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    expose_docs: bool = True
    max_farms_per_user: int = 20
    http_timeout_s: float = 120.0
    power_stale_days: int = 4
    power_refresh_days: int = 60
    public_app_url: str = "http://localhost:5173"  # base of links in emails
    password_reset_minutes: int = 30
    smtp_host: str | None = None  # without it (local development) emails are written to the server log
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "AuraFarming <no-reply@localhost>"
    smtp_starttls: bool = True

    @field_validator("database_url")
    @classmethod
    def _use_psycopg_driver(cls, value: str) -> str:
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value.removeprefix(prefix)
        return value

    @property
    def origins(self) -> set[str]:
        return {origin.strip().rstrip("/") for origin in self.allowed_origins.split(",") if origin.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
