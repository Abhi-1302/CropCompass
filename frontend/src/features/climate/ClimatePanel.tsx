import type { EChartsCoreOption } from "echarts/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useClimate } from "../../api/hooks";
import type { ClimateProfile, CurrentSeason, Probability, Trend } from "../../api/types";
import { AXIS_STYLE, EChart, SPLIT_LINE } from "../../components/EChart";
import { Alert, Badge, Card, cx, PageSpinner, SectionHeader } from "../../components/ui";
import type en from "../../locales/en.json";
import { fullDate, inTenYears, mm, monthDay, monthName, ofYears, percent, signed } from "../../lib/format";
import { SoilNowNote } from "./SoilNowNote";

type TrendName = keyof typeof en.climate.trendName;
type AridityClass = keyof typeof en.climate.aridityClass;
type TrendUnit = keyof typeof en.climate.trendUnit;

const TREND_UNIT: Record<string, TrendUnit> = {
  annual_rain_mm: "mm",
  jjas_rain_mm: "mm",
  mean_tmax_c: "c",
  mean_tmin_c: "c",
  hot_days_ge_35: "days",
  onset_days_after_jun_1: "days",
};
const UNIT_DIGITS: Record<TrendUnit, number> = { mm: 0, c: 2, days: 1 };

type Tone = "neutral" | "warn" | "good";

function OddsCard({ title, value, detail, prob, tone = "neutral" }: {
  title: string;
  value: string;
  detail?: string;
  prob?: Probability;
  tone?: Tone;
}) {
  return (
    <Card className="flex flex-col">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      <p
        className={cx(
          "mt-2 text-xl font-semibold",
          tone === "warn" && "text-amber-700",
          tone === "good" && "text-emerald-700",
          tone === "neutral" && "text-stone-900",
        )}
      >
        {value}
      </p>
      {detail && <p className="mt-1 text-sm leading-snug text-stone-600">{detail}</p>}
      {prob && <p className="mt-auto pt-3 text-xs text-stone-400">{ofYears(prob)}</p>}
    </Card>
  );
}

function riskTone(prob: Probability | null | undefined): Tone {
  return prob?.p != null && prob.p >= 0.3 ? "warn" : "neutral";
}

function PercentileBar({ value }: { value: number }) {
  const { t } = useTranslation();
  const position = Math.min(Math.max(value, 0.02), 0.98) * 100;
  return (
    <div className="mt-4" aria-hidden="true">
      <div className="relative h-2 rounded-full bg-gradient-to-r from-amber-400 via-stone-200 to-sky-500">
        <span
          className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-stone-900 shadow"
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-stone-400">
        <span>{t("climate.driest")}</span>
        <span>{t("climate.wettest")}</span>
      </div>
    </div>
  );
}

function ThisSeason({ profile, current, onOpenHistory }: {
  profile: ClimateProfile;
  current: CurrentSeason;
  onOpenHistory?: () => void;
}) {
  const { t } = useTranslation();
  const compared = (percentile: number) =>
    percentile < 0.5
      ? t("climate.drierThan", { pct: percent(1 - percentile) })
      : t("climate.wetterThan", { pct: percent(percentile) });
  const onset = profile.monsoon?.onset;
  const soil = profile.soil_now;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <SectionHeader title={t("climate.thisSeason")} subtitle={t("climate.thisSeasonSub", { n: current.n_years })} />
        <div className="mb-4">
          <Badge tone="sky">{t("climate.dataUntil", { date: fullDate(current.until) })}</Badge>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm font-medium text-stone-500">{t("climate.rainSince", { date: fullDate(current.start) })}</p>
          <p className="mt-2 text-3xl font-semibold">{mm(current.rain_mm)}</p>
          <p className="mt-1 text-sm text-stone-600">
            {t("climate.typical", { value: mm(current.median_mm) })} · {compared(current.rain_percentile)}
          </p>
          <PercentileBar value={current.rain_percentile} />
        </Card>
        <Card>
          <p className="text-sm font-medium text-stone-500">{t("climate.soilNow")}</p>
          <p className="mt-2 text-3xl font-semibold">
            {t("climate.soilFull", { pct: percent(soil ? soil.fraction : current.store_fraction) })}
          </p>
          <p className="mt-1 text-sm text-stone-600">
            {soil && `${t("soilNow.stored", { mm: mm(soil.mm), capacity: mm(soil.capacity_mm) })} · `}
            {compared(soil ? soil.percentile : current.store_percentile)}
          </p>
          <PercentileBar value={soil ? soil.percentile : current.store_percentile} />
          <div className="mt-3">
            {soil ? (
              <SoilNowNote soil={soil} onOpenHistory={onOpenHistory} />
            ) : (
              <p className="text-xs leading-snug text-stone-400">{t("soilNow.reference")}</p>
            )}
          </div>
        </Card>
        {onset && (
          <Card>
            <p className="text-sm font-medium text-stone-500">{t("climate.onsetThisYear")}</p>
            <p className="mt-2 text-3xl font-semibold">
              {onset.this_year?.date ? fullDate(onset.this_year.date) : t("climate.onsetNotYet")}
            </p>
            <p className="mt-1 text-sm text-stone-600">{t("climate.onsetTypical", { date: monthDay(onset.median) })}</p>
            <p className="mt-4 text-xs leading-snug text-stone-400">{t("climate.onsetRule")}</p>
          </Card>
        )}
      </div>
    </section>
  );
}

