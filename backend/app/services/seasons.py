"""Season-journal rules that need the crop catalog or more than one field at a time."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from engine.crops.catalog import load_catalog, season_for_sowing

EARLIEST_SOWING = date(1981, 1, 1)
MAX_SEASON_DAYS = 400


class SeasonError(ValueError):
    pass


def normalize_season(values: dict, region: str | None) -> dict:
    """Validate a season record (create or merged update) and fill in season / season_year."""
    catalog = load_catalog(region)
    crops = values["crops"]
    if len(set(crops)) != len(crops):
        raise SeasonError("Each crop can be listed only once.")
    known = {crop["id"] for crop in catalog["crops"]}
    if unknown := [crop for crop in crops if crop not in known]:
        raise SeasonError(f"Unknown crop: {', '.join(unknown)}")
    if "fallow" in crops and len(crops) > 1:
        raise SeasonError("A fallow season can't also have crops.")
    if unknown := [p for p in values.get("problems") or [] if p not in catalog["problems"]]:
        raise SeasonError(f"Unknown problem: {', '.join(unknown)}")

    today = datetime.now(UTC).date()
    sow, harvest, status = values["sow_date"], values.get("harvest_date"), values["status"]
    if not EARLIEST_SOWING <= sow <= today + timedelta(days=MAX_SEASON_DAYS):
        raise SeasonError("The sowing date is out of range.")
    if harvest is not None:
        if harvest < sow:
            raise SeasonError("The harvest date must be on or after the sowing date.")
        if (harvest - sow).days > MAX_SEASON_DAYS:
            raise SeasonError(f"A season can't be longer than {MAX_SEASON_DAYS} days.")
    if status == "harvested":
        if harvest is None:
            raise SeasonError("Add the harvest date for a harvested season.")
        if harvest > today:
            raise SeasonError("A harvested season can't end in the future.")
    if status == "in_field" and sow > today:
        raise SeasonError("A crop that is in the field must already be sown.")

    season = values.get("season")
    if region == "IN":
        season = season or season_for_sowing(sow)[0]
        year = sow.year - 1 if season == "rabi" and sow.month <= 3 else sow.year
    else:
        season, year = season or "other", sow.year
    return {**values, "season": season, "season_year": year, "problems": values.get("problems") or []}
