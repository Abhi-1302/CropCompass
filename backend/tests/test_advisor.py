from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from engine.planner import scoring
from engine.planner.advisor import rank, simulate_next_crop, stress_test
from engine.planner.common import JournalEntry
from tests.test_cropfit import farm

TODAY = date(2026, 10, 16)


def test_normalise_and_pareto():
    assert scoring.normalise([1, 3, 2]).tolist() == [0.0, 1.0, 0.5]
    assert scoring.normalise([5, 5]).tolist() == [0.5, 0.5]
    assert scoring.normalise([5]).tolist() == [0.5]
    assert scoring.normalise([1, np.nan, 3], higher_is_better=False).tolist() == [1.0, 0.0, 0.0]
    pillars = {
        "income": np.array([1.0, 0.5, 0.2]),
        "water": np.array([1.0, 0.5, 0.9]),
        "soil": np.array([0.5, 0.4, 0.1]),
        "risk": np.array([0.5, 0.5, 0.2]),
    }
    assert scoring.pareto_front(pillars).tolist() == [True, False, False]
    weights = scoring.clean_weights({"income": 3, "water": -1})
    assert weights == {"income": 3.0, "water": 0.0, "soil": 1.0, "risk": 1.0}
    assert scoring.clean_weights({"income": 0, "water": 0, "soil": 0, "risk": 0}) == scoring.DEFAULT_WEIGHTS


def test_confidence_badge():
    assert scoring.confidence(
        pack_validated=True, awc_source="soilgrids", has_carbon=True, n_years=45, has_history=True
    ) == {"level": "high", "flags": []}
    medium = scoring.confidence(
        pack_validated=False, awc_source="default", has_carbon=True, n_years=45, has_history=False
    )
    assert medium["level"] == "medium" and set(medium["flags"]) == {"pack_unvalidated", "soil_default", "no_history"}


def test_proxy_days_are_not_counted_as_historical_futures():
    from dataclasses import replace

    from engine.planner.common import prepare_weather, year_starts

    inputs = replace(farm(), historical_through=date(2025, 12, 31))
    weather = prepare_weather(
        inputs.frame, inputs.lat, inputs.elevation_m, historical_through=inputs.historical_through
    )
    _, historical = year_starts(weather, date(2026, 2, 1), 240)
    _, replay = year_starts(weather, date(2026, 2, 1), 240, include_scenario=True)
    assert historical[-1] == 2025 and replay[-1] == 2026
    _, cross_year = year_starts(weather, date(2026, 10, 1), 180)
    assert cross_year[-1] == 2024
    run = simulate_next_crop(inputs, "rabi", "protective", TODAY)
    assert run["period"]["last_year"] <= 2024


def test_pillars_ignore_indicators_on_which_all_options_tie():
    values = {
        "income_mean": [1, 2],
        "income_p10": [0, 1],
        "failure": [0.2, 0.4],
        "irrigation_mm": [0, 0],
        "water_productivity": [10, 30],
        "soc_change": [0, 0],
        "n_fixed": [0, 40],
        "cover_months": [4, 4],
        "diversity": [1, 1],
        "pest_flags": [0, 0],
    }
    pillars = scoring.pillar_scores({key: np.array(v, dtype=float) for key, v in values.items()})
    assert pillars["water"].tolist() == [0.0, 1.0]
    assert pillars["soil"].tolist() == [0.0, 1.0]


def _item(crop_id: str, income: float, failure: float) -> dict:
    indicators = {
        "income_mean": income,
        "income_p10": income - 5000,
        "failure": failure,
        "irrigation_mm": 0.0,
        "gross_mean": income + 20000,
        "eta_mm": 300.0,
        "soc_change": 0.0,
        "n_fixed": 0.0,
        "cover_months": 4.0,
        "diversity": 1.0,
        "pest_flags": 0,
    }
    return {"summary": {"id": crop_id, "blocked": False}, "indicators": indicators}


