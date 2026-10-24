"""Soil water retention (Saxton & Rawls 2006), USDA texture class and carbon stock from SoilGrids layers."""

from __future__ import annotations

import math
from dataclasses import dataclass

OM_PER_SOC = 1.724  # Van Bemmelen factor: organic matter = 1.724 x organic carbon
MAX_OM_PCT = 8.0  # range the Saxton & Rawls regressions were fitted on
TOPSOIL_CM = 30


@dataclass(frozen=True)
class WaterRetention:
    wilting_point: float  # m3/m3 at 1500 kPa
    field_capacity: float  # m3/m3 at 33 kPa
    saturation: float  # m3/m3
    ksat_mm_h: float

    @property
    def available_water(self) -> float:
        return self.field_capacity - self.wilting_point


def saxton_rawls(sand_pct: float, clay_pct: float, om_pct: float) -> WaterRetention:
    s, c = sand_pct / 100, clay_pct / 100
    om = min(max(om_pct, 0.0), MAX_OM_PCT)
    t1500 = -0.024 * s + 0.487 * c + 0.006 * om + 0.005 * s * om - 0.013 * c * om + 0.068 * s * c + 0.031
    wp = t1500 + (0.14 * t1500 - 0.02)
    t33 = -0.251 * s + 0.195 * c + 0.011 * om + 0.006 * s * om - 0.027 * c * om + 0.452 * s * c + 0.299
    fc = t33 + (1.283 * t33**2 - 0.374 * t33 - 0.015)
    ts33 = 0.278 * s + 0.034 * c + 0.022 * om - 0.018 * s * om - 0.027 * c * om - 0.584 * s * c + 0.078
    sat = fc + ts33 + (0.636 * ts33 - 0.107) - 0.097 * s + 0.043
    lam = (math.log(fc) - math.log(wp)) / (math.log(1500) - math.log(33))
    ksat = 1930 * max(sat - fc, 0.0) ** (3 - lam)
    return WaterRetention(wp, fc, sat, ksat)


def texture_class(sand: float, silt: float, clay: float) -> str:
    """USDA soil texture triangle."""
    total = sand + silt + clay
    if total <= 0:
        raise ValueError("Sand, silt and clay must add up to a positive total")
    sand, silt, clay = (100 * v / total for v in (sand, silt, clay))
    if silt + 1.5 * clay < 15:
        return "sand"
    if silt + 2 * clay < 30:
        return "loamy sand"
    if clay >= 40:
        if silt >= 40:
            return "silty clay"
        return "sandy clay" if sand > 45 else "clay"
    if clay >= 35 and sand > 45:
        return "sandy clay"
    if clay >= 27:
        if sand <= 20:
            return "silty clay loam"
        return "clay loam" if sand <= 45 else "sandy clay loam"
    if clay >= 20 and silt < 28 and sand > 45:
        return "sandy clay loam"
    if silt >= 80 and clay < 12:
        return "silt"
    if silt >= 50:
        return "silt loam"
    if clay >= 7 and silt >= 28 and sand <= 52:
        return "loam"
    return "sandy loam"


def ph_class(ph: float) -> str:
    if ph < 5.5:
        return "acidic"
    if ph < 6.5:
        return "slightly acidic"
    if ph <= 7.5:
        return "neutral"
    if ph <= 8.5:
        return "alkaline"
    return "strongly alkaline"


def cec_class(cec: float) -> str:
    if cec < 10:
        return "low"
    return "medium" if cec <= 25 else "high"


def _weighted_topsoil(layers: list[dict], key: str) -> float | None:
    total = weight = 0.0
    for layer in layers:
        value = layer.get(key)
        thickness = max(0, min(layer["bottom_cm"], TOPSOIL_CM) - layer["top_cm"])
        if value is not None and thickness > 0:
            total += value * thickness
            weight += thickness
    return total / weight if weight else None


def summarize_profile(layers: list[dict], root_depth_cm: int = 100) -> dict:
    """Plant-available water in the root zone, topsoil properties and organic-carbon stock (0-30 cm)."""
    awc_mm = 0.0
    covered_cm = 0
    soc_stock = 0.0
    soc_cm = 0
    hydraulics = []
    for layer in layers:
        top, bottom = layer["top_cm"], layer["bottom_cm"]
        sand, silt, clay, soc, bd = (layer.get(k) for k in ("sand", "silt", "clay", "soc", "bdod"))
        info: dict = {"depth": layer["depth"]}
        if sand is not None and clay is not None:
            retention = saxton_rawls(sand, clay, (soc or 0.0) / 10 * OM_PER_SOC)
            info |= {
                "wilting_point": round(retention.wilting_point, 3),
                "field_capacity": round(retention.field_capacity, 3),
                "available_water": round(retention.available_water, 3),
                "ksat_mm_h": round(retention.ksat_mm_h, 1),
            }
            if silt is not None:
                info["texture"] = texture_class(sand, silt, clay)
            overlap = max(0, min(bottom, root_depth_cm) - top)
            awc_mm += retention.available_water * overlap * 10
            covered_cm += overlap
        if soc is not None and bd is not None and top < TOPSOIL_CM:
            thickness = min(bottom, TOPSOIL_CM) - top
            soc_stock += soc * bd * thickness * 0.1  # g/kg x g/cm3 x cm x 0.1 = t C/ha
            soc_cm += thickness
        hydraulics.append(info)

    topsoil = {
        key: _weighted_topsoil(layers, key)
        for key in ("sand", "silt", "clay", "soc", "phh2o", "cec", "nitrogen", "bdod")
    }
    texture = None
    if None not in (topsoil["sand"], topsoil["silt"], topsoil["clay"]):
        texture = texture_class(topsoil["sand"], topsoil["silt"], topsoil["clay"])
    return {
        "root_depth_cm": root_depth_cm,
        "awc_mm": round(awc_mm * root_depth_cm / covered_cm) if covered_cm else None,
        "soc_stock_t_ha_0_30cm": round(soc_stock, 1) if soc_cm == TOPSOIL_CM else None,
        "topsoil": {
            "texture": texture,
            "sand_pct": _round(topsoil["sand"], 1),
            "silt_pct": _round(topsoil["silt"], 1),
            "clay_pct": _round(topsoil["clay"], 1),
            "organic_carbon_pct": _round(topsoil["soc"] / 10 if topsoil["soc"] is not None else None, 2),
            "ph": _round(topsoil["phh2o"], 1),
            "ph_class": ph_class(topsoil["phh2o"]) if topsoil["phh2o"] is not None else None,
            "cec_cmol_kg": _round(topsoil["cec"], 1),
            "cec_class": cec_class(topsoil["cec"]) if topsoil["cec"] is not None else None,
            "nitrogen_g_kg": _round(topsoil["nitrogen"], 2),
            "bulk_density_g_cm3": _round(topsoil["bdod"], 2),
        },
        "layers": hydraulics,
    }


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)
