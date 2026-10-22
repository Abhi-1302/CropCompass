"""Assemble the climate risk profile shown on a farm's Climate page."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.climate import indicators as ind
from engine.climate.et0 import reference_et

DEFAULT_AWC_MM = 100.0  # FAO agro-ecological-zone standard store when no soil data is available
MIN_YEARS = 10


def build_profile(
    frame: pd.DataFrame,
    lat: float,
    elevation_m: float | None,
    awc_mm: float | None = None,
    region: str | None = None,
) -> dict:
    awc = float(awc_mm) if awc_mm else DEFAULT_AWC_MM
    rain, tmax, tmin = frame["PRECTOTCORR"], frame["T2M_MAX"], frame["T2M_MIN"]
    years = ind.complete_years(rain)
    if len(years) < MIN_YEARS:
        raise ValueError(f"At least {MIN_YEARS} complete years of daily data are needed")

    et0 = reference_et(frame, lat, elevation_m or 0.0)
    store = pd.Series(ind.soil_water_balance(rain.to_numpy(), et0.to_numpy(), awc), index=frame.index)
    annual = ind.rain_stats(rain, years)
    et0_median = float(et0.groupby(et0.index.year).sum().loc[years].median())
    aridity = annual["median_mm"] / et0_median
    season = ind.growing_season(store, (tmax + tmin) / 2, years)
    monsoon = ind.monsoon_indicators(rain, store, tmax, years) if region == "IN" else None

    yearly = pd.DataFrame({"tmax": tmax, "tmin": tmin}).loc[lambda d: d.index.year.isin(years)]
    by_year = yearly.groupby(yearly.index.year)
    trend_inputs = {
        "annual_rain_mm": [row["mm"] for row in annual["by_year"]],
        "mean_tmax_c": by_year["tmax"].mean().to_numpy(),
        "mean_tmin_c": by_year["tmin"].mean().to_numpy(),
        "hot_days_ge_35": (yearly["tmax"] >= 35).groupby(yearly.index.year).sum().to_numpy(),
    }
    if monsoon:
        trend_inputs["jjas_rain_mm"] = [float(rain.loc[f"{y}-06-01" : f"{y}-09-30"].sum()) for y in years]
        trend_inputs["onset_days_after_jun_1"] = [
            (pd.Timestamp(r["date"]) - pd.Timestamp(r["year"], 6, 1)).days if r["date"] else np.nan
            for r in monsoon["onset"]["by_year"]
        ]
    trends = []
    for name, values in trend_inputs.items():
        result = ind.mann_kendall(values)
        if result:
            trends.append({"name": name, **result})

    if monsoon:
        start_month, start_day = 6, 1
    else:
        start_month, start_day = (int(part) for part in season["agri_year_start"].split("-"))

    return {
        "period": {
            "first_year": years[0],
            "last_year": years[-1],
            "n_years": len(years),
            "data_until": rain.last_valid_index().date().isoformat(),
        },
        "assumptions": {"awc_mm": round(awc), "dry_day_mm": ind.DRY_DAY_MM},
        "monthly": ind.monthly_climatology(rain, et0, tmax, tmin, years),
        "annual_rain": annual,
        "aridity": {"index": round(aridity, 2), "class": ind.aridity_class(aridity), "et0_mm": round(et0_median)},
        "growing_season": season,
        "heat": ind.heat_stats(tmax, years),
        "frost": ind.frost_stats(tmin, years, southern=lat < 0),
        "trends": trends,
        "current_season": ind.current_season(rain, store, years, start_month, start_day),
        "monsoon": monsoon,
    }