def test_near_certain_failures_are_listed_apart_and_risky_options_are_never_strong_on_risk():
    run = {"kind": "next_crop", "crops": [_item("a", 20000, 0.6), _item("b", 10000, 0.8), _item("c", -50000, 1.0)]}
    out = rank(run, None)
    assert [o["id"] for o in out["options"]] == ["a", "b"]
    assert [s["id"] for s in out["unsuitable"]] == ["c"]
    reasons = {(r["code"], r["pillar"]) for r in out["options"][0]["reasons"]}
    assert ("strong", "income") in reasons
    assert ("strong", "risk") not in reasons  # best of the two, but it still fails 6 years in 10
    assert all(r["pillar"] != "soil" for o in out["options"] for r in o["reasons"])  # all tie on soil


@pytest.fixture(scope="module")
def advice_run():
    soybean = JournalEntry(("soybean",), "kharif", date(2026, 6, 20), date(2026, 9, 28), "harvested", residue="mulched")
    return simulate_next_crop(farm(soybean), "rabi", "protective", TODAY)


def test_next_crop_starts_from_todays_soil(advice_run):
    run = advice_run
    assert run["season"] == "rabi" and run["as_of"] == "2026-10-10"
    assert run["earliest_sowing"] == "2026-10-16"
    assert 0 <= run["soil_now"]["fraction"] <= 1 and 0 <= run["soil_now"]["percentile"] <= 1
    assert run["period"]["n_years"] >= 30
    crops = {item["summary"]["id"]: item["summary"] for item in run["crops"]}
    chickpea = crops["chickpea"]
    assert chickpea["sowing"]["best"] >= "2026-10-16"
    assert len(chickpea["sowing"]["options"]) == 3
    assert {"failure", "p50", "income_mean", "water_met"} <= chickpea["normal"].keys()
    assert chickpea["income"]["p10"] <= chickpea["income"]["p50"] <= chickpea["income"]["p90"]
    assert any(rule["rule"] == "same_family" for rule in chickpea["rules"])


def test_ranking_follows_priorities(advice_run):
    by_income = rank(advice_run, {"income": 1, "water": 0, "soil": 0, "risk": 0})
    by_soil = rank(advice_run, {"income": 0, "water": 0, "soil": 1, "risk": 0})
    assert [o["rank"] for o in by_income["options"]] == list(range(1, len(by_income["options"]) + 1))
    incomes = [o["income"]["mean"] for o in by_income["options"]]
    assert by_income["options"][0]["income"]["mean"] == max(incomes)
    assert by_soil["options"][0]["id"] != by_income["options"][0]["id"] or len(incomes) == 1
    assert any(o["pareto"] for o in by_income["options"])
    assert all(set(o["pillars"]) == set(scoring.PILLARS) for o in by_income["options"])
    assert all(o["yield"]["failure"]["p"] < scoring.UNSUITABLE_FAILURE for o in by_income["options"])
    assert all(s["yield"]["failure"]["p"] >= scoring.UNSUITABLE_FAILURE for s in by_income["unsuitable"])


def test_crop_in_the_field_sets_the_earliest_sowing():
    cotton = JournalEntry(("cotton",), "kharif", date(2026, 6, 15), None, "in_field")
    run = simulate_next_crop(farm(cotton), "rabi", "rainfed", TODAY)
    assert run["in_field"]["expected_harvest"] == "2026-11-27"
    assert run["earliest_sowing"] == "2026-12-07"
    closed = {item["id"] for item in run["excluded"]}
    assert {"chickpea", "mustard"} <= closed
    assert all(item["summary"]["sowing"]["best"] >= "2026-12-07" for item in run["crops"])


def test_stress_test_scenarios():
    result = stress_test(farm(), "rabi", "protective", TODAY, None)
    assert result["scenarios"] == ["baseline", "warm_1_5", "warm_2", "rain_minus_15", "driest"]
    first = result["crops"][0]
    assert first["results"]["baseline"]["rank"] == 1
    baseline, warm = first["results"]["baseline"], first["results"]["warm_2"]
    assert warm is not None and warm["income_mean"] <= baseline["income_mean"] + 1


def test_stress_baseline_matches_the_advice_ranking():
    weights = {"income": 0, "water": 1, "soil": 5, "risk": 1}
    advice = rank(simulate_next_crop(farm(), "rabi", "protective", TODAY), weights)
    stressed = stress_test(farm(), "rabi", "protective", TODAY, weights)
    assert [c["id"] for c in stressed["crops"]] == [o["id"] for o in advice["options"][:5]]
