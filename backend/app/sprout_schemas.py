from __future__ import annotations

import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import Irrigation, Priorities

Language = Literal["en", "hi", "te"]
Intent = Literal["help", "farm", "soil", "history", "next_crop", "rotations", "saved_plans"]


class ChatScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")

    season: Literal["kharif", "rabi", "summer"] | None = None
    irrigation: Irrigation | None = None
    weights: Priorities | None = None
    residue: Literal["incorporated", "removed"] | None = None


class ChatThreadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    farm_id: uuid.UUID | None = None
    language: Language = "en"


class ChatSendIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=2000)
    request_id: uuid.UUID
    expected_version: int = Field(ge=0)
    language: Language = "en"
    intent: Intent | None = None
    allow_ai: bool = False
    displayed_weather_revision: str | None = Field(default=None, max_length=160)
    scenario: ChatScenario | None = None
    reset_scenario: bool = False
    retry_run_id: uuid.UUID | None = None
    selected_option_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(
        default_factory=list, max_length=3
    )


class ChatResolution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: Intent = "help"
    query: str = Field(default="", max_length=800)
    scenario: ChatScenario = Field(default_factory=ChatScenario)
    reset_scenario: bool = False
    selected_option_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(
        default_factory=list,
        max_length=3,
    )
