"""Simple field nitrogen budget: legume credits, straw lock-up and the fertiliser left to apply."""

from __future__ import annotations

from engine.crops.catalog import CropParams

# Share of a legume's nitrogen credit that reaches the next crop, by what happened to its residue.
RESIDUE_N_SHARE = {"incorporated": 1.0, "mulched": 0.8, "grazed": 0.6, "removed": 0.5, "burned": 0.3}
UNKNOWN_RESIDUE_SHARE = 0.7
LOCKUP_CN = 30  # residue with a wider C:N ratio ties up soil nitrogen while it decomposes
LOCKUP_DAYS = 30
LOCKUP_KG = 20.0  # typical temporary immobilisation after ploughing in cereal straw


def legume_credit(previous: CropParams, residue: str | None) -> float:
    """kg N/ha a legume leaves for the next crop."""
    return previous.n_credit * RESIDUE_N_SHARE.get(residue, UNKNOWN_RESIDUE_SHARE)


def lockup(previous: CropParams, residue: str | None, days_to_sowing: int) -> float:
    """Extra kg N/ha needed when wide-C:N residue was ploughed in just before sowing."""
    recent = 0 <= days_to_sowing < LOCKUP_DAYS
    return LOCKUP_KG if residue == "incorporated" and previous.residue_cn > LOCKUP_CN and recent else 0.0


def fertiliser_need(crop: CropParams, credit: float, extra: float) -> float:
    return max(0.0, crop.n_rec - credit + extra)


def fixed(crop: CropParams, relative_yield: float) -> float:
    """kg N/ha a legume fixes; fixation grows with the crop."""
    return crop.n_fixed * relative_yield
