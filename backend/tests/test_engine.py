from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.climate import indicators as ind
from engine.climate.et0 import hargreaves, penman_monteith, reference_et
from engine.climate.profile import build_profile
from engine.ingest import codec
from engine.ingest.power import PARAMETERS, PowerError, PowerSeries, merge, parse_response, snap_to_cell, validate_year
from engine.ingest.soilgrids import parse_response as parse_soilgrids
from engine.soil.ptf import saxton_rawls, summarize_profile, texture_class
from tests.conftest import synthetic_power

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_penman_monteith_matches_fao56_example_18():
    # Brussels, 6 July: FAO-56 reports ET0 = 3.9 mm/day.
    et0 = penman_monteith(21.5, 12.3, rs=22.07, u2=2.078, ea=1.409, lat_deg=50.8, doy=187, elevation_m=100)
    assert et0 == pytest.approx(3.9, abs=0.05)


def test_hargreaves_is_positive_and_plausible():
    value = hargreaves(35.0, 22.0, 17.0, 120)
    assert 5 < value < 9


def test_reference_et_on_original_2024_sample():
    frame = pd.read_csv(REPO_ROOT / "daily_weather_soil_moisture.csv", parse_dates=["DATE"], index_col="DATE")
    annual = reference_et(frame, 17.0, 600).sum()
    assert annual == pytest.approx(1837, rel=0.02)


@pytest.mark.parametrize(
    ("lat", "lon", "expected"),
    [
        (17.0, 78.125, "17.000_78.125"),
        (17.2, 78.3, "17.000_78.125"),
        (17.3, 78.45, "17.500_78.750"),
        (-1.5, 37.3, "-1.500_37.500"),
        (10.0, 179.9, "10.000_-180.000"),
    ],
)
def test_snap_to_cell(lat, lon, expected):
    assert snap_to_cell(lat, lon).id == expected


def test_snap_to_cell_rejects_out_of_range():
    with pytest.raises(ValueError):
        snap_to_cell(91, 0)


def test_codec_round_trip_keeps_values_and_gaps():
    frame = synthetic_power("2020-01-01", "2020-12-31")
    frame.iloc[5, 0] = np.nan
    back = codec.decode(codec.encode(frame))
    assert back.index.equals(frame.index)
    assert np.isnan(back.iloc[5, 0])
    assert np.nanmax(np.abs(back.to_numpy() - frame.to_numpy())) < 0.006


def test_codec_rejects_foreign_blob():
    with pytest.raises(ValueError):
        codec.decode(b"nope")


def test_parse_power_response_masks_fill_values():
    payload = {
        "header": {"fill_value": -999.0},
        "geometry": {"coordinates": [78.125, 17.0, 556.62]},
        "properties": {"parameter": {"T2M": {"20240101": 21.8, "20240102": -999.0}}},
    }
    series = parse_response(payload)
    assert series.elevation_m == pytest.approx(556.62)
    assert np.isnan(series.data.loc["2024-01-02", "T2M"])


def test_merge_prefers_fresh_values():
    old = pd.DataFrame({"x": [1.0, 2.0]}, index=pd.to_datetime(["2024-01-01", "2024-01-02"]))
    new = pd.DataFrame({"x": [5.0, 6.0]}, index=pd.to_datetime(["2024-01-02", "2024-01-03"]))
    assert merge(old, new)["x"].tolist() == [1.0, 5.0, 6.0]


def validation_sample(year=2024):
    frame = pd.DataFrame(1.0, index=pd.date_range(f"{year}-01-01", f"{year}-12-31"), columns=PARAMETERS)
    frame["PS"] = 100.0
    units = {name: "C" for name in ("T2M", "T2M_MAX", "T2M_MIN", "T2MDEW", "TS")}
    units.update({name: "MJ/m^2/day" for name in ("EVPTRNS", "ALLSKY_SFC_SW_DWN", "CLRSKY_SFC_SW_DWN")})
    units.update(
        {
            "PRECTOTCORR": "mm/day",
            "EVLAND": "mm/day",
            "RH2M": "%",
            "WS2M": "m/s",
            "PS": "kPa",
            "ALLSKY_SFC_PAR_TOT": "MJ/m^2/day",
        }
    )
    units.update({name: "1" for name in ("GWETROOT", "GWETTOP", "GWETPROF")})
    monthly = {name: {f"{year}{month:02}": 1.0 for month in range(1, 13)} for name in ("PRECTOTCORR", "EVLAND")}
    return PowerSeries(frame, 500, units), monthly


