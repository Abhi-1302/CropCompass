"""ORM models (docs/PLAN.md section 9)."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PasswordReset(Base):
    """A single-use password-reset link; only a hash of its token is stored."""

    __tablename__ = "password_resets"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ClimateCell(Base):
    """One NASA POWER grid cell (~50 km), shared by every farm inside it."""

    __tablename__ = "climate_cells"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    elevation_m: Mapped[float | None] = mapped_column(Float)
    series: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    first_date: Mapped[date] = mapped_column(Date)
    last_date: Mapped[date] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    quality: Mapped[str] = mapped_column(String(20), default="unverified")
    quality_error: Mapped[str | None] = mapped_column(Text)
    revision: Mapped[str | None] = mapped_column(String(36))
    validation_version: Mapped[str | None] = mapped_column(String(40))
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    years_done: Mapped[int] = mapped_column(Integer, default=0)
    years_total: Mapped[int] = mapped_column(Integer, default=0)


class WeatherYear(Base):
    __tablename__ = "weather_years"

    cell_id: Mapped[str] = mapped_column(ForeignKey("climate_cells.id", ondelete="CASCADE"), primary_key=True)
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    series: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    provenance: Mapped[dict] = mapped_column(JSONType)
    validation_version: Mapped[str] = mapped_column(String(40))
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Farm(Base):
    __tablename__ = "farms"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    area_ha: Mapped[float | None] = mapped_column(Float)
    boundary: Mapped[dict | None] = mapped_column(JSONType)  # GeoJSON Polygon drawn by the farmer
    irrigation: Mapped[str] = mapped_column(String(16), default="rainfed")
    priorities: Mapped[dict | None] = mapped_column(JSONType)
    soil_override: Mapped[dict | None] = mapped_column(JSONType)  # soil values the farmer entered
    region: Mapped[str | None] = mapped_column(String(8))
    cell_id: Mapped[str] = mapped_column(String(32), index=True)
    data_status: Mapped[str] = mapped_column(String(16), default="pending")
    data_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SoilProfile(Base):
    __tablename__ = "soil_profiles"

    farm_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farms.id", ondelete="CASCADE"), primary_key=True)
    source: Mapped[str] = mapped_column(String(32))
    layers: Mapped[list] = mapped_column(JSONType)
    summary: Mapped[dict] = mapped_column(JSONType)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class VegetationSeries(Base):
    """MODIS NDVI for the 250 m pixel under a farm, keyed by composite date (filled newest-first)."""

    __tablename__ = "vegetation_series"

    farm_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farms.id", ondelete="CASCADE"), primary_key=True)
    product: Mapped[str] = mapped_column(String(16), default="MOD13Q1")
    ndvi: Mapped[dict] = mapped_column(JSONType, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    composites_total: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SeasonRecord(Base):
    """One crop season on a farm as logged by the farmer (or confirmed from a satellite suggestion)."""

    __tablename__ = "season_records"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    farm_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farms.id", ondelete="CASCADE"), index=True)
    season: Mapped[str] = mapped_column(String(16))
    season_year: Mapped[int] = mapped_column(Integer)
    crops: Mapped[list] = mapped_column(JSONType)
    sow_date: Mapped[date] = mapped_column(Date)
    harvest_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16))
    residue: Mapped[str | None] = mapped_column(String(16))
    irrigations: Mapped[int | None] = mapped_column(Integer)
    yield_kg_ha: Mapped[float | None] = mapped_column(Float)
    problems: Mapped[list] = mapped_column(JSONType, default=list)
    herbicide: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="farmer")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Plan(Base):
    """A saved next-crop choice or rotation, with the inputs and engine version that produced it."""

    __tablename__ = "plans"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    farm_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("farms.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(80))
    inputs: Mapped[dict] = mapped_column(JSONType)
    option: Mapped[dict] = mapped_column(JSONType)
    engine_version: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
