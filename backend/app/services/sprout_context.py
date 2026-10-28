from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select

from app.models import ChatMessage, ClimateCell, Plan, SeasonRecord, SoilProfile
from app.services import planner
from app.services.climate_cache import advice_weather_context
from app.services.farm_inputs import data_key
from app.services.soil import effective_soil
from app.services.sprout import owned_thread
from app.sprout_schemas import ChatResolution, ChatSendIn
from engine.crops.catalog import has_pack, load_catalog
from engine.planner import ENGINE_VERSION


@lru_cache
def knowledge() -> dict:
    return json.loads((Path(__file__).parents[1] / "knowledge" / "sprout.json").read_text(encoding="utf-8"))


def retrieve(query: str, limit: int = 3) -> list[dict]:
    words = set(re.findall(r"\w+", query.lower()))
    scored = []
    for section in knowledge()["sections"]:
        score = sum(4 for tag in section["tags"] if tag.lower() in query.lower())
        score += len(words & set(re.findall(r"\w+", section["title"].lower())))
        if score:
            scored.append((score, section))
    scored.sort(key=lambda item: item[0], reverse=True)
    selected = [section for _score, section in scored[:limit]] or [knowledge()["sections"][0]]
    return [
        {"id": f"kb:{item['id']}", "title": item["title"], "text": item["text"], "version": knowledge()["version"]}
        for item in selected
    ]


def conversation_context(factory, user_id, thread_id, current_message_id) -> dict:
    with factory() as db:
        thread = owned_thread(db, user_id, thread_id)
        messages = list(
            db.scalars(
                select(ChatMessage)
                .where(
                    ChatMessage.thread_id == thread.id,
                    ChatMessage.id != current_message_id,
                )
                .order_by(ChatMessage.sequence.desc())
                .limit(12)
            )
        )
        messages.reverse()
        completed = []
        for index, message in enumerate(messages):
            if message.role == "user" and (index + 1 == len(messages) or messages[index + 1].role != "assistant"):
                continue
            content = message.content
            if message.role == "assistant":
                content = re.sub(r"[\[\u3010](?:kb|planner|farm):[^\]\u3011\s]+[\]\u3011]", "", content)
            completed.append({"role": message.role, "content": content[:900]})
        evidence = next(
            (
                message.evidence
                for message in reversed(messages)
                if message.role == "assistant" and message.evidence.get("options")
            ),
            {},
        )
        return {
            "scope": "farm" if thread.farm_id else "platform",
            "scenario": thread.scenario,
            "earlier_questions": thread.summary,
            "recent_messages": completed[-6:],
            "previous_options": evidence.get("options", []),
            "previous_intent": evidence.get("intent"),
            "previous_revision": evidence.get("input_revision"),
        }


def _option(option: dict, kind: str, names: dict) -> dict:
    if kind == "next_crop":
        crop = option.get("id", "")
        failure = option.get("yield", {}).get("failure")
        return {
            "id": crop,
            "label": names.get(crop, crop),
            "rank": option.get("rank"),
            "score": option.get("score"),
            "pillars": option.get("pillars"),
            "comparable_pillars": option.get("comparable_pillars", []),
            "ranking_reasons": option.get("reasons", []),
            "yield_kg_ha_p50": option.get("yield", {}).get("p50"),
            "income_inr_ha": option.get("income", {}).get("mean"),
            "income_period": "season",
            "failure": failure,
            "sowing": option.get("sowing", {}).get("best"),
            "rules": option.get("rules", [])[:3],
        }
    sequence = [season.get("crop") or "fallow" for year in option.get("years", []) for season in year["seasons"]]
    return {
        "id": option["key"],
        "label": " / ".join(names.get(crop, crop) for crop in sequence),
        "rank": option.get("rank"),
        "score": option.get("score"),
        "pillars": option.get("pillars"),
        "comparable_pillars": option.get("comparable_pillars", []),
        "ranking_reasons": option.get("reasons", []),
        "income_inr_ha": option.get("income", {}).get("mean"),
        "income_period": "year",
        "irrigation_mm": option.get("water", {}).get("irrigation_mm"),
        "failure": option.get("risk", {}).get("failure"),
        "rules": option.get("rules", [])[:3],
    }


