"""The soil the models use: the soil-map estimate, with any values the farmer entered on top."""

from __future__ import annotations

from app.models import Farm, SoilProfile
from engine.climate.profile import DEFAULT_AWC_MM
from engine.soil.ptf import OM_PER_SOC, TOPSOIL_CM, ph_class, saxton_rawls, texture_class

SURFACE_LAYER_M = 0.10  # FAO-56 depth of the soil surface layer that dries by evaporation
DEFAULT_TEW_MM = 22.0
DEFAULT_DEPTH_CM = 100
DEFAULT_BULK_DENSITY = 1.4  # g/cm3, for the farmer's organic carbon when the map has no bulk density
TEXTURE = ("sand_pct", "silt_pct", "clay_pct")


def _evaporable_water(field_capacity: float | None, wilting_point: float | None) -> float:
    """FAO-56 eq. 73 for the surface layer."""
    if field_capacity is None or wilting_point is None:
        return DEFAULT_TEW_MM
    return min(max(1000 * (field_capacity - 0.5 * wilting_point) * SURFACE_LAYER_M, 10.0), 35.0)


def _pick(farmer: dict, mapped: dict, key: str):
    return farmer[key] if farmer.get(key) is not None else mapped.get(key)


def effective_soil(farm: Farm, profile: SoilProfile | None) -> dict:
    summary = profile.summary if profile is not None else {}
    top = summary.get("topsoil") or {}
    farmer = farm.soil_override or {}
    own_texture = farmer.get("clay_pct") is not None
    sand, silt, clay = ((farmer if own_texture else top).get(key) for key in TEXTURE)
    carbon = _pick(farmer, top, "organic_carbon_pct")
    ph = _pick(farmer, top, "ph")
    map_depth = summary.get("root_depth_cm") or DEFAULT_DEPTH_CM
    depth_cm = farmer.get("depth_cm") or map_depth

    retention = saxton_rawls(sand, clay, (carbon or 0.0) * OM_PER_SOC) if own_texture else None
    if farmer.get("awc_mm_per_m"):
        awc_per_m = float(farmer["awc_mm_per_m"])
    elif retention is not None:
        awc_per_m = retention.available_water * 1000
    elif summary.get("awc_mm"):
        awc_per_m = summary["awc_mm"] / (map_depth / 100)
    else:
        awc_per_m = DEFAULT_AWC_MM

    if retention is not None:
        tew = _evaporable_water(retention.field_capacity, retention.wilting_point)
    else:
        layer = (summary.get("layers") or [{}])[0]
        tew = _evaporable_water(layer.get("field_capacity"), layer.get("wilting_point"))

    if farmer.get("organic_carbon_pct") is not None:
        density = top.get("bulk_density_g_cm3") or DEFAULT_BULK_DENSITY
        soc = farmer["organic_carbon_pct"] * 10 * density * TOPSOIL_CM * 0.1  # g/kg x g/cm3 x cm x 0.1 = t C/ha
    else:
        soc = summary.get("soc_stock_t_ha_0_30cm")

    if farmer:
        source = "farmer"
    else:
        source = "soilgrids" if summary.get("awc_mm") else "default"
    return {
        "source": source,
        "soil_type": farmer.get("soil_type"),
        "depth_cm": depth_cm,
        "awc_mm_per_m": round(awc_per_m),
        "awc_mm": round(awc_per_m * depth_cm / 100),
        "tew_mm": round(tew, 1),
        "texture": texture_class(sand, silt, clay) if None not in (sand, silt, clay) else None,
        "sand_pct": sand,
        "silt_pct": silt,
        "clay_pct": clay,
        "organic_carbon_pct": carbon,
        "soc_stock_t_ha_0_30cm": None if soc is None else round(soc, 1),
        "ph": ph,
        "ph_class": None if ph is None else ph_class(ph),
    }