@pytest.mark.parametrize("year", [1981, 2023, 2024])
def test_weather_validation_accepts_month_lengths_and_early_solar_gaps(year):
    series, monthly = validation_sample(year)
    if year < 1984:
        series.data = series.data.drop(columns=["ALLSKY_SFC_SW_DWN", "ALLSKY_SFC_PAR_TOT"])
        series.data["CLRSKY_SFC_SW_DWN"] = np.nan
    assert validate_year(series, series.data.index[0].date(), series.data.index[-1].date(), monthly) == []


@pytest.mark.parametrize("column", ["PRECTOTCORR", "EVLAND"])
def test_weather_validation_rejects_24x_values(column):
    series, monthly = validation_sample()
    series.data[column] *= 24
    with pytest.raises(PowerError, match="Daily/monthly disagreement"):
        validate_year(series, series.data.index[0].date(), series.data.index[-1].date(), monthly)


@pytest.mark.parametrize("defect", ["units", "gap", "missing", "temperature"])
def test_weather_validation_rejects_bad_metadata_and_coverage(defect):
    series, monthly = validation_sample()
    start, end = series.data.index[0].date(), series.data.index[-1].date()
    if defect == "units":
        series.units["PRECTOTCORR"] = "mm/hour"
    elif defect == "gap":
        series.data = series.data.drop(series.data.index[20])
    elif defect == "missing":
        series.data.loc["2024-01-02", "PRECTOTCORR"] = np.nan
    else:
        series.data.loc["2024-01-02", "T2M_MIN"] = 50
    with pytest.raises(PowerError):
        validate_year(series, start, end, monthly)


def test_weather_recovers_bad_annual_response_only_from_verified_months(monkeypatch):
    from datetime import date

    from engine.ingest import power

    series, monthly = validation_sample()
    calls = []

    def fetch(cell, start, end, client):
        calls.append((start, end))
        frame = series.data.loc[str(start) : str(end)].copy()
        if start.month != end.month:
            frame["PRECTOTCORR"] *= 24
        return PowerSeries(frame, 500, series.units)

    monkeypatch.setattr(power, "fetch_daily", fetch)
    result = power.fetch_verified_year(power.Cell(17, 78.125), 2024, date(2024, 12, 31), monthly, None)
    assert len(calls) == 13
    assert result.data.PRECTOTCORR.sum() == 366
    assert result.provenance["request_window"] == "month"


