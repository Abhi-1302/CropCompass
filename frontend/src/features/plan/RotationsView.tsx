import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useCatalog, useRotations, useSavePlan, useStressTest } from "../../api/hooks";
import type { Catalog, Farm, Irrigation, Priorities, ResidueChoice, RotationAdvice, RotationOption, RotationStress } from "../../api/types";
import { Alert, Badge, Button, Card, cx, Metric, PageSpinner, SectionHeader, Spinner } from "../../components/ui";
import { mm, money, percent, signed } from "../../lib/format";
import type { T } from "../crops/text";
import { StressCard } from "./NextCropView";
import { ConfidenceNote, PillarBars, PricesCard, ReasonList, rotationLabel, RotationTimeline } from "./parts";
import { AskSprout } from "../sprout/Sprout";

const MAX_COMPARE = 3;

function carbonText(t: T, option: RotationOption): string {
  const soc = option.soil.soc_change;
  return soc ? t("plan.carbonValue", { value: signed(soc.mid) }) : "—";
}

function RotationCard({ option, catalog, currency, selected, onSelect, onSave, saving, saved }: {
  option: RotationOption;
  catalog?: Catalog;
  currency: string;
  selected: boolean;
  onSelect: (value: boolean) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const diff = option.vs_current;
  return (
    <Card className={cx(option.rank === 1 && "ring-2 ring-emerald-600/30")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-white">
            {option.rank}
          </span>
          <div>
            <h3 className="text-base font-semibold text-stone-900">{rotationLabel(option.key, catalog, t)}</h3>
            {option.pareto && (
              <span className="mt-1 inline-block" title={t("plan.paretoHelp")}>
                <Badge tone="green">{t("plan.pareto")}</Badge>
              </span>
            )}
          </div>
        </div>
        {option.score != null && (
          <div className="text-right">
            <p className="text-xs font-medium text-stone-500">{t("quality.relative")}</p>
            <p className="text-lg font-semibold tabular-nums text-stone-700">{option.comparable_pillars?.length ? Math.round(option.score * 100) : "-"}</p>
          </div>
        )}
      </div>
      <div className="mt-4">
        <RotationTimeline option={option} catalog={catalog} />
      </div>
      {option.income.mean < 0 && <p className="mt-3 text-sm font-semibold text-red-700">{t("quality.loss")}</p>}
      {option.risk.failure >= 0.5 && <p className="mt-2 text-sm font-semibold text-amber-800">{t("quality.highFailure", { percent: percent(option.risk.failure) })}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric
          label={t("plan.profitYear")}
          value={t("plan.perHa", { value: money(option.income.mean, currency) })}
          detail={t("plan.profitDetail", { low: money(option.income.p10, currency), high: money(option.income.p90, currency) })}
          warn={option.income.mean < 0}
        />
        <Metric label={t("plan.irrigation")} value={t("plan.irrigationValue", { mm: mm(option.water.irrigation_mm) })} />
        <Metric label={t("plan.carbonTen")} value={carbonText(t, option)} />
        <Metric label={t("plan.failures")} value={percent(option.risk.failure)} warn={option.risk.failure > 0.3} />
      </dl>
      {option.pillars && <div className="mt-4"><PillarBars pillars={option.pillars} comparable={option.comparable_pillars} /></div>}
      {diff && (
        <p className="mt-3 text-sm text-stone-600">
          {t("plan.vsCurrent", {
            income: money(diff.income, currency, true),
            carbon: diff.soc == null ? "—" : signed(diff.soc),
          })}
        </p>
      )}
      <div className="mt-4">
        <ReasonList reasons={option.reasons ?? []} rules={option.rules} catalog={catalog} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button size="sm" variant="secondary" busy={saving} disabled={saved} onClick={onSave}>
          {saved ? t("plan.savedOk") : t("plan.save")}
        </Button>
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            className="size-4 accent-emerald-700"
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
          {t("plan.compare")}
        </label>
      </div>
    </Card>
  );
}

export function CompareTable({ options, catalog, currency }: { options: RotationOption[]; catalog?: Catalog; currency: string }) {
  const { t } = useTranslation();
  const rows: [string, (option: RotationOption) => string][] = [
    [t("plan.profitYear"), (o) => money(o.income.mean, currency)],
    [t("plan.badYear"), (o) => money(o.income.p10, currency)],
    [t("plan.irrigation"), (o) => t("plan.irrigationValue", { mm: mm(o.water.irrigation_mm) })],
    [t("plan.carbonTen"), (o) => carbonText(t, o)],
    [t("plan.nFixed"), (o) => t("plan.nFixedValue", { kg: o.soil.n_fixed })],
    [t("plan.families"), (o) => String(o.soil.families)],
    [t("plan.failures"), (o) => percent(o.risk.failure)],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead>
          <tr className="border-b border-stone-200">
            <th className="py-2 pr-3 text-xs font-medium text-stone-500">{t("plan.measure")}</th>
            {options.map((option) => (
              <th key={option.key} className="py-2 pr-3 align-bottom text-xs font-semibold text-stone-800">
                {rotationLabel(option.key, catalog, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row" className="py-2 pr-3 font-medium text-stone-600">
                {label}
              </th>
              {options.map((option) => (
                <td key={option.key} className="py-2 pr-3 tabular-nums">
                  {value(option)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Header({ data }: { data: RotationAdvice }) {
  const { t } = useTranslation();
  return (
    <SectionHeader
      title={t("plan.rotationsTitle", { year: data.first_year })}
      subtitle={t("plan.rotationsSub", {
        rotations: data.considered.rotations,
        patterns: data.considered.patterns,
        n: data.period.n_pairs,
      })}
    />
  );
}

export function RotationsView({ farm, irrigation, weights }: { farm: Farm; irrigation: Irrigation; weights: Priorities }) {
  const { t } = useTranslation();
  const [residue, setResidue] = useState<ResidueChoice>("incorporated");
  const [selected, setSelected] = useState<string[]>([]);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const rotations = useRotations(farm.id, irrigation, weights, residue);
  const stress = useStressTest(farm.id);
  const save = useSavePlan(farm.id);
  const catalog = useCatalog().data;
  const data = rotations.isError ? undefined : rotations.data;
  const currency = data?.economics.currency ?? "INR";
  const chosen = data ? data.options.filter((option) => selected.includes(option.key)) : [];

  const toggle = (key: string, value: boolean) =>
    setSelected((current) =>
      value ? [...current.filter((k) => k !== key), key].slice(-MAX_COMPARE) : current.filter((k) => k !== key),
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {data && <AskSprout farmId={farm.id} text={t("sprout.rotationQuestion")} intent="rotations"
          scenario={{ irrigation, weights, residue }} selectedOptionIds={selected}
          displayedWeatherRevision={data.weather_context.revision} />}
        <span className="text-sm font-medium text-stone-800">{t("plan.residue")}</span>
        <div role="radiogroup" aria-label={t("plan.residue")} className="inline-flex rounded-xl bg-stone-100 p-1">
          {(["incorporated", "removed"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={residue === key}
              onClick={() => {
                setResidue(key);
                stress.reset();
              }}
              className={cx(
                "rounded-lg px-4 py-2 text-sm font-medium transition",
                residue === key ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
              )}
            >
              {t(key === "incorporated" ? "plan.residueKept" : "plan.residueRemoved")}
            </button>
          ))}
        </div>
        {rotations.isFetching && (
          <span className="flex items-center gap-2 text-sm text-stone-500">
            <Spinner className="size-4" />
            {t("plan.updating")}
          </span>
        )}
      </div>

      {rotations.isPending && <PageSpinner />}
      {rotations.isError && (
        <Alert tone={rotations.error instanceof ApiError && rotations.error.status === 409 ? "info" : "error"}>
          {rotations.error.message}
        </Alert>
      )}
      {data && (
        <div className={cx("space-y-4 transition-opacity", rotations.isPlaceholderData && "opacity-60")}>
          <Card>
            <Header data={data} />
            {data.current && (
              <div className="rounded-xl bg-stone-50 p-4">
                <p className="text-sm font-semibold text-stone-900">{t("plan.currentTitle")}</p>
                <p className="mb-3 text-xs text-stone-500">
                  {t(data.current_source === "journal" ? "plan.currentJournal" : "plan.currentDefault")}
                </p>
                <RotationTimeline option={data.current} catalog={catalog} />
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
                  <Metric
                    label={t("plan.profitYear")}
                    value={t("plan.perHa", { value: money(data.current.income.mean, currency) })}
                  />
                  <Metric
                    label={t("plan.irrigation")}
                    value={t("plan.irrigationValue", { mm: mm(data.current.water.irrigation_mm) })}
                  />
                  <Metric label={t("plan.carbonTen")} value={carbonText(t, data.current)} />
                  <Metric label={t("plan.failures")} value={percent(data.current.risk.failure)} />
                </dl>
              </div>
            )}
            <div className="mt-4">
              <ConfidenceNote confidence={data.confidence} />
            </div>
          </Card>

          {data.options.map((option) => (
            <RotationCard
              key={option.key}
              option={option}
              catalog={catalog}
              currency={currency}
              selected={selected.includes(option.key)}
              onSelect={(value) => toggle(option.key, value)}
              onSave={() =>
                save.mutate(
                  {
                    kind: "rotation",
                    title: t("plan.titleRotation", { year: data.first_year }),
                    choice: option.key,
                    irrigation,
                    weights,
                    residue,
                  },
                  { onSuccess: () => setSaved((current) => new Set(current).add(option.key)) },
                )
              }
              saving={save.isPending && save.variables?.choice === option.key}
              saved={saved.has(option.key)}
            />
          ))}
          {save.error && <Alert tone="error">{save.error.message}</Alert>}

          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SectionHeader title={t("plan.compareTitle")} subtitle={t("plan.compareHint")} />
              {chosen.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  {t("plan.clear")}
                </Button>
              )}
            </div>
            {chosen.length > 0 && (
              <CompareTable options={[...(data.current ? [data.current] : []), ...chosen]} catalog={catalog} currency={currency} />
            )}
          </Card>

          <StressCard
            onRun={() =>
              stress.mutate({
                kind: "rotation",
                irrigation,
                weights,
                rotations: (chosen.length ? chosen : data.options.slice(0, MAX_COMPARE)).map((option) => option.key),
              })
            }
            running={stress.isPending}
            error={stress.error?.message}
            result={stress.data as RotationStress | undefined}
            currency={currency}
            catalog={catalog}
          />
          <PricesCard
            ids={data.options.flatMap((option) => option.years.flatMap((year) => year.seasons.map((s) => s.crop ?? "")))}
            catalog={catalog}
          />
        </div>
      )}
    </div>
  );
}
