"""Runtime settings from the environment, backend/.env and root Neon env files."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
ROOT_DIR = ENV_FILE.parent.parent
ENV_FILES = (ENV_FILE, ROOT_DIR / ".env", ROOT_DIR / ".env.local")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILES, env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./dev.db"
    database_url_unpooled: str | None = None
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
    mailjet_api_key: str | None = Field(default=None, repr=False)
    mailjet_api_secret: str | None = Field(default=None, repr=False)
    mailjet_from: str | None = None
    mailjet_host: str = "in.mailjet.com"
    mailjet_port: int = 2525
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "CropCompass <no-reply@localhost>"
    smtp_starttls: bool = True

    sprout_enabled: bool = False
    groq_api_key: str | None = Field(default=None, repr=False)
    sprout_model: str = "openai/gpt-oss-120b"
    sprout_timeout_s: int = Field(default=60, ge=5, le=120)
    sprout_max_output_tokens: int = Field(default=1500, ge=100, le=1500)
    sprout_context_chars: int = Field(default=14000, ge=4000, le=24000)
    sprout_daily_requests: int = Field(default=20, ge=1, le=200)
    sprout_global_daily_requests: int = Field(default=100, ge=1, le=10000)
    sprout_daily_tokens: int = Field(default=40000, ge=5000, le=1000000)
    sprout_global_daily_tokens: int = Field(default=180000, ge=5000, le=10000000)
    sprout_max_threads: int = Field(default=30, ge=1, le=100)
    sprout_max_turns: int = Field(default=100, ge=1, le=500)
    sprout_max_concurrent: int = Field(default=2, ge=1, le=5)

    @property
    def sprout_ready(self) -> bool:
        key = (self.groq_api_key or "").strip()
        return self.sprout_enabled and bool(key) and key.lower() not in {"replace_me", "your_groq_api_key"}

    @property
    def mailjet_requested(self) -> bool:
        return bool(self.mailjet_api_key or self.mailjet_api_secret or self.mailjet_from)

    @property
    def email_delivery(self) -> Literal["email", "unavailable", "development"]:
        if self.mailjet_requested:
            return "email" if self.mailjet_api_key and self.mailjet_api_secret and self.mailjet_from else "unavailable"
        if self.smtp_host:
            return "email"
        return "unavailable" if self.cookie_secure else "development"

    @field_validator("database_url", "database_url_unpooled")
    @classmethod
    def _use_psycopg_driver(cls, value: str | None) -> str | None:
        if value is None:
            return None
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value.removeprefix(prefix)
        return value

    @property
    def migration_database_url(self) -> str:
        if self.database_url.startswith("sqlite"):
            return self.database_url
        return self.database_url_unpooled or self.database_url

    @property
    def origins(self) -> set[str]:
        return {origin.strip().rstrip("/") for origin in self.allowed_origins.split(",") if origin.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
