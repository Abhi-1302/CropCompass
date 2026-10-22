from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.services.vegetation import missing_chunks
from engine.crops.catalog import (
    CatalogError,
    _validate,
    load_catalog,
    load_species,
    season_for_peak,
    season_for_sowing,
)
from engine.ingest.modis import parse_subset
from engine.vegetation.phenology import detect_seasons, smooth
from tests.conftest import modis_composites, synthetic_ndvi


def _series(first_year: int = 2018, last: date = date(2024, 12, 31)) -> pd.Series:
    composites = modis_composites(first_year, last)
    return pd.Series({pd.Timestamp(day): synthetic_ndvi(day) for _, day in composites})


def test_cloud_dips_are_removed_and_seasons_found():
    frame = smooth(_series())
    dip = frame.loc["2021-07-12"]
    assert dip["raw"] == pytest.approx(0.12, abs=0.01) and np.isnan(dip["clean"])
    seasons = detect_seasons(frame["smooth"])
    assert [s.peak.year for s in seasons] == list(range(2018, 2025))
    for season in seasons:
        assert season.peak.month in (9, 10)
        assert 50 <= season.length_days <= 120
        assert season.est_sowing < season.green_up < season.peak < season.senescence < season.est_harvest


def test_season_still_green_at_end_of_record_has_no_harvest():
    series = _series(2022, date(2024, 9, 30))
    last = detect_seasons(smooth(series)["smooth"])[-1]
    assert last.senescence is None and last.est_harvest is None and last.length_days is None


def test_flat_series_has_no_seasons():
    series = pd.Series(0.3, index=pd.date_range("2020-01-01", periods=60, freq="16D"))
    assert detect_seasons(smooth(series)["smooth"]) == []


def test_original_2024_sample_shows_one_kharif_crop():
    sample = pd.read_csv(Path(__file__).resolve().parents[2] / "vegetation_ndvi_evi.csv", parse_dates=["DATE"])
    seasons = detect_seasons(smooth(sample.set_index("DATE")["NDVI"])["smooth"])
    assert len(seasons) == 1
    assert seasons[0].peak == date(2024, 9, 29)
    assert season_for_peak(seasons[0].peak) == ("kharif", 2024)


def test_missing_chunks_are_full_and_newest_first():
    available = [(f"A{i:07d}", date(2000, 1, 1) + pd.Timedelta(days=16 * i)) for i in range(25)]
    have = {day.isoformat() for _, day in available[10:13]}
    chunks = missing_chunks(available, have)
    assert chunks[0] == [code for code, _ in available[15:25]]
    assert chunks[1] == [code for code, _ in available[13:15]]
    assert chunks[2] == [code for code, _ in available[0:10]]
    assert sum(len(c) for c in chunks) == 22


def test_parse_modis_subset_scales_and_masks_fill():
    payload = {
        "scale": "0.0001",
        "subset": [
            {"calendar_date": "2024-01-01", "data": [3542]},
            {"calendar_date": "2024-01-17", "data": [-3000]},
        ],
    }
    assert parse_subset(payload) == {date(2024, 1, 1): 0.3542, date(2024, 1, 17): None}


@pytest.mark.parametrize(
    ("sowing", "expected"),
    [
        (date(2024, 6, 20), ("kharif", 2024)),
        (date(2024, 11, 2), ("rabi", 2024)),
        (date(2025, 1, 10), ("rabi", 2024)),
        (date(2025, 3, 1), ("summer", 2025)),
    ],
)
def test_season_for_sowing(sowing, expected):
    assert season_for_sowing(sowing) == expected


@pytest.mark.parametrize(
    ("peak", "expected"),
    [
        (date(2024, 9, 29), ("kharif", 2024)),
        (date(2024, 11, 20), ("kharif", 2024)),
        (date(2024, 12, 20), ("rabi", 2024)),
        (date(2025, 2, 1), ("rabi", 2024)),
        (date(2025, 4, 25), ("summer", 2025)),
    ],
)
def test_season_for_peak(peak, expected):
    assert season_for_peak(peak) == expected


def test_catalog_validation_rejects_bad_packs():
    catalog, species = load_catalog("IN"), load_species()
    broken = {**catalog, "crops": [*catalog["crops"], {**catalog["crops"][0]}]}
    with pytest.raises(CatalogError):
        _validate(broken, species)
    unknown_family = {**catalog, "crops": [{**catalog["crops"][0], "family": "Rosaceae"}]}
    with pytest.raises(CatalogError):
        _validate(unknown_family, species)
    no_window = {**catalog, "crops": [{**catalog["crops"][0], "seasons": ["kharif", "rabi", "summer"]}]}
    with pytest.raises(CatalogError):
        _validate(no_window, species)
