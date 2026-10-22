"""Request and response bodies."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator, model_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Irrigation = Literal["rainfed", "protective", "full"]
AreaHa = Annotated[float, Field(gt=0, le=100_000)]
Weight = Annotated[float, Field(ge=0, le=5)]
Password = Annotated[str, Field(min_length=10, max_length=128)]
AnyPassword = Annotated[str, Field(min_length=1, max_length=128)]


class Priorities(BaseModel):
    """How much the farmer cares about each pillar (0 = not at all, 5 = most)."""

    income: Weight = 1
    water: Weight = 1
    soil: Weight = 1
    risk: Weight = 1


class RegisterIn(BaseModel):
    email: EmailStr
    password: Password
    name: Name


class LoginIn(BaseModel):
    email: EmailStr
    password: AnyPassword


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str = Field(min_length=20, max_length=128)
    password: Password


class PasswordChangeIn(BaseModel):
    current_password: AnyPassword
    new_password: Password


class AccountDeleteIn(BaseModel):
    password: AnyPassword


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    name: str


Longitude = Annotated[float, Field(ge=-180, le=180)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
MAX_CORNERS = 200


class Boundary(BaseModel):
    """GeoJSON Polygon: one closed outer ring of [longitude, latitude] corners."""

    type: Literal["Polygon"]
    coordinates: list[list[tuple[Longitude, Latitude]]] = Field(min_length=1, max_length=1)

    @field_validator("coordinates")
    @classmethod
    def _closed_ring(cls, value: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
        ring = value[0]
        if not 4 <= len(ring) <= MAX_CORNERS + 1:
            raise ValueError(f"A field boundary needs 3 to {MAX_CORNERS} corners.")
        if ring[0] != ring[-1]:
            raise ValueError("The boundary must end where it starts.")
        return value


class FarmCreate(BaseModel):
    name: Name
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    area_ha: AreaHa | None = None
    boundary: Boundary | None = None
    irrigation: Irrigation = "rainfed"


class FarmUpdate(BaseModel):
    name: Name | None = None
    area_ha: AreaHa | None = None
    irrigation: Irrigation | None = None
    priorities: Priorities | None = None


class FarmOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    lat: float
    lon: float
    area_ha: float | None
    boundary: dict | None
    irrigation: str
    priorities: dict | None
    region: str | None
    cell_id: str
    data_status: str
    data_error: str | None
    created_at: datetime


SoilType = Literal["black", "red", "alluvial", "laterite", "sandy", "custom"]


class SoilOverride(BaseModel):
    """Soil values the farmer knows better than the soil map; all optional, texture parts go together."""

    soil_type: SoilType = "custom"
    sand_pct: float | None = Field(default=None, ge=0, le=100)
    silt_pct: float | None = Field(default=None, ge=0, le=100)
    clay_pct: float | None = Field(default=None, ge=0, le=100)
    awc_mm_per_m: float | None = Field(default=None, ge=30, le=300)
    depth_cm: int | None = Field(default=None, ge=20, le=200)
    organic_carbon_pct: float | None = Field(default=None, ge=0, le=10)
    ph: float | None = Field(default=None, ge=3, le=11)

    @model_validator(mode="after")
    def _texture_adds_up(self) -> SoilOverride:
        parts = (self.sand_pct, self.silt_pct, self.clay_pct)
        if any(part is not None for part in parts):
            if any(part is None for part in parts):
                raise ValueError("Give sand, silt and clay together.")
            if not 98 <= sum(parts) <= 102:
                raise ValueError("Sand, silt and clay must add up to 100%.")
        return self


class SoilOut(BaseModel):
    source: str  # soil map the estimate came from, or "none"
    layers: list[dict]
    summary: dict
    fetched_at: datetime | None
    override: dict | None
    effective: dict  # what the models use: the map with the farmer's values on top


SeasonName = Literal["kharif", "rabi", "summer", "other"]
SeasonStatus = Literal["planned", "in_field", "harvested"]
Residue = Literal["removed", "burned", "incorporated", "mulched", "grazed"]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)]


class SeasonIn(BaseModel):
    crops: list[str] = Field(min_length=1, max_length=3)
    season: SeasonName | None = None
    sow_date: date
    harvest_date: date | None = None
    status: SeasonStatus = "harvested"
    residue: Residue | None = None
    irrigations: int | None = Field(default=None, ge=0, le=60)
    yield_kg_ha: float | None = Field(default=None, ge=0, le=100_000)
    problems: list[str] = Field(default_factory=list, max_length=12)
    herbicide: ShortText | None = None
    notes: LongText | None = None
    source: Literal["farmer", "satellite"] = "farmer"


class SeasonUpdate(BaseModel):
    crops: list[str] | None = Field(default=None, min_length=1, max_length=3)
    season: SeasonName | None = None
    sow_date: date | None = None
    harvest_date: date | None = None
    status: SeasonStatus | None = None
    residue: Residue | None = None
    irrigations: int | None = Field(default=None, ge=0, le=60)
    yield_kg_ha: float | None = Field(default=None, ge=0, le=100_000)
    problems: list[str] | None = Field(default=None, max_length=12)
    herbicide: ShortText | None = None
    notes: LongText | None = None


class SeasonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    season: str
    season_year: int
    crops: list[str]
    sow_date: date
    harvest_date: date | None
    status: str
    residue: str | None
    irrigations: int | None
    yield_kg_ha: float | None
    problems: list[str]
    herbicide: str | None
    notes: str | None
    source: str
    created_at: datetime


CropSeason = Literal["kharif", "rabi", "summer"]
ResidueChoice = Literal["incorporated", "removed"]
Choice = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class NextCropIn(BaseModel):
    season: CropSeason | None = None
    irrigation: Irrigation | None = None
    weights: Priorities | None = None


class RotationsIn(BaseModel):
    irrigation: Irrigation | None = None
    weights: Priorities | None = None
    residue: ResidueChoice = "incorporated"


class StressTestIn(BaseModel):
    kind: Literal["next_crop", "rotation"]
    season: CropSeason | None = None
    irrigation: Irrigation | None = None
    weights: Priorities | None = None
    rotations: list[Choice] = Field(default_factory=list, max_length=5)


class PlanIn(BaseModel):
    kind: Literal["next_crop", "rotation"]
    title: Name
    choice: Choice  # crop id (next crop) or rotation key
    season: CropSeason | None = None
    irrigation: Irrigation | None = None
    weights: Priorities | None = None
    residue: ResidueChoice = "incorporated"


class PlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    title: str
    inputs: dict
    option: dict
    engine_version: str
    created_at: datetime
    weather_status: str = "unverified"
