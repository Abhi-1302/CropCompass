import type { ClimateProfile, CropOutcome, MonthlyRow } from "../../api/types";

/** Every judgement here is a plain reading of model outputs, so the Field view never says more than the engine. */
export type Verdict = "good" | "watch" | "poor" | "blocked";

export function verdictOf(outcome: CropOutcome): Verdict {
  if (outcome.blocked) return "blocked";
  const fail = outcome.yield.failure.p ?? 0;
  const met = outcome.water.met ?? 1;
  if (fail >= 0.4 || met < 0.6) return "poor";
  if (fail >= 0.15 || met < 0.85 || (outcome.heat.risk?.p ?? 0) >= 0.25) return "watch";
  return "good";
}

/** Short of water in a typical season (median share of the crop's water need met). */
export function driesOut(outcome: CropOutcome): boolean {
  return (outcome.water.met ?? 1) < 0.85;
}

export type RootZone = { rootM: number; soilM: number; effectiveM: number; limited: boolean; storeMm: number };

/** Mirrors the water model: the crop draws on min(root depth, soil depth) of soil. */
export function rootZone(rootM: number, soilDepthCm: number, awcMmPerM: number): RootZone {
  const soilM = soilDepthCm / 100;
  const effectiveM = Math.min(rootM, soilM);
  return { rootM, soilM, effectiveM, limited: rootM > soilM, storeMm: awcMmPerM * effectiveM };
}

export type Sky = { month: MonthlyRow; hot: boolean; wet: boolean; windy: boolean; asOf: string };

/** Normals for the month the weather record ends in (the "current" month). */
export function skyOf(profile: ClimateProfile): Sky {
  const asOf = profile.period.data_until;
  const month = profile.monthly[Number(asOf.slice(5, 7)) - 1] ?? profile.monthly[0];
  return {
    month,
    asOf,
    hot: month.tmax_c >= 34 || month.hot_days >= 5,
    wet: month.rain_mm >= 75,
    windy: (month.wind_ms ?? 0) >= 3.5,
  };
}

export const VERDICT_TONE: Record<Verdict, { badge: "green" | "amber" | "red"; plant: string; text: string }> = {
  good: { badge: "green", plant: "text-emerald-600", text: "text-emerald-700" },
  watch: { badge: "amber", plant: "text-amber-600", text: "text-amber-700" },
  poor: { badge: "red", plant: "text-red-500", text: "text-red-700" },
  blocked: { badge: "red", plant: "text-red-500", text: "text-red-700" },
};
