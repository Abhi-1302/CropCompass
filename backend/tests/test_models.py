from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from engine.crops.catalog import crop_params, load_catalog
from engine.models import nitrogen, rothc
from engine.models.crop_yield import relative_yield, water_factor
from engine.models.water import Irrigation, SoilWater, Sowing, make_slot, simulate

SOIL = SoilWater(awc_mm_per_m=130.0, depth_m=1.0)


def flat_weather(days: int = 320, n: int = 3, rain: float = 0.0, et0: float = 5.0, tmax: float = 30.0):
    return np.full((days, n), rain), np.full((days, n), et0), np.full((days, n), tmax)


def crop_slot(n: int, crop_id: str = "chickpea", start: int = 10, end: int = 40, **overrides):
    crop = crop_params("IN", crop_id)
    duration = overrides.pop("duration", crop.duration)
    values = {
        "window_start": start,
        "window_end": end,
        "sowing": Sowing.ASAP,
        "duration": duration,
        "stage_ends": crop.stage_ends(duration),
        "kc": crop.kc,
        "root_m": crop.root_m,
        "p": crop.p,
        "heat_c": crop.heat_c,
    }
    return make_slot(n, **(values | overrides))


def test_every_pack_crop_has_model_parameters():
    catalog = load_catalog("IN")
    simulated = [crop["id"] for crop in catalog["crops"] if crop_params("IN", crop["id"]) is not None]
    assert simulated == [crop["id"] for crop in catalog["crops"] if crop["group"] != "other"]  # not "other", "fallow"
    chickpea = crop_params("IN", "chickpea")
    assert chickpea.stage_ends() == (16, 38, 81, 105)
    assert chickpea.sowing["rabi"] == ("10-01", "11-15")


def test_water_balance_conserves_mass():
    rng = np.random.default_rng(3)
    days, n = 400, 5
    rain = rng.gamma(0.5, 14.0, (days, n)) * (rng.random((days, n)) < 0.3)
    et0 = rng.uniform(3, 7, (days, n))
    slots = [
        crop_slot(n, "sorghum", start=20, end=60, sowing=Sowing.MOISTURE),
        crop_slot(n, "chickpea", start=150, end=190, irrigation=Irrigation.PROTECTIVE, max_irrigations=2),
    ]
    results, balance = simulate(rain, et0, np.full((days, n), 32.0), slots, SOIL)
    np.testing.assert_allclose(
        balance.initial_mm + balance.rain_mm + balance.irrigation_mm - balance.et_mm - balance.drainage_mm,
        balance.final_mm,
        atol=1e-6,
    )
    assert (results[0].harvest_day > 0).all() and (results[1].sow_day > results[0].harvest_day).all()


def test_full_irrigation_removes_water_stress_and_rainfed_suffers():
    rain, et0, tmax = flat_weather(n=1)
    full, _ = simulate(rain, et0, tmax, [crop_slot(1, irrigation=Irrigation.FULL)], SOIL, initial_fraction=0.2)
    dry, _ = simulate(rain, et0, tmax, [crop_slot(1)], SOIL, initial_fraction=0.2)
    assert full[0].irrigation_mm[0] > 100
    assert full[0].eta_mm[0] == pytest.approx(full[0].etc_mm[0], rel=1e-6)
    assert dry[0].eta_mm[0] < 0.5 * dry[0].etc_mm[0]


def test_protective_irrigation_is_capped():
    rain, et0, tmax = flat_weather(n=1)
    slot = crop_slot(1, irrigation=Irrigation.PROTECTIVE, max_irrigations=2)
    results, _ = simulate(rain, et0, tmax, [slot], SOIL, initial_fraction=0.2)
    assert results[0].irrigations[0] == 2
    assert 0 < results[0].irrigation_mm[0] <= 150


