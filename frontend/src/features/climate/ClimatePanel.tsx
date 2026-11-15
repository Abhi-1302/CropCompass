import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useClimate } from "../../api/hooks";
import type { ClimateProfile, Probability, Trend } from "../../api/types";
import { AboutData, Alert, Badge, Card, cx, DotScale, PageSpinner, SectionHeader } from "../../components/ui";
import type en from "../../locales/en.json";
import { fullDate, inTenYears, mm, monthDay, ofYears, percent, signed } from "../../lib/format";
import { FarmingYear, RainYears } from "./visuals";

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

/** A headline figure with a short caption, for the key-numbers strip. */
function KeyNumber({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="text-xs font-medium text-stone-500">{title}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight text-stone-900">{value}</dd>
      {detail && <dd className="mt-1 text-xs leading-snug text-stone-500">{detail}</dd>}
    </div>
  );
}

/** One "how often" row: what happens, and in how many of ten years, drawn as ten marks. */
function OddsRow({ title, detail, prob, good = false }: { title: string; detail?: string; prob: Probability; good?: boolean }) {
  const risky = !good && prob.p != null && prob.p >= 0.3;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium text-stone-900">{title}</p>
        {detail && <p className="mt-0.5 text-xs leading-snug text-stone-500">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <DotScale p={prob.p} tone={good ? "good" : risky ? "warn" : "neutral"} />
        <div className="w-36 text-right">
          <p className={cx("text-sm font-semibold", risky ? "text-amber-700" : "text-stone-900")}>{inTenYears(prob)}</p>
          <p className="tabular text-[11px] text-stone-500">{ofYears(prob)}</p>
        </div>
      </div>
    </li>
  );
}