def test_power_respects_retry_after(monkeypatch):
    import httpx

    from engine.ingest import power

    pauses = []
    calls = []
    monkeypatch.setattr(power.time, "sleep", pauses.append)

    def handler(request):
        calls.append(request)
        return (
            httpx.Response(429, headers={"Retry-After": "5"})
            if len(calls) == 1
            else httpx.Response(200, json={"ok": True})
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert power._request(power.BASE_URL, {}, client) == {"ok": True}
    assert pauses == [5] and len(calls) == 2


def test_weather_rejects_unverifiable_historical_month():
    from datetime import date

    from engine.ingest import power

    series, monthly = validation_sample()
    monthly["PRECTOTCORR"].pop("202401")
    with pytest.raises(PowerError, match="Monthly verification unavailable"):
        power._verify_series(series, power.Cell(17, 78.125), date(2024, 1, 1), date(2024, 12, 31), monthly, None)


@pytest.mark.parametrize(
    ("sand", "clay", "fc", "wp"),
    [(88, 5, 0.10, 0.05), (40, 20, 0.28, None), (25, 50, 0.42, 0.30)],
)
def test_saxton_rawls_matches_published_texture_values(sand, clay, fc, wp):
    retention = saxton_rawls(sand, clay, 2.5)
    assert retention.field_capacity == pytest.approx(fc, abs=0.015)
    if wp is not None:
        assert retention.wilting_point == pytest.approx(wp, abs=0.015)


@pytest.mark.parametrize(
    ("sand", "silt", "clay", "expected"),
    [
        (43.8, 27.2, 29.0, "clay loam"),
        (90, 5, 5, "sand"),
        (40, 40, 20, "loam"),
        (10, 70, 20, "silt loam"),
        (20, 30, 50, "clay"),
        (60, 25, 15, "sandy loam"),
        (10, 50, 40, "silty clay"),
    ],
)
def test_texture_class(sand, silt, clay, expected):
    assert texture_class(sand, silt, clay) == expected


def test_summarize_profile_on_original_soil_sample():
    sample = pd.read_csv(REPO_ROOT / "soil_properties.csv")
    tops = {"0-5cm": (0, 5), "5-15cm": (5, 15), "15-30cm": (15, 30), "30-60cm": (30, 60)}
    layers = [
        {
            "depth": r.DEPTH,
            "top_cm": tops[r.DEPTH][0],
            "bottom_cm": tops[r.DEPTH][1],
            "bdod": r.bdod,
            "cec": r.cec,
            "clay": r.clay,
            "nitrogen": r.nitrogen,
            "phh2o": r.phh2o,
            "sand": r.sand,
            "silt": r.silt,
            "soc": r.soc,
        }
        for r in sample.itertuples()
    ]
    summary = summarize_profile(layers)
    assert summary["soc_stock_t_ha_0_30cm"] == pytest.approx(47.9, abs=0.1)
    assert summary["topsoil"]["texture"] == "clay loam"
    assert summary["awc_mm"] == pytest.approx(127, abs=3)


def test_parse_soilgrids_response_applies_d_factor():
    payload = {
        "properties": {
            "layers": [
                {
                    "name": "clay",
                    "unit_measure": {"d_factor": 10},
                    "depths": [{"label": "0-5cm", "values": {"mean": 289}}],
                },
                {
                    "name": "soc",
                    "unit_measure": {"d_factor": 10},
                    "depths": [{"label": "0-5cm", "values": {"mean": None}}],
                },
            ]
        }
    }
    layers = parse_soilgrids(payload)
    assert layers == [{"depth": "0-5cm", "top_cm": 0, "bottom_cm": 5, "clay": 28.9, "soc": None}]


def test_runs_and_longest_run():
    mask = np.array([1, 1, 0, 1, 1, 1, 0], dtype=bool)
    assert ind.runs(mask) == [(0, 2), (3, 6)]
    assert ind.longest_run(mask) == 3


def _rain_series(events: dict[str, float]) -> pd.Series:
    rain = pd.Series(0.0, index=pd.date_range("2020-05-01", "2020-11-30"))
    for day, mm in events.items():
        rain[day] = mm
    return rain


def test_scan_detects_false_start_then_reliable_onset():
    events = {"2020-06-05": 25.0}
    events |= {d.strftime("%Y-%m-%d"): 6.0 for d in pd.date_range("2020-06-28", "2020-08-31", freq="2D")}
    events["2020-06-28"] = 22.0
    scan = ind.scan_rain_events(_rain_series(events), pd.Timestamp("2020-06-01"), pd.Timestamp("2020-09-30"))
    assert scan.first_event_failed is True
    assert scan.first_reliable == pd.Timestamp("2020-06-28")


def test_mann_kendall_detects_trend_and_noise():
    rng = np.random.default_rng(1)
    rising = ind.mann_kendall(np.arange(40) * 0.5 + rng.normal(0, 1, 40))
    assert rising["significant"] and rising["slope_per_decade"] == pytest.approx(5, abs=1.5)
    assert not ind.mann_kendall(rng.normal(0, 1, 40))["significant"]


def test_profile_needs_ten_complete_years():
    with pytest.raises(ValueError):
        build_profile(synthetic_power("2020-01-01", "2024-12-31"), 17.0, 500)


def test_profile_on_synthetic_monsoon_series():
    profile = build_profile(synthetic_power("1991-01-01", "2025-12-31"), 17.0, 500, awc_mm=120, region="IN")
    assert profile["period"]["n_years"] == 35
    assert profile["monsoon"]["onset"]["median"] is not None
    assert profile["aridity"]["class"] in {"arid", "semi-arid", "dry sub-humid", "humid"}
    assert {t["name"] for t in profile["trends"]} >= {"annual_rain_mm", "mean_tmin_c", "onset_days_after_jun_1"}
