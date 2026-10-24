from __future__ import annotations

from datetime import date, timedelta

import pytest

from engine.crops.catalog import crop_params
from engine.planner.rules import PastCrop, combine, evaluate

SOWING = date(2026, 10, 15)


def past(crops, days_before: int, length: int = 100, **extra) -> PastCrop:
    end = SOWING - timedelta(days=days_before)
    return PastCrop(crops=tuple(crops), sow_date=end - timedelta(days=length), end_date=end, **extra)


def rules_for(crop_id: str, history: list[PastCrop]) -> dict:
    effects = evaluate(crop_params("IN", crop_id), SOWING, history, "IN")
    return {effect.rule: effect for effect in effects}


def test_same_crop_is_penalised_and_blocked_after_soil_borne_disease():
    assert rules_for("chickpea", [past(["chickpea"], 200)])["same_crop"].factor == pytest.approx(0.85)
    blocked = rules_for("chickpea", [past(["chickpea"], 200, problems=("wilt",))])["same_crop"]
    assert blocked.kind == "block" and blocked.facts["problems"] == ["wilt"]
    assert rules_for("rice", [past(["rice"], 60)])["same_crop"].factor == pytest.approx(0.95)


def test_same_family_penalty_fades_over_the_gap_years():
    fresh = rules_for("chickpea", [past(["soybean"], 20)])["same_family"]
    older = rules_for("chickpea", [past(["soybean"], 500)])["same_family"]
    assert fresh.factor < older.factor < 1
    assert fresh.facts["gap_years"] == 2
    assert "same_family" not in rules_for("chickpea", [past(["soybean"], 800)])


def test_shared_pests_are_flagged_and_stronger_when_reported():
    plain = rules_for("chickpea", [past(["cotton"], 30)])["shared_pest"]
    assert plain.severity == "medium" and plain.facts["crop"] == "cotton"
    seen = evaluate(crop_params("IN", "chickpea"), SOWING, [past(["cotton"], 30, problems=("pod_borer",))], "IN")
    severities = {e.facts["group"]: e.severity for e in seen if e.rule == "shared_pest"}
    assert severities == {"pod_borer": "high", "root_knot_nematode": "medium"}


def test_legume_leaves_nitrogen_for_a_cereal_only():
    credit = rules_for("maize", [past(["pigeonpea"], 40, residue="incorporated")])["legume_credit"]
    assert credit.kind == "benefit" and credit.n_kg == -35
    assert "legume_credit" not in rules_for("chickpea", [past(["pigeonpea"], 40)])


def test_straw_ploughed_in_just_before_sowing_locks_up_nitrogen():
    assert rules_for("wheat", [past(["sorghum"], 10, residue="incorporated")])["n_lockup"].n_kg == 20
    assert "n_lockup" not in rules_for("wheat", [past(["sorghum"], 45, residue="incorporated")])
    assert "n_lockup" not in rules_for("wheat", [past(["sorghum"], 10, residue="removed")])


def test_toxic_residue_hurts_small_seeded_crops_sown_soon_after():
    assert rules_for("mustard", [past(["sorghum"], 10, residue="mulched")])["residue_toxic"].factor == 0.9
    assert "residue_toxic" not in rules_for("mustard", [past(["sorghum"], 30, residue="mulched")])
    assert "residue_toxic" not in rules_for("chickpea", [past(["sorghum"], 10, residue="mulched")])


def test_atrazine_blocks_crops_other_than_maize_and_sorghum():
    history = [past(["maize"], 60, herbicide="Atrazine 50 WP")]
    assert rules_for("chickpea", history)["herbicide"].kind == "block"
    assert "herbicide" not in rules_for("sorghum", history)
    other = rules_for("chickpea", [past(["soybean"], 60, herbicide="Imazethapyr")])["herbicide"]
    assert other.kind == "warning"


def test_old_history_is_ignored_and_effects_combine():
    assert evaluate(crop_params("IN", "chickpea"), SOWING, [past(["chickpea"], 4 * 365)], "IN") == []
    effects = evaluate(crop_params("IN", "mustard"), SOWING, [past(["mustard"], 10, residue="mulched")], "IN")
    factor, blocked = combine(effects)
    assert factor == pytest.approx(0.85) and not blocked
    assert combine(evaluate(crop_params("IN", "lentil"), SOWING, [past(["maize"], 60, herbicide="atrazine")], "IN"))[1]
