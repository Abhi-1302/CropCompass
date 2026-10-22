from __future__ import annotations

from datetime import date

import pytest

from engine.crops.catalog import crop_params
from engine.planner.common import JournalEntry
from engine.planner.rotations import Pattern, _calendar, rank_rotations, simulate_rotations, stress_rotations
from tests.test_cropfit import farm

TODAY = date(2026, 10, 16)


@pytest.fixture(scope="module")
def run():
    return simulate_rotations(farm(), "rainfed", TODAY)


def test_patterns_fit_the_calendar(run):
    assert run.year == 2027
    keys = {p.key for p in run.patterns}
    assert "maize+fallow+fallow" in keys  # the pack's default practice is always compared
    assert run.patterns[run.current].key == "maize+fallow+fallow"
    assert all(p.crops[2] is None for p in run.patterns)  # no summer crops without irrigation
    pigeonpea_then_chickpea = Pattern((crop_params("IN", "pigeonpea"), crop_params("IN", "chickpea"), None))
    assert _calendar(pigeonpea_then_chickpea, run.windows, 10) is None
    assert run.sims.share.shape == (len(run.patterns), 3, len(run.sims.years))


def test_rotations_are_ranked_by_priorities(run):
    by_income = rank_rotations(run, {"income": 1, "water": 0, "soil": 0, "risk": 0})
    by_soil = rank_rotations(run, {"income": 0, "water": 0, "soil": 1, "risk": 0})
    options = by_income["options"]
    assert [o["rank"] for o in options] == list(range(1, len(options) + 1))
    assert all(len(o["years"]) == 2 for o in options)
    assert options[0]["pillars"]["income"] == max(o["pillars"]["income"] for o in options)
    assert by_soil["options"][0]["soil"]["soc_change"]["mid"] >= by_income["options"][0]["soil"]["soc_change"]["mid"]
    assert by_income["current"]["key"] == "maize+fallow+fallow>maize+fallow+fallow"
    assert {"income", "irrigation_mm", "soc", "failure"} <= options[0]["vs_current"].keys()
    assert by_income["confidence"]["level"] in ("high", "medium")


def test_repeating_a_crop_is_penalised_in_the_second_year(run):
    ranked = rank_rotations(run, None)
    same = [o for o in ranked["options"] if o["key"].split(">")[0] == o["key"].split(">")[1]]
    for option in same:
        assert any(rule["rule"] == "same_crop" and rule["year"] == 1 for rule in option["rules"])


def test_journal_sets_the_current_practice():
    soybean = JournalEntry(("soybean",), "kharif", date(2026, 6, 20), date(2026, 9, 28), "harvested", residue="mulched")
    chickpea = JournalEntry(("chickpea",), "rabi", date(2025, 10, 10), date(2026, 1, 20), "harvested")
    explored = simulate_rotations(farm(soybean, chickpea), "rainfed", TODAY)
    assert explored.current_source == "journal"
    assert explored.patterns[explored.current].key == "soybean+fallow+fallow"


def test_stress_test_of_chosen_rotations(run):
    keys = [o["key"] for o in rank_rotations(run, None)["options"][:3]]
    result = stress_rotations(run, keys, None)
    assert result["scenarios"] == ["baseline", "warm_1_5", "warm_2", "rain_minus_15", "driest"]
    assert [r["key"] for r in result["rotations"]] == keys
    for rotation in result["rotations"]:
        assert set(rotation["results"]) == set(result["scenarios"])
        assert rotation["results"]["driest"]["income_mean"] <= rotation["results"]["baseline"]["income_mean"] + 1
    with pytest.raises(ValueError):
        stress_rotations(run, ["banana+fallow+fallow>maize+fallow+fallow"], None)
