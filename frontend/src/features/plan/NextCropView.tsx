import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useCatalog, useNextCrop, useSavePlan, useStressTest } from "../../api/hooks";
import type { Catalog, CropSeason, Farm, Irrigation, NextCropAdvice, NextCropOption, NextCropStress, Priorities } from "../../api/types";
import { Alert, Badge, Button, Card, cx, Metric, PageSpinner, SectionHeader, Spinner } from "../../components/ui";
import { fullDate, inTenYears, mm, monthDay, money, percent } from "../../lib/format";
import { cropName, familyName, yieldText } from "../crops/text";
import { SoilNowNote } from "../climate/SoilNowNote";
import { ConfidenceNote, PillarBars, PricesCard, ReasonList, StressTable } from "./parts";
import { AskSprout } from "../sprout/Sprout";

const SEASONS: CropSeason[] = ["kharif", "rabi", "summer"];

function OptionCard({ option, advice, catalog, onSave, saving, saved, farmId }: {
  farmId: string;
  option: NextCropOption;
  advice: NextCropAdvice;
  catalog?: Catalog;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const currency = advice.economics.currency;
  const info = catalog?.crops.find((crop) => crop.id === option.id);
  const family = info?.family ? familyName(catalog, info.family) : undefined;
  const others = option.sowing.options.filter((o) => o.date !== option.sowing.best);
  return (
    <Card className={cx(option.rank === 1 && "ring-2 ring-emerald-600/30")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-white">
            {option.rank}
          </span>
          <div>
            <h3 className="text-base font-semibold text-stone-900">{cropName(catalog, option.id)}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {family && <Badge>{family}</Badge>}
              {option.pareto && (
                <span title={t("plan.paretoHelp")}>
                  <Badge tone="green">{t("plan.pareto")}</Badge>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-stone-500">{t("quality.relative")}</p>
          <p className="text-lg font-semibold tabular-nums text-stone-700">{option.comparable_pillars?.length ? Math.round(option.score * 100) : "-"}</p>
        </div>
      </div>
      {(option.income.mean ?? 0) < 0 && <p className="mt-3 text-sm font-semibold text-red-700">{t("quality.loss")}</p>}
      {(option.yield.failure.p ?? 0) >= 0.5 && <p className="mt-2 text-sm font-semibold text-amber-800">{t("quality.highFailure", { percent: percent(option.yield.failure.p) })}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric
          label={t("plan.profit")}
          value={t("plan.perHa", { value: money(option.income.mean, currency) })}
          detail={t("plan.profitDetail", { low: money(option.income.p10, currency), high: money(option.income.p90, currency) })}
          warn={(option.income.mean ?? 0) < 0}
        />
        <Metric
          label={t("plan.failsNow")}
          value={t("quality.failureExact", { ...option.yield.failure, percent: percent(option.yield.failure.p) })}
          detail={t("plan.failsNormal", { odds: inTenYears(option.normal.failure) })}
          warn={(option.yield.failure.p ?? 0) > 0.3}
        />
        <Metric
          label={t("plan.yield")}
          value={yieldText(t, option.yield.p50)}
          detail={t("crops.yieldRange", { low: yieldText(t, option.yield.p10), high: yieldText(t, option.yield.p90) })}
        />
        <Metric
          label={t("plan.sowBy")}
          value={fullDate(option.sowing.best)}
          detail={
            others.length
              ? t("plan.otherDates", {
                  dates: others.map((o) => `${monthDay(o.date.slice(5))} – ${inTenYears(o.failure)}`).join(", "),
                })
              : undefined
          }
        />
      </dl>
      <div className="mt-4"><PillarBars pillars={option.pillars} comparable={option.comparable_pillars} /></div>
      <div className="mt-4">
        <ReasonList reasons={option.reasons} rules={option.rules} catalog={catalog} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <AskSprout farmId={farmId} text={t("sprout.explainOption", { crop: cropName(catalog, option.id) })}
          intent="next_crop" scenario={{ season: advice.season, irrigation: advice.irrigation, weights: advice.weights }}
          selectedOptionIds={[option.id]} displayedWeatherRevision={advice.weather_context.revision} />
        <Button size="sm" variant="secondary" busy={saving} disabled={saved} onClick={onSave}>
          {saved ? t("plan.savedOk") : t("plan.save")}
        </Button>
      </div>
    </Card>
  );
}

export function NextCropView({ farm, irrigation, weights, onOpenHistory }: {
  farm: Farm;
  irrigation: Irrigation;
  weights: Priorities;
  onOpenHistory: () => void;
}) {
  const { t } = useTranslation();
  const [season, setSeason] = useState<CropSeason | undefined>();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const advice = useNextCrop(farm.id, season, irrigation, weights);
  const stress = useStressTest(farm.id);
  const save = useSavePlan(farm.id);
  const catalog = useCatalog().data;
  const data = advice.isError ? undefined : advice.data;
  const activeSeason = season ?? data?.season;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t("crops.season")} className="inline-flex rounded-xl bg-stone-100 p-1">
          {SEASONS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={activeSeason === key}
              onClick={() => {
                setSeason(key);
                stress.reset();
              }}
              className={cx(
                "rounded-lg px-4 py-2 text-sm font-medium transition",
                activeSeason === key ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
              )}
            >
              {t(`history.seasonName.${key}`)}
            </button>
          ))}
        </div>
        {advice.isFetching && (
          <span className="flex items-center gap-2 text-sm text-stone-500">
            <Spinner className="size-4" />
            {t("plan.updating")}
          </span>
        )}
      </div>

      {advice.isPending && <PageSpinner />}
      {advice.isError && (
        <Alert tone={advice.error instanceof ApiError && advice.error.status === 409 ? "info" : "error"}>{advice.error.message}</Alert>
      )}
      {data && <AdviceBody data={data} catalog={catalog} onOpenHistory={onOpenHistory} />}
      {data && data.options.length === 0 && <Alert tone="warning">{t("plan.noOptions")}</Alert>}
      {data && (data.options[0]?.yield.failure.p ?? 0) >= 0.5 && (
        <Alert tone="warning">{t("plan.hardSeason", { odds: inTenYears(data.options[0].yield.failure) })}</Alert>
      )}
      {data && data.options.length > 0 && (
        <div className={cx("space-y-4 transition-opacity", advice.isPlaceholderData && "opacity-60")}>
          {data.options.map((option) => (
            <OptionCard
              key={option.id}
              farmId={farm.id}
              option={option}
              advice={data}
              catalog={catalog}
              onSave={() =>
                save.mutate(
                  {
                    kind: "next_crop",
                    title: t("plan.titleNext", {
                      crop: cropName(catalog, option.id),
                      season: t(`history.seasonName.${data.season}`),
                      year: data.season_year,
                    }),
                    choice: option.id,
                    season: data.season,
                    irrigation,
                    weights,
                  },
                  { onSuccess: () => setSaved((current) => new Set(current).add(option.id)) },
                )
              }
              saving={save.isPending && save.variables?.choice === option.id}
              saved={saved.has(option.id)}
            />
          ))}
          {save.error && <Alert tone="error">{save.error.message}</Alert>}
          <StressCard
            onRun={() => stress.mutate({ kind: "next_crop", season: data.season, irrigation, weights })}
            running={stress.isPending}
            error={stress.error?.message}
            result={stress.data as NextCropStress | undefined}
            currency={data.economics.currency}
            catalog={catalog}
          />
          <PricesCard ids={[...data.options, ...data.unsuitable].map((crop) => crop.id)} catalog={catalog} />
        </div>
      )}
    </div>
  );
}

function AdviceBody({ data, catalog, onOpenHistory }: { data: NextCropAdvice; catalog?: Catalog; onOpenHistory: () => void }) {
  const { t } = useTranslation();
  const soil = data.soil_now;
  const compare =
    soil.percentile < 0.5
      ? t("plan.drierThan", { pct: percent(1 - soil.percentile) })
      : t("plan.wetterThan", { pct: percent(soil.percentile) });
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          title={t("plan.nextTitle", { season: t(`history.seasonName.${data.season}`), year: data.season_year })}
          subtitle={t(data.weather_context.mode === "historical_proxy" ? "quality.scenarioSub" : "plan.nextSub", { n: data.period.n_years, first: data.period.first_year, last: data.period.last_year })}
        />
        <Badge tone="sky">{t(data.weather_context.mode === "historical_proxy" ? "quality.scenarioUntil" : "plan.dataUntil", { date: fullDate(data.as_of) })}</Badge>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Metric
          label={t(data.weather_context.mode === "historical_proxy" ? "quality.scenarioSoil" : "plan.soilNow")}
          value={t("plan.soilNowValue", { mm: mm(soil.mm), pct: percent(soil.fraction) })}
          detail={t("plan.soilNowDetail", { typical: mm(soil.typical_mm), compare })}
          warn={soil.percentile < 0.2}
        />
        <Metric
          label={t("plan.earliest")}
          value={fullDate(data.earliest_sowing)}
          detail={
            data.in_field
              ? t("plan.inField", { crop: cropName(catalog, data.in_field.crop), date: fullDate(data.in_field.expected_harvest) })
              : undefined
          }
        />
      </dl>
      {!data.in_field && (
        <div className="mt-4">
          <SoilNowNote soil={soil} onOpenHistory={onOpenHistory} />
        </div>
      )}
      {data.excluded.length > 0 && (
        <p className="mt-4 text-sm text-stone-600">
          {t("plan.excluded", { crops: data.excluded.map((item) => cropName(catalog, item.id)).join(", ") })}
        </p>
      )}
      {data.unsuitable.length > 0 && (
        <p className="mt-2 text-sm text-stone-600">
          {t("plan.unsuitable", { crops: data.unsuitable.map((item) => cropName(catalog, item.id)).join(", ") })}
        </p>
      )}
      {data.blocked.length > 0 && (
        <p className="mt-2 text-sm text-stone-600">
          <span className="font-medium">{t("plan.blockedTitle")}: </span>
          {data.blocked.map((item) => cropName(catalog, item.id)).join(", ")}
        </p>
      )}
      <div className="mt-4">
        <ConfidenceNote confidence={data.confidence} />
      </div>
    </Card>
  );
}

export function StressCard({ onRun, running, error, result, currency, catalog }: {
  onRun: () => void;
  running: boolean;
  error?: string;
  result?: Parameters<typeof StressTable>[0]["result"];
  currency: string;
  catalog?: Catalog;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <SectionHeader title={t("plan.stressTitle")} subtitle={t("plan.stressSub")} />
      {!result && (
        <Button variant="secondary" busy={running} onClick={onRun}>
          {running ? t("plan.stressRunning") : t("plan.stressRun")}
        </Button>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {result && <StressTable result={result} catalog={catalog} currency={currency} />}
    </Card>
  );
}
