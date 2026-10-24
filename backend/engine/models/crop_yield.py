"""Crop yield from water use (FAO-33 / FAO-56 eq. 90) and heat at flowering.

A seasonal Ky averages stress over the whole season, so a dry spell at flowering, the most water-sensitive
period for most crops (FAO-33), barely shows. The same Ky is therefore also applied to the deficit during
flowering, and the stricter of the two responses limits the yield.

FAO-33 fitted the linear Ky response for deficits up to about 50%. Extrapolated further it leaves a yield of
1 - Ky even without water (30% for groundnut), so below half the water need the yield falls linearly to zero.
"""

from __future__ import annotations

import numpy as np

FAILURE_SHARE = 0.5  # a season "fails" below half the attainable yield (docs/PLAN.md section 7.7)
LINEAR_LIMIT = 0.5  # ETa / ETc below which the linear Ky response no longer holds


def water_factor(eta_mm, etc_mm, ky) -> np.ndarray:
    """1 - Ky (1 - ETa / ETc), falling to zero below half the water need; limited to 0-1."""
    eta, etc = np.asarray(eta_mm, dtype=float), np.asarray(etc_mm, dtype=float)
    ratio = np.divide(eta, etc, out=np.ones_like(eta), where=etc > 0)
    ky = np.asarray(ky, dtype=float)
    linear = 1 - ky * (1 - ratio)
    collapse = (1 - ky * (1 - LINEAR_LIMIT)) * ratio / LINEAR_LIMIT
    return np.clip(np.where(ratio < LINEAR_LIMIT, np.minimum(linear, collapse), linear), 0, 1)


def relative_yield(eta_mm, etc_mm, ky, heat_damage, succession=1.0, eta_flowering_mm=None, etc_flowering_mm=None):
    """Share of the attainable yield: water deficit x heat at flowering x previous-crop effects."""
    water = water_factor(eta_mm, etc_mm, ky)
    if eta_flowering_mm is not None:
        water = np.minimum(water, water_factor(eta_flowering_mm, etc_flowering_mm, ky))
    heat = np.clip(1 - np.asarray(heat_damage, dtype=float), 0, 1)
    return water * heat * np.asarray(succession, dtype=float)
