"""FAO-56 daily soil-water balance for a sequence of crops, run for many realisations at once.

A realisation is one run of the weather (e.g. one historical year) for one cropping plan; arrays carry one
value per realisation, so 27 crops x 45 years cost a single daily loop. The soil is a root zone that deepens
as the crop grows plus the soil below it, so water stored deep by one season is reached by the next crop's
roots (carry-over). Bare soil only dries its top layer (FAO-56 evaporable water), which is how a fallow
saves water. Runoff and capillary rise are not modelled.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

import numpy as np

ROOT_MIN_M = 0.2  # FAO-56 rooting depth at sowing, also the layer a bare soil dries from
KE_MAX = 1.0  # bare-soil evaporation coefficient while the surface is wet
HEAT_RANGE_C = 6.0  # flowering damage grows from 0 at the critical temperature to total 6 degC above it
PROTECTIVE_MAX_MM = 75.0  # one protective irrigation


class Sowing(IntEnum):
    ASAP = 0  # on the window start, or as soon as the field is free
    MOISTURE = 1  # after a sowing rain or on stored moisture; at the latest on the window end


class Irrigation(IntEnum):
    NONE = 0
    PROTECTIVE = 1  # a few irrigations in the development and mid-season stages when the crop is stressed
    FULL = 2  # refill the root zone whenever its readily available water is used up


@dataclass(frozen=True)
class SoilWater:
    awc_mm_per_m: float  # plant-available water per metre of soil
    depth_m: float = 1.0  # rootable depth
    tew_mm: float = 22.0  # total evaporable water of the surface layer (FAO-56 eq. 73)
    rew_mm: float = 9.0  # readily evaporable water (FAO-56 Table 19)


@dataclass(frozen=True)
class Slot:
    """One position in a cropping sequence; every field holds one value per realisation."""

    active: np.ndarray
    window_start: np.ndarray  # first day the crop may be sown (day index of the run)
    window_end: np.ndarray
    sowing: np.ndarray  # Sowing rule
    duration: np.ndarray  # days from sowing to harvest
    stage_ends: np.ndarray  # (R, 4) day from sowing on which each FAO-56 stage ends
    kc: np.ndarray  # (R, 3) Kc ini, mid, end
    root_m: np.ndarray
    p: np.ndarray
    heat_c: np.ndarray  # nan when the crop has no flowering heat threshold
    irrigation: np.ndarray  # Irrigation mode
    max_irrigations: np.ndarray  # cap for protective irrigation


@dataclass(frozen=True)
class SlotResult:
    sow_day: np.ndarray  # -1 when not sown during this run
    harvest_day: np.ndarray  # -1 when not harvested before the run ended
    late: np.ndarray  # sown after the window because the field was still occupied
    dry_sown: np.ndarray  # sown on the last day of the window without a sowing rain or stored moisture
    etc_mm: np.ndarray  # crop water need
    eta_mm: np.ndarray  # crop water use
    etc_flowering_mm: np.ndarray  # ... during flowering (first half of the mid-season stage)
    eta_flowering_mm: np.ndarray
    rain_mm: np.ndarray
    irrigation_mm: np.ndarray
    irrigations: np.ndarray
    water_at_sowing_mm: np.ndarray  # plant-available water in the whole profile
    water_at_harvest_mm: np.ndarray
    heat_damage: np.ndarray  # mean flowering heat damage, 0-1


@dataclass(frozen=True)
class SoilState:
    """Soil water, and any crop still growing, at a moment of a run; one value per realisation."""

    root_zone_mm: np.ndarray
    below_mm: np.ndarray
    root_depth_m: np.ndarray
    surface_depletion_mm: np.ndarray
    crop_slot: np.ndarray  # slot growing in the field, -1 when bare
    crop_age_days: np.ndarray  # days since that crop was sown


@dataclass(frozen=True)
class Balance:
    initial_mm: np.ndarray
    final_mm: np.ndarray
    rain_mm: np.ndarray
    irrigation_mm: np.ndarray
    et_mm: np.ndarray
    drainage_mm: np.ndarray
    end: SoilState


def _moving_sum(values: np.ndarray, window: int) -> np.ndarray:
    total = np.cumsum(values, axis=0)
    out = total.copy()
    out[window:] -= total[:-window]
    return out


def simulate(
    rain: np.ndarray,
    et0: np.ndarray,
    tmax: np.ndarray,
    slots: list[Slot],
    soil: SoilWater,
    turnaround_days: int = 10,
    sowing_rain_mm: float = 20.0,
    sowing_soil_fraction: float = 0.5,
    initial_fraction: float = 0.5,
    start: SoilState | None = None,
    columns: np.ndarray | None = None,
) -> tuple[list[SlotResult], Balance]:
    """Run the daily balance on weather shaped (days, weather columns).

    `columns` maps each realisation to its weather column (default: one realisation per column), so many
    plans can share one year's weather without copying it. `start` resumes from a saved state.
    """
    columns = np.arange(rain.shape[1]) if columns is None else np.asarray(columns)
    days, n = rain.shape[0], len(columns)
    n_slots = len(slots)
    awc, depth = soil.awc_mm_per_m, soil.depth_m
    zmin = min(ROOT_MIN_M, depth)
    capacity = awc * depth
    rain3 = _moving_sum(rain, 3)

    if start is None:
        z = np.full(n, zmin)
        wr = initial_fraction * awc * z  # available water in the root zone
        ws = initial_fraction * awc * (depth - z)  # ... and in the soil below it
        de = np.full(n, (1 - initial_fraction) * soil.tew_mm)  # surface-layer depletion
    else:
        z, wr, ws, de = (
            np.broadcast_to(np.asarray(value, dtype=float), (n,)).copy()
            for value in (start.root_depth_m, start.root_zone_mm, start.below_mm, start.surface_depletion_mm)
        )
    initial = wr + ws

    in_crop = np.zeros(n, dtype=bool)
    current = np.zeros(n, dtype=int)  # slot growing now, or the next one to sow
    ready = np.zeros(n, dtype=int)  # first day the field is free again
    sow_day = np.zeros(n, dtype=int)
    duration = np.ones(n, dtype=int)
    ends = np.ones((n, 4), dtype=int)
    kc = np.zeros((n, 3))
    zmax = np.full(n, zmin)
    p = np.full(n, 0.5)
    heat = np.full(n, np.nan)
    irr_mode = np.zeros(n, dtype=int)
    irr_max = np.zeros(n, dtype=int)
    irr_used = np.zeros(n, dtype=int)

    shape = (n_slots, n)
    out_sow = np.full(shape, -1)
    out_harvest = np.full(shape, -1)
    out_late = np.zeros(shape, dtype=bool)
    out_dry = np.zeros(shape, dtype=bool)
    acc = {
        key: np.zeros(shape)
        for key in ("etc", "eta", "etc_f", "eta_f", "rain", "irr", "irr_n", "heat", "flower", "w_sow", "w_end")
    }
    total_rain, total_irr, total_et, total_drain = (np.zeros(n) for _ in range(4))
    tew, rew = soil.tew_mm, soil.rew_mm

    def plant(i: np.ndarray, k: int, day) -> None:
        slot = slots[k]
        in_crop[i] = True
        current[i] = k
        sow_day[i] = day
        duration[i] = slot.duration[i]
        ends[i] = slot.stage_ends[i]
        kc[i] = slot.kc[i]
        zmax[i] = np.minimum(slot.root_m[i], depth)
        p[i] = slot.p[i]
        heat[i] = slot.heat_c[i]
        irr_mode[i] = slot.irrigation[i]
        irr_max[i] = slot.max_irrigations[i]
        irr_used[i] = 0

    if start is not None:
        growing_slot = np.broadcast_to(np.asarray(start.crop_slot), (n,))
        age = np.broadcast_to(np.asarray(start.crop_age_days), (n,))
        for k in np.unique(growing_slot[growing_slot >= 0]):
            i = np.flatnonzero(growing_slot == k)
            plant(i, int(k), -age[i])

    for t in range(days):
        rain_t, et0_t, tmax_t, rain3_t = (values[t][columns] for values in (rain, et0, tmax, rain3))
        for k, slot in enumerate(slots):
            waiting = ~in_crop & (current == k)
            if not waiting.any():
                continue
            current[waiting & ~slot.active] = k + 1
            waiting &= slot.active
            earliest = np.maximum(slot.window_start, ready)
            due = waiting & (t >= earliest)
            if not due.any():
                continue
            moist = (rain3_t >= sowing_rain_mm) | (wr + ws >= sowing_soil_fraction * capacity)
            last_chance = t >= np.maximum(slot.window_end, earliest)
            sow = due & ((slot.sowing == Sowing.ASAP) | moist | last_chance)
            i = np.flatnonzero(sow)
            if not i.size:
                continue
            plant(i, k, t)
            out_sow[k, i] = t
            out_late[k, i] = t > slot.window_end[i]
            out_dry[k, i] = (slot.sowing[i] == Sowing.MOISTURE) & ~moist[i]
            acc["w_sow"][k, i] = wr[i] + ws[i]

        # Crop coefficient and rooting depth for the day (FAO-56 eq. 66; roots reach full depth with full cover).
        d = t - sow_day
        dev = np.clip((d - ends[:, 0]) / np.maximum(ends[:, 1] - ends[:, 0], 1), 0, 1)
        senescence = np.clip((d - ends[:, 2]) / np.maximum(ends[:, 3] - ends[:, 2], 1), 0, 1)
        kc_day = np.where(
            d < ends[:, 1], kc[:, 0] + dev * (kc[:, 1] - kc[:, 0]), kc[:, 1] + senescence * (kc[:, 2] - kc[:, 1])
        )
        kc_day = np.where(in_crop, kc_day, 0.0)
        target = np.where(in_crop, zmin + (zmax - zmin) * np.clip(d / np.maximum(ends[:, 1], 1), 0, 1), zmin)

        # The root zone follows the roots; water is spread evenly within each zone.
        deeper = target > z
        if deeper.any():
            moved = ws * np.where(deeper, (target - z) / np.maximum(depth - z, 1e-9), 0.0)
            wr += moved
            ws -= moved
        shallower = target < z
        if shallower.any():
            moved = wr * np.where(shallower, (z - target) / z, 0.0)
            wr -= moved
            ws += moved
        z = target
        taw_root = awc * z
        taw_below = awc * (depth - z)

        etc = kc_day * et0_t
        p_day = np.clip(p + 0.04 * (5 - etc), 0.1, 0.8)  # FAO-56 Table 22 note: p varies with ETc
        depletion = taw_root - wr
        stressed = in_crop & (depletion > p_day * taw_root)
        full = stressed & (irr_mode == Irrigation.FULL)
        critical = (d >= ends[:, 0]) & (d < ends[:, 2])
        protective = stressed & (irr_mode == Irrigation.PROTECTIVE) & (irr_used < irr_max) & critical
        irrigated = full | protective
        irr = np.where(full, depletion, 0.0) + np.where(protective, np.minimum(depletion, PROTECTIVE_MAX_MM), 0.0)
        irr_used += irrigated

        water_in = rain_t + irr
        wr += water_in
        excess = np.maximum(wr - taw_root, 0.0)
        wr -= excess
        ws += excess
        drain = np.maximum(ws - taw_below, 0.0)
        ws -= drain
        de = np.maximum(de - water_in, 0.0)

        ks = np.clip(wr / np.maximum((1 - p_day) * taw_root, 1e-9), 0, 1)  # FAO-56 eq. 84
        kr = np.clip((tew - de) / max(tew - rew, 1e-9), 0, 1)  # FAO-56 eq. 74
        loss = np.minimum(np.where(in_crop, ks * etc, kr * KE_MAX * et0_t), wr)
        wr -= loss
        de = np.minimum(de + loss, tew)

        total_rain += rain_t
        total_irr += irr
        total_et += loss
        total_drain += drain

        c = np.flatnonzero(in_crop)
        if c.size:
            k = current[c]
            dc = d[c]
            flowering = (dc >= ends[c, 1]) & (dc < (ends[c, 1] + ends[c, 2] + 1) // 2)
            damage = np.nan_to_num(np.clip((tmax_t[c] - heat[c]) / HEAT_RANGE_C, 0, 1))
            acc["etc"][k, c] += etc[c]
            acc["eta"][k, c] += loss[c]
            acc["etc_f"][k, c] += np.where(flowering, etc[c], 0.0)
            acc["eta_f"][k, c] += np.where(flowering, loss[c], 0.0)
            acc["rain"][k, c] += rain_t[c]
            acc["irr"][k, c] += irr[c]
            acc["irr_n"][k, c] += irrigated[c]
            acc["flower"][k, c] += flowering
            acc["heat"][k, c] += np.where(flowering, damage, 0.0)

            done = c[dc >= duration[c] - 1]
            if done.size:
                k = current[done]
                out_harvest[k, done] = t
                acc["w_end"][k, done] = wr[done] + ws[done]
                in_crop[done] = False
                current[done] += 1
                ready[done] = t + 1 + turnaround_days

    results = [
        SlotResult(
            sow_day=out_sow[k],
            harvest_day=out_harvest[k],
            late=out_late[k],
            dry_sown=out_dry[k],
            etc_mm=acc["etc"][k],
            eta_mm=acc["eta"][k],
            etc_flowering_mm=acc["etc_f"][k],
            eta_flowering_mm=acc["eta_f"][k],
            rain_mm=acc["rain"][k],
            irrigation_mm=acc["irr"][k],
            irrigations=acc["irr_n"][k].astype(int),
            water_at_sowing_mm=acc["w_sow"][k],
            water_at_harvest_mm=acc["w_end"][k],
            heat_damage=np.divide(acc["heat"][k], acc["flower"][k], out=np.zeros(n), where=acc["flower"][k] > 0),
        )
        for k in range(n_slots)
    ]
    end = SoilState(
        root_zone_mm=wr,
        below_mm=ws,
        root_depth_m=z,
        surface_depletion_mm=de,
        crop_slot=np.where(in_crop, current, -1),
        crop_age_days=np.where(in_crop, days - sow_day, 0),
    )
    return results, Balance(initial, wr + ws, total_rain, total_irr, total_et, total_drain, end)


def make_slot(
    n: int,
    *,
    active=True,
    window_start,
    window_end,
    sowing,
    duration,
    stage_ends,
    kc,
    root_m,
    p,
    heat_c,
    irrigation=Irrigation.NONE,
    max_irrigations=0,
) -> Slot:
    """Build a Slot, broadcasting scalars (or one row per field) to every realisation."""

    def column(value, dtype) -> np.ndarray:
        return np.broadcast_to(np.asarray(value, dtype=dtype), (n,)).copy()

    def table(value, width: int, dtype) -> np.ndarray:
        return np.broadcast_to(np.asarray(value, dtype=dtype), (n, width)).copy()

    return Slot(
        active=column(active, bool),
        window_start=column(window_start, int),
        window_end=column(window_end, int),
        sowing=column(sowing, int),
        duration=column(duration, int),
        stage_ends=table(stage_ends, 4, int),
        kc=table(kc, 3, float),
        root_m=column(root_m, float),
        p=column(p, float),
        heat_c=column(np.nan if heat_c is None else heat_c, float),
        irrigation=column(irrigation, int),
        max_irrigations=column(max_irrigations, int),
    )
