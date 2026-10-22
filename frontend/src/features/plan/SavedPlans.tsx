import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useDeletePlan, usePlans } from "../../api/hooks";
import type { Catalog, Farm, NextCropOption, RotationOption, SavedPlan } from "../../api/types";
import { Alert, Badge, Button, Card, Metric, PageSpinner, SectionHeader } from "../../components/ui";
import { fullDate, inTenYears, mm, money, percent } from "../../lib/format";
import { cropName, yieldText } from "../crops/text";
import { CompareTable } from "./RotationsView";
import { RotationTimeline } from "./parts";
import { WeatherConfidence } from "./WeatherConfidence";

function NextCropSummary({ option, catalog }: { option: NextCropOption; catalog?: Catalog }) {
  const { t } = useTranslation();
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
      <Metric label={t("plan.crop")} value={cropName(catalog, option.id)} />
      <Metric label={t("plan.profit")} value={t("plan.perHa", { value: money(option.income.mean) })} />
      <Metric label={t("plan.failsNow")} value={inTenYears(option.yield.failure)} />
      <Metric label={t("plan.yield")} value={yieldText(t, option.yield.p50)} detail={fullDate(option.sowing.best)} />
    </dl>
  );
}

function RotationSummary({ option, catalog }: { option: RotationOption; catalog?: Catalog }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-3">
      <RotationTimeline option={option} catalog={catalog} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric label={t("plan.profitYear")} value={t("plan.perHa", { value: money(option.income.mean) })} />
        <Metric label={t("plan.irrigation")} value={t("plan.irrigationValue", { mm: mm(option.water.irrigation_mm) })} />
        <Metric label={t("plan.failures")} value={percent(option.risk.failure)} />
      </dl>
    </div>
  );
}

export function SavedPlans({ farm }: { farm: Farm }) {
  const { t } = useTranslation();
  const plans = usePlans(farm.id);
  const remove = useDeletePlan(farm.id);
  const catalog = useCatalog().data;
  const [compare, setCompare] = useState<string[]>([]);

  if (plans.isPending) return <PageSpinner />;
  if (plans.isError) return <Alert tone="error">{plans.error.message}</Alert>;
  if (!plans.data.length) {
    return (
      <Card>
        <p className="py-6 text-center text-sm text-stone-500">{t("plan.savedEmpty")}</p>
      </Card>
    );
  }
  const rotationsToCompare = plans.data
    .filter((plan) => plan.kind === "rotation" && compare.includes(plan.id))
    .map((plan) => plan.option as RotationOption);
  const confirmDelete = (plan: SavedPlan) => {
    if (window.confirm(t("plan.confirmDelete"))) remove.mutate(plan.id);
  };

  return (
    <div className="space-y-4">
      {plans.data.map((plan) => (
        <Card key={plan.id}>
          <WeatherConfidence context={plan.inputs.weather_context} />
          {plan.weather_status !== "current" && plan.weather_status !== "low_confidence" && <Alert tone="warning">{t("quality.savedWarning")}</Alert>}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-stone-900">{plan.title}</h3>
                <Badge tone={plan.kind === "rotation" ? "sky" : "green"}>{t(`plan.kind.${plan.kind}`)}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-500">
                {t("plan.savedOn", { date: fullDate(plan.created_at.slice(0, 10)) })} ·{" "}
                {t("plan.savedInputs", {
                  irrigation: t(`farms.irrigation.${plan.inputs.irrigation}`),
                  ...plan.inputs.weights,
                })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {plan.kind === "rotation" && (
                <label className="flex items-center gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    className="size-4 accent-emerald-700"
                    checked={compare.includes(plan.id)}
                    onChange={(event) =>
                      setCompare((current) =>
                        event.target.checked ? [...current, plan.id].slice(-3) : current.filter((id) => id !== plan.id),
                      )
                    }
                  />
                  {t("plan.compare")}
                </label>
              )}
              <Button
                size="sm"
                variant="ghost"
                busy={remove.isPending && remove.variables === plan.id}
                onClick={() => confirmDelete(plan)}
              >
                {t("plan.delete")}
              </Button>
            </div>
          </div>
          {plan.kind === "rotation" ? (
            <RotationSummary option={plan.option as RotationOption} catalog={catalog} />
          ) : (
            <NextCropSummary option={plan.option as NextCropOption} catalog={catalog} />
          )}
        </Card>
      ))}
      {rotationsToCompare.length > 1 && (
        <Card>
          <SectionHeader title={t("plan.compareTitle")} />
          <CompareTable options={rotationsToCompare} catalog={catalog} currency="INR" />
        </Card>
      )}
    </div>
  );
}