def build_evidence(factory, user_id, thread_id, body: ChatSendIn, resolution: ChatResolution, before=None) -> dict:
    with factory() as db:
        thread = owned_thread(db, user_id, thread_id)
        scenario = {} if body.reset_scenario or resolution.reset_scenario else dict(thread.scenario)
        scenario.update(resolution.scenario.model_dump(exclude_none=True))
        if body.scenario:
            scenario.update(body.scenario.model_dump(exclude_none=True))
        sources = retrieve(f"{body.text} {resolution.query} {resolution.intent}")
        result = {
            "intent": resolution.intent,
            "as_of": datetime.now(UTC).isoformat(),
            "knowledge_version": knowledge()["version"],
            "engine_version": ENGINE_VERSION,
            "sources": sources,
            "scenario": scenario,
            "options": [],
            "facts": {},
        }
        if thread.farm_id is None:
            if resolution.intent != "help":
                result["notice"] = "select_farm"
            return result
        from app.models import Farm

        farm = db.get(Farm, thread.farm_id)
        profile = db.get(SoilProfile, farm.id)
        records = list(
            db.scalars(
                select(SeasonRecord)
                .where(
                    SeasonRecord.farm_id == farm.id,
                )
                .order_by(SeasonRecord.sow_date.desc())
                .limit(6)
            )
        )
        result["facts"] = {
            "region": farm.region,
            "area_ha": farm.area_ha,
            "saved_irrigation": farm.irrigation,
            "saved_priorities": farm.priorities,
            "data_status": farm.data_status,
            "soil": effective_soil(farm, profile),
            "soil_units": {
                "depth_cm": "cm",
                "awc_mm_per_m": "mm/m",
                "awc_mm": "mm",
                "tew_mm": "mm",
                "sand_pct": "%",
                "silt_pct": "%",
                "clay_pct": "%",
                "organic_carbon_pct": "%",
                "soc_stock_t_ha_0_30cm": "tonnes C/ha in the 0-30 cm layer",
                "ph": "dimensionless",
            },
            "soil_provenance": {
                "field_measurements_verified": False,
                "farmer_reported_fields": sorted((farm.soil_override or {}).keys()),
                "depth": (
                    "Effective modelling depth: farmer-reported if overridden, otherwise mapped/default assumption; "
                    "not a verified field measurement."
                ),
                "water_capacity": (
                    "Estimated or farmer-reported. AWC per metre is water depth per metre of soil (mm/m); "
                    "total AWC is water depth over the effective root zone (mm)."
                ),
                "evaporable_water": (
                    "TEW is modelled evaporable water in the 0.1 m surface layer. "
                    "It is not a reported fraction of root-zone available water."
                ),
            },
            "history": [
                {
                    "crops": row.crops,
                    "season": row.season,
                    "sow_date": str(row.sow_date),
                    "harvest_date": str(row.harvest_date) if row.harvest_date else None,
                    "status": row.status,
                    "yield_kg_ha": row.yield_kg_ha,
                }
                for row in records
            ],
        }
        result["sources"].append(
            {
                "id": "farm:records",
                "title": "Farm records and effective soil",
                "text": "Current saved settings, soil provenance and crop journal.",
                "version": farm.updated_at.isoformat(),
                "href": f"/farms/{farm.id}?tab=soil",
            }
        )
        try:
            result["weather_context"] = advice_weather_context(db, db.get(ClimateCell, farm.cell_id))
        except LookupError:
            result["weather_context"] = None
        result["facts"]["advice_readiness"] = {
            "supported_region": has_pack(farm.region),
            "checked_weather_available": result["weather_context"] is not None,
        }
        try:
            fingerprint = data_key(db, farm, advice=True)
        except LookupError:
            fingerprint = (
                farm.updated_at,
                profile.fetched_at if profile else None,
                [(row.id, row.updated_at) for row in records],
                result["weather_context"],
            )
        fingerprint = (fingerprint, farm.priorities, scenario, ENGINE_VERSION, datetime.now(UTC).date())
        result["input_revision"] = hashlib.sha256(json.dumps(fingerprint, default=str).encode()).hexdigest()
        if resolution.intent in {"next_crop", "rotations"}:
            try:
                irrigation = scenario.get("irrigation", farm.irrigation)
                if resolution.intent == "next_crop":
                    advice = planner.next_crop(
                        db, farm, scenario.get("season"), irrigation, scenario.get("weights"), before
                    )
                else:
                    advice = planner.rotations(
                        db, farm, irrigation, scenario.get("weights"), scenario.get("residue", "incorporated"), before
                    )
            except (LookupError, ValueError):
                result["notice"] = "advice_unavailable"
                result["advice_unavailable_reason"] = (
                    "unsupported_region"
                    if not has_pack(farm.region)
                    else "checked_weather_unavailable"
                    if result["weather_context"] is None
                    else "planner_inputs_unavailable"
                )
                return result
            result["weather_context"] = advice["weather_context"]
            if (
                body.displayed_weather_revision
                and body.displayed_weather_revision != advice["weather_context"]["revision"]
            ):
                result["notice"] = "selection_changed"
            result["confidence"] = advice.get("confidence")
            result["period"] = advice.get("period")
            result["applied_scenario"] = {**scenario, "irrigation": advice["irrigation"], "weights": advice["weights"]}
            if "season" in advice:
                result["applied_scenario"]["season"] = advice["season"]
            if "residue" in advice:
                result["applied_scenario"]["residue"] = advice["residue"]
            names = {crop["id"]: crop.get("name", crop["id"]) for crop in load_catalog(farm.region)["crops"]}
            selected = set(body.selected_option_ids or resolution.selected_option_ids)
            choices = advice.get("options", [])
            if selected and not selected.issubset({option.get("id", option.get("key")) for option in choices}):
                result["notice"] = "selection_changed"
            chosen = (
                [option for option in choices if option.get("id", option.get("key")) in selected] if selected else []
            )
            chosen += [option for option in choices[:3] if option not in chosen]
            result["options"] = [_option(option, resolution.intent, names) for option in chosen[:3]]
            result["sources"].append(
                {
                    "id": "planner:current",
                    "title": "Current planner simulation",
                    "text": "Historical scenarios, not a forecast or guaranteed income.",
                    "version": result["input_revision"],
                    "href": f"/farms/{farm.id}?tab=plan",
                }
            )
        elif resolution.intent == "saved_plans":
            plans = db.scalars(select(Plan).where(Plan.farm_id == farm.id).order_by(Plan.created_at.desc()).limit(3))
            result["facts"]["saved_plans"] = [
                {
                    "kind": plan.kind,
                    "created_at": plan.created_at.isoformat(),
                    "inputs": plan.inputs,
                    "engine_version": plan.engine_version,
                    "historical_snapshot": True,
                }
                for plan in plans
            ]
        return result
