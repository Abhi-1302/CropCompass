from pathlib import Path

import pytest

from app.config import ENV_FILE, ENV_FILES, ROOT_DIR, Settings


@pytest.mark.parametrize("prefix", ["postgres://", "postgresql://", "postgresql+psycopg://"])
def test_postgres_urls_use_psycopg(prefix: str):
    settings = Settings(
        _env_file=None,
        database_url=f"{prefix}user:password@db-pooler.example/db?sslmode=require",
        database_url_unpooled=f"{prefix}user:password@db.example/db?sslmode=require",
    )
    assert settings.database_url == "postgresql+psycopg://user:password@db-pooler.example/db?sslmode=require"
    assert settings.migration_database_url == "postgresql+psycopg://user:password@db.example/db?sslmode=require"


def test_migrations_fall_back_to_application_url():
    settings = Settings(_env_file=None, database_url="postgresql://user:password@db.example/db")
    assert settings.migration_database_url == settings.database_url


def test_explicit_sqlite_does_not_use_neon_migration_url():
    settings = Settings(
        _env_file=None,
        database_url="sqlite://",
        database_url_unpooled="postgresql://user:password@db.example/db",
    )
    assert settings.migration_database_url == "sqlite://"


def test_neon_environment_file_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL_UNPOOLED", raising=False)
    monkeypatch.delenv("COOKIE_SECURE", raising=False)
    assert ENV_FILES == (ENV_FILE, ROOT_DIR / ".env", ROOT_DIR / ".env.local")
    assert Settings.model_config["env_file"] == ENV_FILES
    backend_env = tmp_path / "backend.env"
    root_env = tmp_path / "root.env"
    neon_env = tmp_path / "neon.env"
    backend_env.write_text("DATABASE_URL=sqlite:///./dev.db\nCOOKIE_SECURE=false\n", encoding="utf-8")
    root_env.write_text("DATABASE_URL=postgresql://user:password@old.example/db\n", encoding="utf-8")
    neon_env.write_text(
        "DATABASE_URL=postgresql://user:password@db-pooler.example/db\n"
        "DATABASE_URL_UNPOOLED=postgresql://user:password@db.example/db\n",
        encoding="utf-8",
    )
    settings = Settings(_env_file=(backend_env, root_env, neon_env))
    assert "db-pooler.example" in settings.database_url
    assert "db.example" in settings.migration_database_url
    assert settings.cookie_secure is False
    monkeypatch.setenv("DATABASE_URL", "sqlite://")
    overridden = Settings(_env_file=(backend_env, root_env, neon_env))
    assert overridden.database_url == overridden.migration_database_url == "sqlite://"


def test_sqlite_default_without_environment_files(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL_UNPOOLED", raising=False)
    settings = Settings(_env_file=None)
    assert settings.database_url == settings.migration_database_url == "sqlite:///./dev.db"
