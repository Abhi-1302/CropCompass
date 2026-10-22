"""Succession rules: how the field's last three years change the outlook for the next crop (docs/PLAN.md 7.6).

Every rule returns an Effect with its consequence (yield factor, nitrogen change, block or flag) and the facts
behind it, so the interface can explain each one in plain language.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date

from engine.crops.catalog import CropParams, crop_params, load_catalog
from engine.models import nitrogen

HISTORY_DAYS = 3 * 365
RECENT_DAYS = 365
LEGUME_CREDIT_DAYS = 180  # a legume's nitrogen benefits the crop that directly follows it
SOIL_BORNE_PROBLEMS = frozenset({"wilt", "root_rot", "nematodes"})
SAME_CROP_FACTOR = 0.85
SELF_TOLERANT_FACTOR = 0.95
FAMILY_PENALTY = 0.10  # yield loss right after a crop of the same family; shrinks to 0 over its gap years
TOXIC_RESIDUE_DAYS = 21
TOXIC_RESIDUE_FACTOR = 0.9
ATRAZINE_SAFE = frozenset({"maize", "sorghum"})


@dataclass(frozen=True)
class PastCrop:
    crops: tuple[str, ...]
    sow_date: date
    end_date: date  # harvest, or the expected harvest of a crop still in the field
    residue: str | None = None
    problems: tuple[str, ...] = ()
    herbicide: str | None = None


@dataclass(frozen=True)
class Effect:
    rule: str
    kind: str  # block | penalty | risk | benefit | warning
    factor: float = 1.0  # yield multiplier
    n_kg: float = 0.0  # change in fertiliser nitrogen needed, kg N/ha (negative = saved)
    severity: str = "medium"
    facts: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate(candidate: CropParams, sowing: date, history: list[PastCrop], region: str | None) -> list[Effect]:
    catalog = load_catalog(region)
    info = {crop["id"]: crop for crop in catalog["crops"]}
    past = sorted(
        (h for h in history if h.sow_date < sowing and (sowing - h.end_date).days <= HISTORY_DAYS),
        key=lambda h: h.end_date,
        reverse=True,
    )
    if not past:
        return []
    recent = [h for h in past if (sowing - h.end_date).days < RECENT_DAYS]
    effects: list[Effect] = []

    same = [h for h in recent if candidate.id in h.crops]
    if same:
        soil_borne = sorted({p for h in same for p in h.problems} & SOIL_BORNE_PROBLEMS)
        if soil_borne:
            effects.append(
                Effect("same_crop", "block", 0.0, severity="high", facts={"crop": candidate.id, "problems": soil_borne})
            )
        else:
            factor = SELF_TOLERANT_FACTOR if candidate.self_tolerant else SAME_CROP_FACTOR
            effects.append(Effect("same_crop", "penalty", factor, facts={"crop": candidate.id}))

    if candidate.family:
        gap = catalog["families"][candidate.family]["gap_years"]
        for h in past:
            match = next((c for c in h.crops if info.get(c, {}).get("family") == candidate.family), None)
            if match is None or h in same:
                continue
            years = max((sowing - h.end_date).days, 0) / 365.25
            if years < gap:
                factor = round(1 - FAMILY_PENALTY * (1 - years / gap), 3)
                facts = {"crop": match, "family": candidate.family, "years": round(years, 1), "gap_years": gap}
                effects.append(Effect("same_family", "penalty", factor, severity="low", facts=facts))
            break

    reported = {g for h in recent for p in h.problems for g in catalog["problems"].get(p, {}).get("host_groups", [])}
    shared: dict[str, str] = {}
    for h in recent:
        for crop_id in h.crops:
            if crop_id == candidate.id:
                continue
            for group in set(info.get(crop_id, {}).get("host_groups", [])) & set(candidate.host_groups):
                shared.setdefault(group, crop_id)
    for group, crop_id in sorted(shared.items()):
        severity = "high" if group in reported else "medium"
        effects.append(
            Effect(
                "shared_pest",
                "risk",
                severity=severity,
                facts={"group": group, "crop": crop_id, "reported": group in reported},
            )
        )

    last = past[0]
    gap_days = (sowing - last.end_date).days
    if gap_days < RECENT_DAYS:
        for crop_id in last.crops:
            previous = crop_params(region, crop_id)
            if previous is None:
                continue
            if previous.n_credit > 0 and candidate.n_fixed == 0 and gap_days <= LEGUME_CREDIT_DAYS:
                kg = round(nitrogen.legume_credit(previous, last.residue))
                effects.append(
                    Effect("legume_credit", "benefit", n_kg=-kg, severity="low", facts={"crop": crop_id, "kg": kg})
                )
            if extra := nitrogen.lockup(previous, last.residue, gap_days):
                effects.append(
                    Effect("n_lockup", "warning", n_kg=extra, severity="low", facts={"crop": crop_id, "kg": extra})
                )
            toxic = previous.residue_toxic and last.residue in (None, "incorporated", "mulched")
            if toxic and candidate.small_seeded and gap_days < TOXIC_RESIDUE_DAYS:
                facts = {"crop": crop_id, "wait_days": TOXIC_RESIDUE_DAYS}
                effects.append(Effect("residue_toxic", "penalty", TOXIC_RESIDUE_FACTOR, facts=facts))

    sprayed = next((h for h in recent if h.herbicide), None)
    if sprayed is not None:
        if "atrazin" in sprayed.herbicide.lower():
            if candidate.id not in ATRAZINE_SAFE:
                effects.append(
                    Effect("herbicide", "block", 0.0, severity="high", facts={"herbicide": sprayed.herbicide})
                )
        else:
            effects.append(Effect("herbicide", "warning", severity="low", facts={"herbicide": sprayed.herbicide}))
    return effects


def combine(effects: list[Effect]) -> tuple[float, bool]:
    """Overall yield factor from the penalties, and whether any rule blocks the crop."""
    factor = 1.0
    for effect in effects:
        if effect.kind == "penalty":
            factor *= effect.factor
    return factor, any(effect.kind == "block" for effect in effects)
