"""Scoring options by the farmer's priorities: four pillars, weighted total, Pareto set, reasons, confidence."""

from __future__ import annotations

import numpy as np

PILLARS = ("income", "water", "soil", "risk")
DEFAULT_WEIGHTS = {"income": 1.0, "water": 1.0, "soil": 1.0, "risk": 1.0}
STRONG, WEAK = 0.75, 0.25
UNSUITABLE_FAILURE = 0.9  # options failing in 9 of 10 years or more are listed apart, not ranked
SAFE_FAILURE = 0.2  # "strong on risk" also needs 80% dependability, as in dependable-rainfall crop planning


def unsuitable(failure: float) -> bool:
    return failure >= UNSUITABLE_FAILURE


def normalise(values, higher_is_better: bool = True) -> np.ndarray:
    """0-1 across the options; ties are neutral, missing values score 0."""
    values = np.asarray(values, dtype=float)
    finite = np.isfinite(values)
    out = np.zeros(len(values))
    if not finite.any():
        return out
    low, high = values[finite].min(), values[finite].max()
    if high - low < 1e-9:
        out[finite] = 0.5
        return out
    scaled = (values[finite] - low) / (high - low)
    out[finite] = scaled if higher_is_better else 1 - scaled
    return out


def _blend(parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    """Weighted mean of normalised indicators, skipping those on which every option ties (they carry no signal)."""
    varying = [(weight, part) for weight, part in parts if np.ptp(part) > 1e-9]
    if not varying:
        return np.full_like(parts[0][1], 0.5)
    return sum(weight * part for weight, part in varying) / sum(weight for weight, _ in varying)


def pillar_scores(ind: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Pillars from raw indicators (one value per option); docs/PLAN.md section 7.7."""
    n = normalise
    income = _blend([(0.7, n(ind["income_mean"])), (0.3, n(ind["income_p10"]))])
    water = _blend([(1, n(ind["irrigation_mm"], higher_is_better=False)), (1, n(ind["water_productivity"]))])
    soil = _blend([(1, n(ind[key])) for key in ("soc_change", "n_fixed", "cover_months", "diversity")])
    risk = _blend(
        [
            (1, n(ind["failure"], higher_is_better=False)),
            (1, n(ind["income_p10"])),
            (1, n(ind["pest_flags"], higher_is_better=False)),
        ]
    )
    return {"income": income, "water": water, "soil": soil, "risk": risk}


def clean_weights(weights: dict | None) -> dict[str, float]:
    merged = {**DEFAULT_WEIGHTS, **(weights or {})}
    cleaned = {key: max(float(merged[key]), 0.0) for key in PILLARS}
    return cleaned if sum(cleaned.values()) > 0 else dict(DEFAULT_WEIGHTS)


def weighted_score(pillars: dict[str, np.ndarray], weights: dict[str, float]) -> np.ndarray:
    total = sum(weights.values())
    return sum(weights[key] * pillars[key] for key in PILLARS) / total


def pareto_front(pillars: dict[str, np.ndarray]) -> np.ndarray:
    """True for options no other option beats on every pillar."""
    matrix = np.stack([pillars[key] for key in PILLARS], axis=1)
    better_or_equal = (matrix[:, None, :] >= matrix[None, :, :]).all(axis=2)
    strictly_better = (matrix[:, None, :] > matrix[None, :, :]).any(axis=2)
    dominated = (better_or_equal & strictly_better).any(axis=0)
    return ~dominated


def pillar_reasons(pillars: dict[str, np.ndarray], ind: dict[str, np.ndarray], i: int) -> list[dict]:
    """Strong and weak pillars of option `i` relative to the others; a loss or frequent failure is never strong."""
    allowed = {"income": ind["income_mean"][i] > 0, "risk": ind["failure"][i] <= SAFE_FAILURE}
    differs = [key for key in PILLARS if np.ptp(pillars[key]) > 1e-9]
    out = [{"code": "strong", "pillar": key} for key in differs if pillars[key][i] >= STRONG and allowed.get(key, True)]
    out += [{"code": "weak", "pillar": key} for key in differs if pillars[key][i] <= WEAK]
    return out


def confidence(*, pack_validated: bool, awc_source: str, has_carbon: bool, n_years: int, has_history: bool) -> dict:
    """docs/PLAN.md 7.8: High needs a validated pack and no data flags; regions without a pack get no advice."""
    flags = []
    if not pack_validated:
        flags.append("pack_unvalidated")
    if awc_source == "default":
        flags.append("soil_default")
    if not has_carbon:
        flags.append("no_soil_carbon")
    if n_years < 30:
        flags.append("short_record")
    if not has_history:
        flags.append("no_history")
    return {"level": "high" if not flags else "medium", "flags": flags}