def test_bare_soil_dries_only_its_surface_layer():
    rain, et0, tmax = flat_weather(days=200, n=1)
    idle = crop_slot(1, active=False)
    _, balance = simulate(rain, et0, tmax, [idle], SOIL, initial_fraction=1.0)
    assert balance.et_mm[0] <= SOIL.tew_mm + 1e-9
    assert balance.final_mm[0] == pytest.approx(130.0 - SOIL.tew_mm)


def test_deep_roots_reach_water_stored_by_an_earlier_season():
    rain, et0, tmax = flat_weather(n=2)
    slot = crop_slot(2, "sorghum", root_m=np.array([1.0, 0.3]))
    results, _ = simulate(rain, et0, tmax, [slot], SOIL, initial_fraction=1.0)
    deep, shallow = results[0].eta_mm
    assert deep > shallow + 50


def test_rainfed_sowing_waits_for_a_sowing_rain():
    rain, et0, tmax = flat_weather(n=2)
    rain[30, 0] = 25.0
    slot = crop_slot(2, start=10, end=60, sowing=Sowing.MOISTURE)
    results, _ = simulate(rain, et0, tmax, [slot], SOIL, initial_fraction=0.0)
    assert results[0].sow_day.tolist() == [30, 60]
    assert results[0].dry_sown.tolist() == [False, True]


def test_next_crop_waits_for_the_previous_harvest():
    rain, et0, tmax = flat_weather(days=500, n=1)
    cotton = crop_slot(1, "cotton", start=0, end=0)
    chickpea = crop_slot(1, start=100, end=130)
    results, _ = simulate(rain, et0, tmax, [cotton, chickpea], SOIL, turnaround_days=10)
    assert results[0].harvest_day[0] == 164
    assert results[1].sow_day[0] == 175
    assert results[1].late[0]


def test_heat_at_flowering_cuts_yield():
    crop = crop_params("IN", "chickpea")
    rain, et0, _ = flat_weather(n=1, rain=6.0)
    hot = np.full_like(rain, crop.heat_c + 3)
    results, _ = simulate(rain, et0, hot, [crop_slot(1)], SOIL)
    assert results[0].heat_damage[0] == pytest.approx(0.5)
    share = relative_yield(results[0].eta_mm, results[0].etc_mm, crop.ky, results[0].heat_damage)
    assert share[0] == pytest.approx(0.5, abs=0.01)


def test_yield_response_to_water():
    assert water_factor(50.0, 100.0, 1.25) == pytest.approx(0.375)
    assert water_factor(100.0, 100.0, 1.25) == pytest.approx(1.0)
    assert water_factor(10.0, 100.0, 1.25) == pytest.approx(0.0)


def test_low_ky_crops_get_no_yield_without_water():
    assert water_factor(50.0, 100.0, 0.7) == pytest.approx(0.65)
    assert water_factor(25.0, 100.0, 0.7) == pytest.approx(0.325)
    assert water_factor(0.0, 100.0, 0.7) == pytest.approx(0.0)
    assert water_factor(80.0, 100.0, 0.7) == pytest.approx(0.86)


