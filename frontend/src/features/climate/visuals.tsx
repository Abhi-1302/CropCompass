import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog } from "../../api/hooks";
import type { ClimateProfile, CropSeason } from "../../api/types";
import { cx } from "../../components/ui";
import { mm, monthDay, monthName, signed } from "../../lib/format";

/** A round step for the rain axis, so gridlines land on 100, 200, 250 … mm. */
function niceStep(max: number): number {
  const steps = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
  return steps.find((step) => step * 2 >= max) ?? Math.ceil(max / 1000) * 500;
}

/**
 * Every year of rain at the field as a bar rising above or falling below the median: wetter years blue,
 * drier years amber, and years short of the rain you can count on (8 in 10 years) red. A 9-year average
 * line shows whether the field has been drifting wetter or drier.
 */
export function RainYears({ profile }: { profile: ClimateProfile }) {
  const { t } = useTranslation();
  const { by_year, median_mm, dependable_mm } = profile.annual_rain;
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover != null ? by_year[hover] : null;
  const count = by_year.length;
  if (!count) return null;

  const deviations = by_year.map((row) => row.mm - median_mm);
  const step = niceStep(Math.max(...deviations.map(Math.abs), median_mm - dependable_mm, 1));
  const span = step * 2; // the axis runs from -span to +span around the median
  const y = (deviation: number) => 50 - (Math.max(-span, Math.min(span, deviation)) / span) * 50; // % from top
  const ticks = [span, step, 0, -step, -span];
  const labels = by_year.filter((row, index) => index === 0 || index === count - 1 || (row.year % 10 === 0 && index > 2 && index < count - 3));

  const window = 4; // ±4 years around each point
  const average = deviations.map((_, index) => {
    if (index < window || index >= count - window) return null;
    const slice = deviations.slice(index - window, index + window + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
  const points = average
    .map((value, index) => (value == null ? null : `${index + 0.5},${y(value)}`))
    .filter(Boolean)
    .join(" ");
  const dependableY = y(dependable_mm - median_mm);

  return (
    <div>
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-sm">
        <p className="text-stone-600">
          {shown ? (
            <>
              <span className="tabular font-semibold text-stone-900">{shown.year}</span> ·{" "}
              <span className="tabular font-medium text-stone-900">{mm(shown.mm)}</span>{" "}
              <span className="text-stone-500">({signed(((shown.mm - median_mm) / median_mm) * 100, 0)}% {t("climate.vsMedian")})</span>
            </>
          ) : (
            t("climate.stripesHint")
          )}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-sky-500" aria-hidden="true" />{t("climate.wetter")}</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-amber-400" aria-hidden="true" />{t("climate.drier")}</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-red-500" aria-hidden="true" />{t("climate.stripesBelow", { mm: mm(dependable_mm) })}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-stone-800" aria-hidden="true" />{t("climate.rollingMean")}</span>
        </p>
      </div>

      <div className="mt-4 flex gap-3">
        {/* axis labels */}
        <div className="relative h-56 w-16 shrink-0 text-right text-[11px] text-stone-500" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className={cx("tabular absolute right-0 -translate-y-1/2", tick === 0 && "font-semibold text-stone-800")} style={{ top: `${y(tick)}%` }}>
              {tick === 0 ? mm(median_mm) : `${tick > 0 ? "+" : "−"}${Math.abs(tick)}`}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="relative h-56"
            role="img"
            aria-label={t("climate.stripesLabel", { first: by_year[0]?.year, last: by_year.at(-1)?.year, median: mm(median_mm) })}
            onMouseLeave={() => setHover(null)}
          >
            {/* gridlines */}
            {ticks.map((tick) => (
              <div
                key={tick}
                className={cx("pointer-events-none absolute inset-x-0 border-t", tick === 0 ? "border-stone-500" : "border-stone-200")}
                style={{ top: `${y(tick)}%` }}
                aria-hidden="true"
              />
            ))}
            {/* dependable rain */}
            <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-red-500/70" style={{ top: `${dependableY}%` }} aria-hidden="true" />

            {/* bars */}
            <div className="absolute inset-0 flex">
              {by_year.map((row, index) => {
                const deviation = deviations[index];
                const top = deviation >= 0 ? y(deviation) : 50;
                const height = Math.max(Math.abs(y(deviation) - 50), 0.6);
                const tone = row.mm < dependable_mm ? "bg-red-500" : deviation >= 0 ? "bg-sky-500" : "bg-amber-400";
                return (
                  <div
                    key={row.year}
                    className={cx("relative h-full flex-1", hover === index && "bg-stone-900/[0.05]")}
                    onMouseEnter={() => setHover(index)}
                    title={`${row.year}: ${mm(row.mm)}`}
                  >
                    <div
                      className={cx(
                        "absolute inset-x-[18%] transition-opacity",
                        deviation >= 0 ? "rounded-t-[3px]" : "rounded-b-[3px]",
                        tone,
                        hover != null && hover !== index && "opacity-45",
                      )}
                      style={{ top: `${top}%`, height: `${height}%` }}
                    />
                  </div>
                );
              })}
            </div>

            {/* 9-year average */}
            {points && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full text-stone-800" viewBox={`0 0 ${count} 100`} preserveAspectRatio="none" aria-hidden="true">
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </div>

          <div className="relative mt-2 h-4 text-[11px] text-stone-500" aria-hidden="true">
            {labels.map((row) => {
              const index = by_year.indexOf(row);
              return (
                <span key={row.year} className="tabular absolute -translate-x-1/2" style={{ left: `${((index + 0.5) / count) * 100}%` }}>{row.year}</span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const SEASON_TONE: Record<CropSeason, string> = {
  kharif: "bg-emerald-500/80 text-white",
  rabi: "bg-amber-500/85 text-stone-950",
  summer: "bg-orange-400/85 text-stone-950",
};

/** Position of a day within the year on a 12-column ribbon, as a percentage. */
function yearPosition(month: number, day: number): number {
  return ((month - 1 + (day - 1) / 30) / 12) * 100;
}

/**
 * The farming year at a glance: which months rain covers crop water demand, when each season is
 * sown, when the monsoon usually arrives, and where today falls.
 */
export function FarmingYear({ profile, today = new Date() }: { profile: ClimateProfile; today?: Date }) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const months = profile.monthly;
  const seasons = catalog?.seasons;
  const onset = profile.monsoon?.onset.median;
  const [onsetMonth, onsetDay] = onset ? onset.split("-").map(Number) : [0, 0];

  const cell = (rain: number, demand: number) => {
    const ratio = demand > 0 ? rain / demand : 1;
    if (ratio >= 1) return "bg-sky-500 text-white";
    if (ratio >= 0.5) return "bg-sky-500/45 text-stone-900";
    if (ratio >= 0.2) return "bg-amber-500/35 text-stone-900";
    return "bg-amber-500/15 text-stone-600";
  };

  return (
    <div>
      <div className="relative">
        <div className="grid grid-cols-12 gap-1">
          {months.map((row) => (
            <div key={row.month} className="text-center">
              <div
                className={cx("flex h-14 flex-col items-center justify-center rounded-lg", cell(row.rain_mm, row.et0_mm))}
                title={`${monthName(row.month)}: ${t("climate.rain")} ${mm(row.rain_mm)} · ${t("climate.et0")} ${mm(row.et0_mm)}`}
              >
                <span className="tabular text-xs font-semibold">{Math.round(row.rain_mm)}</span>
                <span className="text-[10px] opacity-75">mm</span>
              </div>
              <p className="mt-1 text-[11px] font-medium text-stone-500">{monthName(row.month)}</p>
            </div>
          ))}
        </div>
        {/* today */}
        <div className="pointer-events-none absolute -top-1 bottom-5 w-px bg-stone-900/80" style={{ left: `${yearPosition(today.getMonth() + 1, today.getDate())}%` }} aria-hidden="true">
          <span className="absolute -top-5 -translate-x-1/2 whitespace-nowrap rounded bg-stone-900 px-1.5 py-0.5 text-[10px] font-semibold text-stone-50">{t("climate.today")}</span>
        </div>
        {onset && (
          <div className="pointer-events-none absolute top-0 bottom-5 w-0 border-l-2 border-dashed border-sky-700" style={{ left: `${yearPosition(onsetMonth, onsetDay)}%` }} aria-hidden="true" />
        )}
      </div>

      {seasons && (
        <div className="relative mt-3 h-[68px]" aria-label={t("climate.sowingWindows")}>
          {(["kharif", "rabi", "summer"] as CropSeason[]).map((key, row) => {
            const sowing = seasons[key]?.sowing_months ?? [];
            if (!sowing.length) return null;
            const first = Math.min(...sowing);
            const last = Math.max(...sowing);
            const wraps = last - first > 6;
            const spans = wraps
              ? [[Math.min(...sowing.filter((m) => m > 6)), 12], [1, Math.max(...sowing.filter((m) => m <= 6))]]
              : [[first, last]];
            return spans.map(([from, to], index) => (
              <div
                key={`${key}-${index}`}
                className={cx("absolute flex h-5 items-center overflow-hidden rounded-md px-2 text-[11px] font-semibold whitespace-nowrap", SEASON_TONE[key])}
                style={{ left: `${((from - 1) / 12) * 100}%`, width: `calc(${((to - from + 1) / 12) * 100}% - 4px)`, top: row * 22 }}
                title={t("climate.sowWindow", { season: t(`history.seasonName.${key}`) })}
              >
                {t("climate.sowWindow", { season: t(`history.seasonName.${key}`) })}
              </div>
            ));
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-sky-500" />{t("climate.legendSurplus")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-sky-500/45" />{t("climate.legendHalf")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-amber-500/35" />{t("climate.legendDry")}</span>
        {onset && <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0 border-l-2 border-dashed border-sky-700" />{t("climate.legendOnset", { date: monthDay(onset) })}</span>}
      </div>
    </div>
  );
}