function SeasonOdds({ profile }: { profile: ClimateProfile }) {
  const { t } = useTranslation();
  const rain = profile.annual_rain;
  const monsoon = profile.monsoon;
  const season = profile.growing_season;
  const aridityClass = profile.aridity.class as AridityClass;

  const cards = [
    <OddsCard
      key="dependable"
      title={t("climate.dependable")}
      value={t("climate.dependableValue", { value: mm(rain.dependable_mm) })}
      detail={t("climate.dependableDetail", { median: mm(rain.median_mm) })}
      tone="good"
    />,
  ];
  if (monsoon) {
    cards.push(
      <OddsCard
        key="onset"
        title={t("climate.onset")}
        value={monthDay(monsoon.onset.median)}
        detail={t("climate.onsetDetail", { odds: inTenYears(monsoon.onset.p_by_jun_30) })}
        prob={monsoon.onset.p_by_jun_30}
      />,
      <OddsCard
        key="false-start"
        title={t("climate.falseStart")}
        value={inTenYears(monsoon.false_start)}
        detail={t("climate.falseStartDetail")}
        prob={monsoon.false_start}
        tone={riskTone(monsoon.false_start)}
      />,
      <OddsCard
        key="dry-spell"
        title={t("climate.drySpell")}
        value={inTenYears(monsoon.dry_spells_jul_sep.ge_14d)}
        detail={t("climate.drySpellDetail", {
          ten: inTenYears(monsoon.dry_spells_jul_sep.ge_10d),
          twentyOne: inTenYears(monsoon.dry_spells_jul_sep.ge_21d),
        })}
        prob={monsoon.dry_spells_jul_sep.ge_14d}
        tone={riskTone(monsoon.dry_spells_jul_sep.ge_14d)}
      />,
      <OddsCard
        key="season"
        title={t("climate.season")}
        value={t("climate.seasonValue", { days: monsoon.growing_period.median_days ?? "—" })}
        detail={t("climate.seasonDetail", { odds: inTenYears(monsoon.growing_period.p_ge_180d) })}
        prob={monsoon.growing_period.p_ge_180d}
      />,
      <OddsCard
        key="deficient"
        title={t("climate.deficient")}
        value={inTenYears(monsoon.jjas_rain.p_deficient)}
        detail={t("climate.deficientDetail", { median: mm(monsoon.jjas_rain.median_mm) })}
        prob={monsoon.jjas_rain.p_deficient}
        tone={riskTone(monsoon.jjas_rain.p_deficient)}
      />,
      <OddsCard
        key="rabi-heat"
        title={t("climate.rabiHeat")}
        value={inTenYears(monsoon.rabi_terminal_heat)}
        detail={t("climate.rabiHeatDetail")}
        prob={monsoon.rabi_terminal_heat}
        tone={riskTone(monsoon.rabi_terminal_heat)}
      />,
    );
  } else {
    const windows = season.windows.map((w) => `${monthDay(w.start)} – ${monthDay(w.end)}`).join(" · ");
    cards.push(
      <OddsCard key="windows" title={t("climate.windows")} value={windows || t("climate.noWindow")} detail={t("climate.windowsDetail")} />,
      <OddsCard
        key="long-season"
        title={t("climate.longSeason")}
        value={inTenYears(season.p_season_ge_90d)}
        prob={season.p_season_ge_90d}
      />,
      <OddsCard
        key="two-seasons"
        title={t("climate.twoSeasons")}
        value={inTenYears(season.p_two_seasons_ge_60d)}
        prob={season.p_two_seasons_ge_60d}
      />,
      <OddsCard
        key="frost"
        title={t("climate.frostFree")}
        value={
          profile.frost.has_frost
            ? t("climate.frostFreeValue", { days: profile.frost.frost_free_days_median ?? "—" })
            : t("climate.noFrost")
        }
      />,
      <OddsCard
        key="hot"
        title={t("climate.hotDays")}
        value={t("climate.hotDaysValue", { days: profile.heat.days_ge_35_median })}
        detail={t("climate.hotDaysDetail", { forty: profile.heat.days_ge_40_median })}
      />,
    );
  }
  cards.push(
    <OddsCard
      key="aridity"
      title={t("climate.aridity")}
      value={t(`climate.aridityClass.${aridityClass}`)}
      detail={t("climate.aridityDetail", { pct: percent(profile.aridity.index), et0: mm(profile.aridity.et0_mm) })}
    />,
  );

  return (
    <section>
      <SectionHeader
        title={t("climate.know")}
        subtitle={t("climate.knowSub", { first: profile.period.first_year, last: profile.period.last_year })}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{cards}</div>
    </section>
  );
}