def test_dry_spell_at_flowering_costs_more_than_the_seasonal_average():
    maize = crop_params("IN", "maize")
    _, dev_end, mid_end, _ = maize.stage_ends()
    rain, et0, tmax = flat_weather(n=1, rain=6.0)
    rain[10 + dev_end - 25 : 10 + (dev_end + mid_end) // 2] = 0.0
    results, _ = simulate(rain, et0, tmax, [crop_slot(1, "maize", start=10, end=10)], SOIL)
    r = results[0]
    seasonal = water_factor(r.eta_mm, r.etc_mm, maize.ky)
    combined = relative_yield(r.eta_mm, r.etc_mm, maize.ky, 0.0, 1.0, r.eta_flowering_mm, r.etc_flowering_mm)
    assert combined[0] < seasonal[0] - 0.15


def test_nitrogen_credits_and_lockup():
    pigeonpea, maize, sorghum = (crop_params("IN", c) for c in ("pigeonpea", "maize", "sorghum"))
    assert nitrogen.legume_credit(pigeonpea, "incorporated") == pytest.approx(35)
    assert nitrogen.legume_credit(pigeonpea, "burned") < nitrogen.legume_credit(pigeonpea, "mulched")
    assert nitrogen.lockup(sorghum, "incorporated", days_to_sowing=10) == nitrogen.LOCKUP_KG
    assert nitrogen.lockup(sorghum, "incorporated", days_to_sowing=60) == 0
    assert nitrogen.lockup(pigeonpea, "removed", days_to_sowing=10) == 0
    assert nitrogen.fertiliser_need(maize, credit=35, extra=0) == pytest.approx(maize.n_rec - 35)


CLIMATE = rothc.MonthlyClimate(
    temp_c=np.array([22, 25, 28, 31, 33, 29, 27, 26, 26, 25, 23, 21], dtype=float),
    rain_mm=np.array([5, 5, 10, 15, 30, 110, 180, 170, 150, 80, 20, 5], dtype=float),
    pet_mm=np.array([110, 125, 165, 185, 200, 150, 115, 110, 105, 110, 100, 95], dtype=float),
)


def test_rothc_reference_values():
    assert rothc.temperature_factor(9.25) == pytest.approx(1.0, abs=0.01)
    assert rothc.temperature_factor(-10) == 0
    assert rothc.inert_carbon(48.0) == pytest.approx(0.049 * 48.0**1.139)
    assert rothc.humified_share(40) > rothc.humified_share(10)


def test_rothc_equilibrium_is_steady():
    inputs = np.full((1, 12), 0.2)
    modifiers = rothc.rate_modifiers(CLIMATE, 30.0, 30, np.ones((1, 12), dtype=bool))
    pools = rothc.equilibrium(inputs, modifiers, 30.0)
    np.testing.assert_allclose(rothc.run(pools, inputs, modifiers, 30.0, 10), pools, rtol=1e-9)


def test_rothc_scenarios_follow_carbon_inputs():
    maize, chickpea = crop_params("IN", "maize"), crop_params("IN", "chickpea")
    baseline = [rothc.crop_carbon(maize, 3500, "removed", date(2001, 6, 20), maize.duration)]
    kept = [rothc.crop_carbon(maize, 3500, "incorporated", date(2001, 6, 20), maize.duration)]
    plus_rabi = [*baseline, rothc.crop_carbon(chickpea, 900, "incorporated", date(2001, 10, 10), chickpea.duration)]
    burned = [rothc.crop_carbon(maize, 3500, "burned", date(2001, 6, 20), maize.duration)]
    same, more, rabi, less = rothc.soc_change(48.0, 30.0, CLIMATE, baseline, [baseline, kept, plus_rabi, burned])
    assert same == pytest.approx(0.0, abs=1e-6)
    assert more > 0.5 and rabi > 0.3
    assert less < 0
    assert kept[0].cover[6:9].all() and not kept[0].cover[0]


def test_rothc_two_year_cycles():
    maize, chickpea = crop_params("IN", "maize"), crop_params("IN", "chickpea")
    yearly = [rothc.crop_carbon(maize, 3500, "removed", date(2001, 6, 20), maize.duration)]
    twice = [
        rothc.crop_carbon(maize, 3500, "removed", date(year, 6, 20), maize.duration, months=24) for year in (2001, 2002)
    ]
    rabi_once = [*twice, rothc.crop_carbon(chickpea, 900, "incorporated", date(2002, 10, 10), chickpea.duration, 24)]
    assert rabi_once[-1].cover[21] and rabi_once[-1].cover[0]  # Oct of year 2 wraps into January of year 1
    same, gain = rothc.soc_change(48.0, 30.0, CLIMATE, yearly, [twice, rabi_once])
    assert same == pytest.approx(0.0, abs=1e-6)
    every_year = [*yearly, rothc.crop_carbon(chickpea, 900, "incorporated", date(2001, 10, 10), chickpea.duration)]
    assert 0 < gain < rothc.soc_change(48.0, 30.0, CLIMATE, yearly, [every_year])[0]
