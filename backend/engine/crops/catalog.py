"""Crop catalog: region packs and the global species sheet, stored as YAML next to this module."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path

import yaml

_PACKS = {"IN": "india.yaml"}
_SPECIES = "species.yaml"
DEFAULT_REGION = "IN"


class CatalogError(ValueError):
    pass


@dataclass(frozen=True)
class CropParams:
    """Everything the crop models need about one crop in one region pack."""

    id: str
    family: str | None
    host_groups: tuple[str, ...]
    duration: int
    sowing: dict[str, tuple[str, str]]
    stages: tuple[float, float, float, float]
    kc: tuple[float, float, float]
    root_m: float
    p: float
    ky: float
    heat_c: float | None
    hi: float | None
    dm: float | None
    residue_cn: float
    ym: float | None
    n_rec: float
    price: float = 0.0  # per kg of product
    cost: float = 0.0  # per ha, excluding nitrogen fertiliser
    n_fixed: float = 0.0
    n_credit: float = 0.0
    residue_toxic: bool = False
    small_seeded: bool = False
    self_tolerant: bool = False
    green_manure: bool = False

    def stage_ends(self, duration: int | None = None) -> tuple[int, int, int, int]:
        """Day (from sowing) on which each FAO-56 stage ends."""
        days = duration or self.duration
        total, ends = 0.0, []
        for share in self.stages:
            total += share
            ends.append(round(total * days))
        ends[-1] = days
        return tuple(ends)


@lru_cache
def load_species() -> dict:
    sheet = yaml.safe_load(Path(__file__).with_name(_SPECIES).read_text(encoding="utf-8"))
    for crop_id, entry in sheet["species"].items():
        _validate_species(crop_id, entry)
    return sheet["species"]


@lru_cache
def load_catalog(region: str | None = None) -> dict:
    """Validated catalog for a region pack; regions without a pack get the default (India) pack."""
    path = Path(__file__).with_name(_PACKS.get(region or DEFAULT_REGION, _PACKS[DEFAULT_REGION]))
    catalog = yaml.safe_load(path.read_text(encoding="utf-8"))
    _validate(catalog, load_species())
    return catalog


def has_pack(region: str | None) -> bool:
    return region in _PACKS


def _validate_species(crop_id: str, entry: dict) -> None:
    if len(entry["stages"]) != 4 or abs(sum(entry["stages"]) - 1) > 0.015:
        raise CatalogError(f"{crop_id}: stage shares must be 4 values adding up to 1")
    if len(entry["kc"]) != 3 or not 0 < entry["p"] < 1 or entry["root_m"] <= 0 or entry["ky"] <= 0:
        raise CatalogError(f"{crop_id}: invalid water parameters")
    if not entry.get("green_manure") and not (entry["hi"] and entry["dm"]):
        raise CatalogError(f"{crop_id}: harvest index and dry matter are required")


def _month_day(value: str) -> tuple[int, int]:
    month, day = (int(part) for part in value.split("-"))
    date(2001, month, day)  # raises for impossible dates
    return month, day


def _validate(catalog: dict, species: dict) -> None:
    ids = [crop["id"] for crop in catalog["crops"]]
    if len(ids) != len(set(ids)):
        raise CatalogError("Duplicate crop ids")
    agronomy = catalog.get("agronomy", {})
    for crop in catalog["crops"]:
        if crop["family"] is not None and crop["family"] not in catalog["families"]:
            raise CatalogError(f"{crop['id']}: unknown family {crop['family']}")
        if crop["group"] not in catalog["groups"]:
            raise CatalogError(f"{crop['id']}: unknown group {crop['group']}")
        if unknown := set(crop["seasons"]) - set(catalog["seasons"]):
            raise CatalogError(f"{crop['id']}: unknown seasons {unknown}")
        if unknown := set(crop["host_groups"]) - set(catalog["host_groups"]):
            raise CatalogError(f"{crop['id']}: unknown host groups {unknown}")
        if crop["group"] == "other":
            continue
        if crop["id"] not in agronomy or crop["id"] not in species:
            raise CatalogError(f"{crop['id']}: missing agronomy or species parameters")
        sowing = agronomy[crop["id"]]["sowing"]
        if set(sowing) != set(crop["seasons"]):
            raise CatalogError(f"{crop['id']}: sowing windows must match its seasons")
        if agronomy[crop["id"]].get("price", 0) < 0 or agronomy[crop["id"]].get("cost", 0) < 0:
            raise CatalogError(f"{crop['id']}: price and cost can't be negative")
        for window in sowing.values():
            for value in window:
                _month_day(value)
    for key, problem in catalog["problems"].items():
        if unknown := set(problem.get("host_groups", [])) - set(catalog["host_groups"]):
            raise CatalogError(f"problem {key}: unknown host groups {unknown}")
    for source, members in catalog.get("economics", {}).get("price_sources", {}).items():
        if unknown := set(members) - set(agronomy):
            raise CatalogError(f"price source {source}: unknown crops {unknown}")


def crop_ids(region: str | None = None) -> set[str]:
    return {crop["id"] for crop in load_catalog(region)["crops"]}


@lru_cache
def crop_params(region: str | None, crop_id: str) -> CropParams | None:
    """Model parameters for a crop, or None for crops the models can't simulate (e.g. "other")."""
    catalog = load_catalog(region)
    crop = next((c for c in catalog["crops"] if c["id"] == crop_id), None)
    agronomy = catalog.get("agronomy", {}).get(crop_id)
    sheet = load_species().get(crop_id)
    if crop is None or agronomy is None or sheet is None:
        return None
    low, high = crop["duration_days"]
    return CropParams(
        id=crop_id,
        family=crop["family"],
        host_groups=tuple(crop["host_groups"]),
        duration=round((low + high) / 2),
        sowing={season: (window[0], window[1]) for season, window in agronomy["sowing"].items()},
        stages=tuple(sheet["stages"]),
        kc=tuple(sheet["kc"]),
        root_m=sheet["root_m"],
        p=sheet["p"],
        ky=sheet["ky"],
        heat_c=sheet["heat_c"],
        hi=sheet["hi"],
        dm=sheet["dm"],
        residue_cn=sheet["residue_cn"],
        ym=agronomy.get("ym"),
        n_rec=agronomy.get("n_rec", 0.0),
        price=agronomy.get("price", 0.0),
        cost=agronomy.get("cost", 0.0),
        n_fixed=sheet.get("n_fixed", 0.0),
        n_credit=sheet.get("n_credit", 0.0),
        residue_toxic=sheet.get("residue_toxic", False),
        small_seeded=sheet.get("small_seeded", False),
        self_tolerant=sheet.get("self_tolerant", False),
        green_manure=sheet.get("green_manure", False),
    )


def simulation_settings(region: str | None) -> dict:
    return load_catalog(region)["simulation"]


def economics_settings(region: str | None) -> dict:
    return load_catalog(region)["economics"]


def season_for_sowing(sowing: date) -> tuple[str, int]:
    """South-Asian season and season year implied by a sowing date (January sowings belong to last year's rabi)."""
    month = sowing.month
    if 6 <= month <= 9:
        return "kharif", sowing.year
    if month >= 10:
        return "rabi", sowing.year
    if month == 1:
        return "rabi", sowing.year - 1
    return "summer", sowing.year


def season_for_peak(peak: date) -> tuple[str, int]:
    """Season of a crop that was greenest on `peak`; steadier than a sowing date estimated from satellite green-up."""
    month = peak.month
    if 7 <= month <= 11:
        return "kharif", peak.year
    if month == 12:
        return "rabi", peak.year
    if month <= 3:
        return "rabi", peak.year - 1
    return "summer", peak.year
