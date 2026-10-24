import { useTranslation } from "react-i18next";
import { useCatalog, useNextCrop } from "../../api/hooks";
import type { Farm } from "../../api/types";
import { Button, Card, SectionHeader, Spinner } from "../../components/ui";
import { fullDate, money, percent } from "../../lib/format";
import { cropName } from "../crops/text";
import { DEFAULT_PRIORITIES } from "./parts";

/** The farm's home card: the three best next crops for the saved priorities (the Plan tab's first query). */
export function NextCropSummary({ farm, onOpenPlan }: { farm: Farm; onOpenPlan: () => void }) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const advice = useNextCrop(farm.id, undefined, farm.irrigation, farm.priorities ?? DEFAULT_PRIORITIES);

  if (advice.isPending) {
    return (
      <Card className="flex items-center gap-3 text-sm text-stone-500">
        <Spinner className="size-4" />
        {t("farm.summaryLoading")}
      </Card>
    );
  }
  if (advice.isError) return null;

  const data = advice.data;
  const top = data.options.slice(0, 3);
  const soil = data.soil_now;
  const compare =
    soil.percentile < 0.5
      ? t("plan.drierThan", { pct: percent(1 - soil.percentile) })
      : t("plan.wetterThan", { pct: percent(soil.percentile) });
  const hard = (top[0]?.yield.failure.p ?? 0) >= 0.5;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          title={t("farm.summaryTitle", { season: t(`history.seasonName.${data.season}`), year: data.season_year })}
          subtitle={t("farm.summarySub")}
        />
        <Button size="sm" variant="secondary" onClick={onOpenPlan}>
          {t("farm.summaryOpen")}
        </Button>
      </div>
      {top.length === 0 ? (
        <p className="text-sm text-amber-800">{t("plan.noOptions")}</p>
      ) : (
        <ol className="grid gap-3 sm:grid-cols-3">
          {top.map((option) => (
            <li key={option.id} className="rounded-xl border border-stone-200 p-3">
              <p className="flex items-center gap-2 font-semibold text-stone-900">
                <span className="flex size-6 items-center justify-center rounded-full bg-stone-900 text-xs text-white">
                  {option.rank}
                </span>
                {cropName(catalog, option.id)}
              </p>
              <p className="mt-2 text-sm text-stone-700">
                {t("farm.summaryProfit", { value: money(option.income.mean, data.economics.currency) })}
              </p>
              <p className="text-sm text-stone-700">{t("farm.summaryFails", { odds: t("quality.failureExact", { ...option.yield.failure, percent: percent(option.yield.failure.p) }) })}</p>
              {(option.income.mean ?? 0) < 0 && <p className="text-xs font-semibold text-red-700">{t("quality.loss")}</p>}
              <p className="text-xs text-stone-500">{t("farm.summarySow", { date: fullDate(option.sowing.best) })}</p>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-stone-500">
        {hard && <span className="font-medium text-amber-800">{t("farm.summaryHard")} </span>}
        {t("farm.summarySoil", { pct: percent(soil.fraction), compare })}
      </p>
    </Card>
  );
}