function TrendList({ trends }: { trends: Trend[] }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-stone-100">
      {trends.map((trend) => {
        const unit = TREND_UNIT[trend.name] ?? "days";
        return (
          <li key={trend.name} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm text-stone-700">{t(`climate.trendName.${trend.name as TrendName}`)}</span>
            <span className="flex items-center gap-3">
              <span className="text-sm font-medium tabular-nums">
                {signed(trend.slope_per_decade, UNIT_DIGITS[unit])} {t(`climate.trendUnit.${unit}`)}
              </span>
              <Badge tone={trend.significant ? "amber" : "stone"}>
                {t(trend.significant ? "climate.clearTrend" : "climate.noTrend")}
              </Badge>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ClimateView({ profile, onOpenHistory }: { profile: ClimateProfile; onOpenHistory?: () => void }) {
  const { t } = useTranslation();

  const monthlyOption = useMemo<EChartsCoreOption>(
    () => ({
      color: ["#0284c7", "#d97706"],
      tooltip: { trigger: "axis", valueFormatter: (value: unknown) => `${value} mm` },
      legend: { bottom: 0, icon: "roundRect", textStyle: { color: "#44403c" } },
      grid: { left: 48, right: 16, top: 24, bottom: 56 },
      xAxis: { type: "category", data: profile.monthly.map((row) => monthName(row.month)), axisTick: { show: false }, ...AXIS_STYLE },
      yAxis: { type: "value", name: "mm", ...AXIS_STYLE, ...SPLIT_LINE },
      series: [
        {
          name: t("climate.rain"),
          type: "bar",
          data: profile.monthly.map((row) => row.rain_mm),
          barMaxWidth: 28,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
        {
          name: t("climate.et0"),
          type: "line",
          data: profile.monthly.map((row) => row.et0_mm),
          smooth: true,
          symbolSize: 6,
          lineStyle: { width: 3 },
        },
      ],
    }),
    [profile, t],
  );

  const annualOption = useMemo<EChartsCoreOption>(() => {
    const { by_year, dependable_mm, median_mm } = profile.annual_rain;
    return {
      tooltip: { trigger: "axis", valueFormatter: (value: unknown) => `${value} mm` },
      grid: { left: 48, right: 24, top: 24, bottom: 32 },
      xAxis: { type: "category", data: by_year.map((row) => String(row.year)), axisTick: { show: false }, ...AXIS_STYLE },
      yAxis: { type: "value", name: "mm", ...AXIS_STYLE, ...SPLIT_LINE },
      series: [
        {
          name: t("climate.rain"),
          type: "bar",
          data: by_year.map((row) => ({
            value: row.mm,
            itemStyle: { color: row.mm < dependable_mm ? "#f59e0b" : "#38bdf8", borderRadius: [3, 3, 0, 0] },
          })),
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { type: "dashed", color: "#57534e" },
            label: { position: "insideEndTop", formatter: "{b}: {c} mm", color: "#44403c" },
            data: [
              { name: t("climate.median"), yAxis: median_mm },
              { name: t("climate.dependableLine"), yAxis: dependable_mm },
            ],
          },
        },
      ],
    };
  }, [profile, t]);

  const location = profile.location;
  return (
    <div className="space-y-10">
      {profile.current_season && (
        <ThisSeason profile={profile} current={profile.current_season} onOpenHistory={onOpenHistory} />
      )}
      <SeasonOdds profile={profile} />
      <Card>
        <SectionHeader title={t("climate.monthly")} subtitle={t("climate.monthlySub")} />
        <EChart option={monthlyOption} label={t("climate.monthly")} />
      </Card>
      <Card>
        <SectionHeader title={t("climate.annual")} subtitle={t("climate.annualSub")} />
        <EChart option={annualOption} label={t("climate.annual")} />
      </Card>
      <Card>
        <SectionHeader
          title={t("climate.trends")}
          subtitle={t("climate.trendsSub", { first: profile.period.first_year, last: profile.period.last_year })}
        />
        <TrendList trends={profile.trends} />
      </Card>
      <p className="text-xs leading-relaxed text-stone-500">
        {t("climate.source", {
          cell: location.cell_id,
          elevation: location.elevation_m != null ? Math.round(location.elevation_m) : "—",
          first: profile.period.first_year,
          until: fullDate(profile.period.data_until),
          awc: profile.assumptions.awc_mm,
          awcSource: t(`climate.awcSource.${profile.assumptions.awc_source}`),
        })}
      </p>
    </div>
  );
}

export function ClimatePanel({ farmId, onOpenHistory }: { farmId: string; onOpenHistory?: () => void }) {
  const climate = useClimate(farmId, true);
  if (climate.isPending) return <PageSpinner />;
  if (climate.isError) return <Alert tone="error">{climate.error.message}</Alert>;
  return <ClimateView profile={climate.data} onOpenHistory={onOpenHistory} />;
}
