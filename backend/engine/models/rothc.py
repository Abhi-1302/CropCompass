"""RothC-26.3 soil-carbon model (Coleman & Jenkinson), monthly steps, vectorised over scenarios.

Pools DPM, RPM, BIO and HUM decay at first-order rates scaled by temperature (a), topsoil moisture deficit (b)
and plant cover (c); the inert pool follows Falloon et al. (1998). Today's measured carbon stock is assumed
to be in equilibrium with the farm's current practice (inverse mode, as in FAO GSOCseq); scenarios change
carbon inputs relative to that practice.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

from engine.crops.catalog import CropParams

RATES = np.array([10.0, 0.3, 0.66, 0.02])  # per year: DPM, RPM, BIO, HUM
DPM_SHARE = 1.44 / 2.44  # DPM/RPM ratio 1.44 for agricultural crops
BIO_SHARE = 0.46
CARBON_PER_DRY_MATTER = 0.45
BELOW_GROUND_SHARE = 0.25  # roots and root exudates as a share of shoot dry matter (indicative)
RESIDUE_RETURN = {"incorporated": 1.0, "mulched": 1.0, "grazed": 0.4, "removed": 0.1, "burned": 0.05}
UNKNOWN_RESIDUE_RETURN = 0.3
COVERED_DAYS = 15  # a month counts as covered by a crop from this many days
DRYLAND_ARIDITY = 0.65  # rain / PET below this is a dryland (UNEP)


@dataclass(frozen=True)
class MonthlyClimate:
    temp_c: np.ndarray  # (12,) mean air temperature
    rain_mm: np.ndarray  # (12,)
    pet_mm: np.ndarray  # (12,) RothC's 0.75 x open-pan evaporation, close to FAO-56 ET0


@dataclass(frozen=True)
class CropCarbon:
    """Carbon one crop-season returns to the soil by calendar month (t C/ha), and the months it covers."""

    inputs: np.ndarray
    cover: np.ndarray


def temperature_factor(temp_c) -> np.ndarray:
    t = np.asarray(temp_c, dtype=float)
    a = 47.91 / (1 + np.exp(106.06 / (np.maximum(t, -5.0) + 18.27)))
    return np.where(t < -5.0, 0.0, a)


def is_dryland(climate: MonthlyClimate) -> bool:
    return climate.rain_mm.sum() / climate.pet_mm.sum() < DRYLAND_ARIDITY


def moisture_factor(
    climate: MonthlyClimate, clay_pct: float, depth_cm: float, cover, dryland: bool = False
) -> np.ndarray:
    """Rate modifier b per scenario and month; the year is run twice so the deficit cycle repeats.

    RothC 26.3 lets bare topsoil dry to only 1/1.8 of the full deficit, which keeps decomposition fast through a
    months-long tropical dry season; in drylands bare soil may dry fully, so dry soil decomposes slowly under
    every practice (dryland adjustment).
    """
    cover = np.atleast_2d(cover)
    months = cover.shape[1]
    smd_max = -(20 + 1.3 * clay_pct - 0.01 * clay_pct**2) * depth_cm / 23
    smd_1bar, smd_bare = 0.444 * smd_max, (smd_max if dryland else 0.556 * smd_max)
    balance = np.tile(climate.rain_mm - climate.pet_mm, months // 12)
    acc = np.zeros(cover.shape[0])
    out = np.empty(cover.shape)
    for _ in range(2):
        for m in range(months):
            wetter = np.minimum(0.0, acc + balance[m])
            acc = np.where(cover[:, m], np.maximum(smd_max, wetter), np.maximum(np.minimum(smd_bare, acc), wetter))
            out[:, m] = np.where(acc > smd_1bar, 1.0, 0.2 + 0.8 * (smd_max - acc) / (smd_max - smd_1bar))
    return out


def rate_modifiers(climate: MonthlyClimate, clay_pct: float, depth_cm: float, cover) -> np.ndarray:
    """a x b x c for each scenario and month of its cycle (cover may span several years)."""
    cover = np.atleast_2d(cover)
    a = np.tile(temperature_factor(climate.temp_c), cover.shape[1] // 12)
    b = moisture_factor(climate, clay_pct, depth_cm, cover, dryland=is_dryland(climate))
    return a[None, :] * b * np.where(cover, 0.6, 1.0)


def humified_share(clay_pct: float) -> float:
    """Share of decomposed carbon that becomes BIO + HUM; the rest is respired."""
    x = 1.67 * (1.85 + 1.60 * np.exp(-0.0786 * clay_pct))
    return 1 / (x + 1)


def run(pools, inputs, modifiers, clay_pct: float, years: int) -> np.ndarray:
    """Pools (S, 4) after `years` of repeating the monthly cycle of inputs and rate modifiers (S, cycle months)."""
    pools = np.array(pools, dtype=float)
    humified = humified_share(clay_pct)
    cycle = inputs.shape[1]
    for t in range(years * 12):
        m = t % cycle
        remaining = pools * np.exp(-RATES[None, :] * modifiers[:, m : m + 1] / 12)
        decomposed = (pools - remaining).sum(axis=1)
        pools = remaining
        pools[:, 2] += decomposed * humified * BIO_SHARE
        pools[:, 3] += decomposed * humified * (1 - BIO_SHARE)
        pools[:, 0] += inputs[:, m] * DPM_SHARE
        pools[:, 1] += inputs[:, m] * (1 - DPM_SHARE)
    return pools


def equilibrium(inputs, modifiers, clay_pct: float) -> np.ndarray:
    """Pools (S, 4) at the start of a cycle that the repeating cycle leaves unchanged."""
    inputs, modifiers = np.atleast_2d(inputs), np.atleast_2d(modifiers)
    n, years = inputs.shape[0], inputs.shape[1] // 12
    # One cycle is an affine map x -> M x + v, so the fixed point solves (I - M) x = v.
    columns = [run(np.tile(np.eye(4)[j], (n, 1)), np.zeros_like(inputs), modifiers, clay_pct, years) for j in range(4)]
    m = np.stack(columns, axis=2)
    v = run(np.zeros((n, 4)), inputs, modifiers, clay_pct, years)
    return np.linalg.solve(np.eye(4)[None] - m, v[..., None])[..., 0]


def inert_carbon(soc_t_ha: float) -> float:
    """Inert organic matter, t C/ha (Falloon et al. 1998)."""
    return 0.049 * soc_t_ha**1.139


def crop_carbon(
    crop: CropParams, yield_kg_ha: float, residue: str | None, sowing: date, duration: int, months: int = 12
) -> CropCarbon:
    """Roots and exudates through the season plus the residue returned at harvest.

    `sowing` is a date in the cycle's calendar, which starts on 1 Jan 2001; a season spilling past the cycle's
    end wraps to its start.
    """
    if crop.green_manure:
        shoot, product, share = yield_kg_ha, 0.0, 1.0  # dry biomass, all ploughed in
    else:
        product = yield_kg_ha * crop.dm
        shoot = product / crop.hi
        share = RESIDUE_RETURN.get(residue, UNKNOWN_RESIDUE_RETURN)
    below = BELOW_GROUND_SHARE * shoot * CARBON_PER_DRY_MATTER / 1000
    returned = (shoot - product) * share * CARBON_PER_DRY_MATTER / 1000
    days = [sowing + timedelta(days=d) for d in range(duration)]
    index = np.array([((day.year - 2001) * 12 + day.month - 1) % months for day in days])
    counts = np.bincount(index, minlength=months)
    inputs = below * counts / duration
    inputs[index[-1]] += returned
    return CropCarbon(inputs=inputs, cover=counts >= COVERED_DAYS)


def _combine(plan: list[CropCarbon], months: int) -> tuple[np.ndarray, np.ndarray]:
    inputs, cover = np.zeros(months), np.zeros(months, dtype=bool)
    for item in plan:
        inputs = inputs + np.tile(item.inputs, months // len(item.inputs))
        cover = cover | np.tile(item.cover, months // len(item.cover))
    return inputs, cover


def soc_change(
    soc_t_ha: float,
    clay_pct: float,
    climate: MonthlyClimate,
    baseline: list[CropCarbon],
    scenarios: list[list[CropCarbon]],
    years: int = 10,
    depth_cm: float = 30,
) -> np.ndarray:
    """Change in topsoil organic carbon (t C/ha) after `years` of each scenario.

    Inputs of the baseline practice are scaled so that it holds today's stock; a scenario keeps that scaled
    input and adds the difference between its own modelled inputs and the baseline's.
    """
    base_months = max((len(item.inputs) for item in baseline), default=12)
    base_inputs, base_cover = _combine(baseline, base_months)
    if not scenarios:
        return np.zeros(0)
    months = max(base_months, *(len(item.inputs) for plan in scenarios for item in plan))
    combined = [_combine(plan, months) for plan in scenarios]
    return soc_change_arrays(
        soc_t_ha,
        clay_pct,
        climate,
        base_inputs,
        base_cover,
        np.stack([inputs for inputs, _ in combined]),
        np.stack([cover for _, cover in combined]),
        years,
        depth_cm,
    )


def soc_change_arrays(
    soc_t_ha: float,
    clay_pct: float,
    climate: MonthlyClimate,
    base_inputs: np.ndarray,
    base_cover: np.ndarray,
    inputs: np.ndarray,
    covers: np.ndarray,
    years: int = 10,
    depth_cm: float = 30,
) -> np.ndarray:
    """soc_change for scenarios given as monthly input and cover arrays (S, cycle months)."""
    base_months, months = len(base_inputs), inputs.shape[1]
    pattern = base_inputs if base_inputs.sum() > 0 else np.full(base_months, 1 / base_months)
    unit = equilibrium(pattern, rate_modifiers(climate, clay_pct, depth_cm, base_cover), clay_pct)[0]
    active = max(soc_t_ha - inert_carbon(soc_t_ha), 0.0)
    scale = active / unit.sum() if unit.sum() > 0 else 0.0
    pools0 = unit * scale
    held = np.tile(pattern * scale, months // base_months)
    base = np.tile(base_inputs, months // base_months)
    scenario_inputs = np.maximum(held[None, :] + inputs - base[None, :], 0.0)
    modifiers = rate_modifiers(climate, clay_pct, depth_cm, covers)
    final = run(np.tile(pools0, (len(inputs), 1)), scenario_inputs, modifiers, clay_pct, years)
    return final.sum(axis=1) - pools0.sum()
