"""Reference evapotranspiration (FAO-56 Penman-Monteith, Hargreaves fallback)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def saturation_vapour_pressure(t_c):
    return 0.6108 * np.exp(17.27 * np.asarray(t_c, dtype=float) / (np.asarray(t_c, dtype=float) + 237.3))


def extraterrestrial_radiation(lat_deg: float, doy) -> np.ndarray:
    """Ra in MJ/m2/day (FAO-56 eq. 21)."""
    phi = np.radians(lat_deg)
    doy = np.asarray(doy, dtype=float)
    dr = 1 + 0.033 * np.cos(2 * np.pi * doy / 365)
    dec = 0.409 * np.sin(2 * np.pi * doy / 365 - 1.39)
    ws = np.arccos(np.clip(-np.tan(phi) * np.tan(dec), -1, 1))
    return 24 * 60 / np.pi * 0.0820 * dr * (ws * np.sin(phi) * np.sin(dec) + np.cos(phi) * np.cos(dec) * np.sin(ws))


def pressure_from_elevation(elevation_m: float) -> float:
    return 101.3 * ((293 - 0.0065 * elevation_m) / 293) ** 5.26


def penman_monteith(tmax, tmin, rs, u2, ea, lat_deg, doy, elevation_m, pressure_kpa=None) -> np.ndarray:
    """Daily ET0 in mm/day (FAO-56 eq. 6). rs in MJ/m2/day, u2 in m/s at 2 m, ea in kPa."""
    tmax, tmin, rs, u2, ea = (np.asarray(x, dtype=float) for x in (tmax, tmin, rs, u2, ea))
    t = (tmax + tmin) / 2
    es = (saturation_vapour_pressure(tmax) + saturation_vapour_pressure(tmin)) / 2
    ra = extraterrestrial_radiation(lat_deg, doy)
    rso = (0.75 + 2e-5 * elevation_m) * ra
    ratio = np.minimum(rs / np.where(rso > 0, rso, np.nan), 1.0)
    rnl = (
        4.903e-9
        * (((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2)
        * (0.34 - 0.14 * np.sqrt(ea))
        * (1.35 * ratio - 0.35)
    )
    rn = 0.77 * rs - rnl
    pressure = pressure_from_elevation(elevation_m) if pressure_kpa is None else np.asarray(pressure_kpa, dtype=float)
    gamma = 0.000665 * pressure
    delta = 4098 * saturation_vapour_pressure(t) / (t + 237.3) ** 2
    return (0.408 * delta * rn + gamma * 900 / (t + 273) * u2 * (es - ea)) / (delta + gamma * (1 + 0.34 * u2))


def hargreaves(tmax, tmin, lat_deg, doy) -> np.ndarray:
    """Temperature-only ET0 in mm/day (FAO-56 eq. 52), used where radiation or humidity is missing."""
    tmax, tmin = np.asarray(tmax, dtype=float), np.asarray(tmin, dtype=float)
    ra = extraterrestrial_radiation(lat_deg, doy)
    return 0.0023 * ((tmax + tmin) / 2 + 17.8) * np.sqrt(np.clip(tmax - tmin, 0, None)) * 0.408 * ra


def reference_et(frame: pd.DataFrame, lat_deg: float, elevation_m: float) -> pd.Series:
    """ET0 for a POWER daily frame; Penman-Monteith where inputs exist, Hargreaves otherwise."""
    doy = frame.index.dayofyear.to_numpy()
    tmax, tmin = frame["T2M_MAX"].to_numpy(), frame["T2M_MIN"].to_numpy()
    pressure = frame["PS"].to_numpy() if "PS" in frame else None
    pm = penman_monteith(
        tmax,
        tmin,
        frame["ALLSKY_SFC_SW_DWN"].to_numpy(),
        frame["WS2M"].to_numpy(),
        saturation_vapour_pressure(frame["T2MDEW"].to_numpy()),
        lat_deg,
        doy,
        elevation_m,
        pressure,
    )
    et0 = np.where(np.isnan(pm), hargreaves(tmax, tmin, lat_deg, doy), pm)
    return pd.Series(np.clip(et0, 0, None), index=frame.index, name="ET0")