function SeasonOdds({ profile }: { profile: ClimateProfile }) {
  const { t } = useTranslation();
  const rain = profile.annual_rain;
  const monsoon = profile.monsoon;
  const season = profile.growing_season;
  const aridityClass = profile.aridity.class as AridityClass;

  const current = profile.current_season;
  const numbers = [
    ...(current
      ? [
          <KeyNumber
            key="season-rain"
            title={t("climate.rainSince", { date: fullDate(current.start) })}
            value={mm(current.rain_mm)}
            detail={`${t("climate.typical", { value: mm(current.median_mm) })} · ${
              current.rain_percentile < 0.5
                ? t("climate.drierThan", { pct: percent(1 - current.rain_percentile) })
                : t("climate.wetterThan", { pct: percent(current.rain_percentile) })
            }`}
          />,
        ]
      : []),
    <KeyNumber
      key="dependable"
      title={t("climate.dependable")}
      value={t("climate.dependableValue", { value: mm(rain.dependable_mm) })}
      detail={t("climate.dependableDetail", { median: mm(rain.median_mm) })}
    />,
  ];
  const odds: ReactNode[] = [];
  if (monsoon) {
    numbers.push(
      <KeyNumber
        key="onset"
        title={t("climate.onsetThisYear")}
        value={monsoon.onset.this_year?.date ? fullDate(monsoon.onset.this_year.date) : t("climate.onsetNotYet")}
        detail={t("climate.onsetTypical", { date: monthDay(monsoon.onset.median) })}
      />,
      <KeyNumber
        key="season"
        title={t("climate.season")}
        value={t("climate.seasonValue", { days: monsoon.growing_period.median_days ?? "—" })}
        detail={t("climate.typicalLength")}
      />,
    );
    odds.push(
      <OddsRow key="onset" title={t("climate.onsetBy30")} prob={monsoon.onset.p_by_jun_30} good />,
      <OddsRow key="false-start" title={t("climate.falseStart")} detail={t("climate.falseStartDetail")} prob={monsoon.false_start} />,
      <OddsRow
        key="dry-spell"
        title={t("climate.drySpell")}
        detail={t("climate.drySpellDetail", {
          ten: inTenYears(monsoon.dry_spells_jul_sep.ge_10d),
          twentyOne: inTenYears(monsoon.dry_spells_jul_sep.ge_21d),
        })}
        prob={monsoon.dry_spells_jul_sep.ge_14d}
      />,
      <OddsRow
        key="deficient"
        title={t("climate.deficient")}
        detail={t("climate.deficientDetail", { median: mm(monsoon.jjas_rain.median_mm) })}
        prob={monsoon.jjas_rain.p_deficient}
      />,
      <OddsRow key="rabi-heat" title={t("climate.rabiHeat")} detail={t("climate.rabiHeatDetail")} prob={monsoon.rabi_terminal_heat} />,
      <OddsRow key="two-crops" title={t("climate.twoCrops")} prob={monsoon.growing_period.p_ge_180d} good />,
    );
  } else {
    const windows = season.windows.map((w) => `${monthDay(w.start)} – ${monthDay(w.end)}`).join(" · ");
    numbers.push(
      <KeyNumber key="windows" title={t("climate.windows")} value={windows || t("climate.noWindow")} detail={t("climate.windowsDetail")} />,
      <KeyNumber
        key="frost"
        title={t("climate.frostFree")}
        value={profile.frost.has_frost ? t("climate.frostFreeValue", { days: profile.frost.frost_free_days_median ?? "—" }) : t("climate.noFrost")}
      />,
      <KeyNumber
        key="hot"
        title={t("climate.hotDays")}
        value={t("climate.hotDaysValue", { days: profile.heat.days_ge_35_median })}
        detail={t("climate.hotDaysDetail", { forty: profile.heat.days_ge_40_median })}
      />,
    );
    odds.push(
      <OddsRow key="long-season" title={t("climate.longSeason")} prob={season.p_season_ge_90d} good />,
      <OddsRow key="two-seasons" title={t("climate.twoSeasons")} prob={season.p_two_seasons_ge_60d} good />,
    );
  }
  numbers.push(
    <KeyNumber
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
      <dl className={cx("grid grid-cols-2 divide-stone-200 rounded-2xl border border-stone-200 bg-surface lg:divide-x", numbers.length > 4 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
        {numbers}
      </dl>
      <div className="mt-4 rounded-2xl border border-stone-200 bg-surface">
        <p className="border-b border-stone-200 px-5 py-3 text-sm font-semibold text-stone-900">{t("climate.howOften")}</p>
        <ul className="divide-y divide-stone-200">{odds}</ul>
      </div>
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
            <span className="flex items-center gap-3 text-sm text-stone-700">
              <span className={cx("flex size-7 items-center justify-center rounded-lg", trend.significant ? "bg-amber-500/15 text-amber-700" : "bg-stone-100 text-stone-500")}>
                {trend.slope_per_decade > 0 ? <TrendingUp className="size-4" aria-hidden="true" /> : trend.slope_per_decade < 0 ? <TrendingDown className="size-4" aria-hidden="true" /> : <Minus className="size-4" aria-hidden="true" />}
              </span>
              {t(`climate.trendName.${trend.name as TrendName}`)}
            </span>
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

function ClimateView({ profile }: { profile: ClimateProfile }) {
  const { t } = useTranslation();
  const location = profile.location;
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader title={t("climate.yearTitle")} subtitle={t("climate.yearSub")} />
        <Card><FarmingYear profile={profile} /></Card>
      </section>
      <SeasonOdds profile={profile} />
      <section>
        <SectionHeader
          title={t("climate.stripesTitle", { n: profile.annual_rain.by_year.length })}
          subtitle={t("climate.stripesSub", { median: mm(profile.annual_rain.median_mm) })}
        />
        <Card><RainYears profile={profile} /></Card>
      </section>
      <Card>
        <SectionHeader
          title={t("climate.trends")}
          subtitle={t("climate.trendsSub", { first: profile.period.first_year, last: profile.period.last_year })}
        />
        <TrendList trends={profile.trends} />
      </Card>
      <AboutData>
        <p>
          {t("climate.source", {
            cell: location.cell_id,
            elevation: location.elevation_m != null ? Math.round(location.elevation_m) : "—",
            first: profile.period.first_year,
            until: fullDate(profile.period.data_until),
            awc: profile.assumptions.awc_mm,
            awcSource: t(`climate.awcSource.${profile.assumptions.awc_source}`),
          })}
        </p>
        <p>{t("climate.monthlySub")}</p>
        {profile.monsoon && <p>{t("climate.onsetRule")}.</p>}
      </AboutData>
    </div>
  );
}

export function ClimatePanel({ farmId }: { farmId: string }) {
  const climate = useClimate(farmId, true);
  if (climate.isPending) return <PageSpinner />;
  if (climate.isError) return <Alert tone="error">{climate.error.message}</Alert>;
  return <ClimateView profile={climate.data} />;
}
