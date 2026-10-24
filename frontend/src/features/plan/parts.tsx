import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Catalog,
  Confidence,
  CropSeason,
  NextCropStress,
  PillarKey,
  Priorities,
  Reason,
  RotationOption,
  RotationStress,
  RuleEffect,
} from "../../api/types";
import { Badge, Button, Card, cx, SectionHeader } from "../../components/ui";
import { inTenYears, money, monthDay, percent } from "../../lib/format";
import { cropName, RULE_DOT, ruleText, yieldText, type T } from "../crops/text";

type PriceSource = "msp_kharif" | "msp_rabi" | "indicative";

function priceSource(catalog: Catalog, id: string): PriceSource {
  const sources = catalog.economics.price_sources;
  if (sources.msp_kharif?.includes(id)) return "msp_kharif";
  return sources.msp_rabi?.includes(id) ? "msp_rabi" : "indicative";
}

/** Every default figure behind the profit numbers, with where it comes from. */
export function PricesCard({ ids, catalog }: { ids: string[]; catalog?: Catalog }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!catalog) return null;
  const currency = catalog.economics.currency;
  const rows = [...new Set(ids)].filter((id) => catalog.agronomy[id]);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          title={t("plan.pricesTitle")}
          subtitle={t("plan.pricesSub", { n: money(catalog.economics.n_price_per_kg, currency) })}
        />
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {t(open ? "plan.pricesHide" : "plan.pricesShow")}
        </Button>
      </div>
      {open && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-stone-200 text-xs text-stone-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("plan.crop")}</th>
                  <th className="py-2 pr-3 font-medium">{t("plan.priceCol")}</th>
                  <th className="py-2 pr-3 font-medium">{t("plan.sourceCol")}</th>
                  <th className="py-2 font-medium">{t("plan.costCol")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 tabular-nums">
                {rows.map((id) => {
                  const source = priceSource(catalog, id);
                  return (
                    <tr key={id}>
                      <td className="py-2 pr-3 font-medium text-stone-800">{cropName(catalog, id)}</td>
                      <td className="py-2 pr-3">{money(catalog.agronomy[id].price, currency, false, 2)}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={source === "indicative" ? "amber" : "green"}>{t(`plan.priceSource.${source}`)}</Badge>
                      </td>
                      <td className="py-2">{money(catalog.agronomy[id].cost, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-stone-500">{t("plan.costNote")}</p>
        </>
      )}
    </Card>
  );
}

export const PILLARS: PillarKey[] = ["income", "water", "soil", "risk"];
export const DEFAULT_PRIORITIES: Priorities = { income: 1, water: 1, soil: 1, risk: 1 };
const SEASONS: CropSeason[] = ["kharif", "rabi", "summer"];
const PILLAR_COLOR: Record<PillarKey, string> = {
  income: "bg-amber-500",
  water: "bg-sky-500",
  soil: "bg-emerald-600",
  risk: "bg-violet-500",
};

export function useDebounced<V>(value: V, delayMs: number): V {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function PillarBars({ pillars, comparable = PILLARS }: { pillars: Priorities; comparable?: PillarKey[] }) {
  const { t } = useTranslation();
  return (
    <div>
    <p className="mb-2 text-xs text-stone-500">{t(comparable.length ? "quality.relativeHelp" : "quality.notComparable")}</p>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
      {PILLARS.map((key) => (
        <div key={key}>
          <dt className="flex justify-between text-[11px] font-medium text-stone-500">
            <span>{t(`plan.pillar.${key}`)}</span>
            <span className="tabular-nums">{comparable.includes(key) ? Math.round(pillars[key] * 100) : "-"}</span>
          </dt>
          <dd className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
            <div className={cx("h-full rounded-full", PILLAR_COLOR[key])} style={{ width: `${comparable.includes(key) ? pillars[key] * 100 : 0}%` }} />
          </dd>
        </div>
      ))}
    </dl>
    </div>
  );
}

export function ConfidenceNote({ confidence }: { confidence: Confidence }) {
  const { t } = useTranslation();
  const tone = confidence.level === "high" ? "green" : confidence.level === "medium" ? "amber" : "red";
  const flags = confidence.flags.map((flag) => flag === "weather_proxy" ? t("quality.proxySummary") : t(`plan.flag.${flag}`)).join("; ");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
      <Badge tone={tone}>{t(`plan.confidence.${confidence.level}`)}</Badge>
      {flags && <span>{t("plan.confidenceBecause", { flags })}</span>}
    </div>
  );
}

export function ReasonList({ reasons, rules, catalog }: { reasons: Reason[]; rules: RuleEffect[]; catalog?: Catalog }) {
  const { t } = useTranslation();
  if (!reasons.length && !rules.length) return null;
  return (
    <ul className="space-y-1">
      {reasons.map((reason) => (
        <li key={`${reason.code}-${reason.pillar}`} className="flex items-start gap-2 text-sm text-stone-700">
          <span
            className={cx("mt-1.5 size-2 shrink-0 rounded-full", reason.code === "strong" ? "bg-emerald-500" : "bg-stone-300")}
            aria-hidden="true"
          />
          {t(`plan.reason.${reason.code}.${reason.pillar}`)}
        </li>
      ))}
      {rules.map((rule, index) => (
        <li key={`${rule.rule}-${index}`} className="flex items-start gap-2 text-sm text-stone-700">
          <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", RULE_DOT[rule.kind])} aria-hidden="true" />
          {ruleText(t, rule, catalog)}
        </li>
      ))}
    </ul>
  );
}

/** "maize+chickpea+fallow>sorghum+fallow+fallow" -> "Maize → Chickpea · Sorghum" */
export function rotationLabel(key: string, catalog: Catalog | undefined, t: T): string {
  return key
    .split(">")
    .map((year) =>
      year
        .split("+")
        .filter((id) => id !== "fallow")
        .map((id) => cropName(catalog, id))
        .join(" → ") || t("plan.fallow"),
    )
    .join(" · ");
}

export function RotationTimeline({ option, catalog }: { option: RotationOption; catalog?: Catalog }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {option.years.map((year, index) => (
        <div key={year.season_year} className="flex flex-wrap items-stretch gap-2">
          <span className="w-14 shrink-0 pt-2 text-xs font-medium text-stone-500">{t("plan.yearN", { n: index + 1 })}</span>
          {SEASONS.map((season) => {
            const slot = year.seasons.find((s) => s.season === season);
            if (!slot) return null;
            const grown = slot.crop != null;
            return (
              <div
                key={season}
                className={cx(
                  "min-w-[9rem] flex-1 rounded-lg border px-3 py-2",
                  grown ? "border-emerald-200 bg-emerald-50/60" : "border-dashed border-stone-200 bg-stone-50",
                )}
              >
                <p className="text-[11px] font-medium tracking-wide text-stone-500 uppercase">
                  {t(`history.seasonName.${season}`)}
                </p>
                <p className={cx("text-sm font-semibold", grown ? "text-stone-900" : "text-stone-400")}>
                  {grown ? cropName(catalog, slot.crop) : t("plan.fallow")}
                </p>
                {grown && (
                  <p className="text-[11px] text-stone-500">
                    {monthDay(slot.sow)} → {monthDay(slot.harvest)} · {yieldText(t, slot.p50)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StressCell({ rank, income, risk, currency }: { rank: number | null; income: number | null; risk: string; currency: string }) {
  const { t } = useTranslation();
  if (rank == null) {
    return (
      <div className="rounded-md bg-red-50 px-2 py-1">
        <p className="text-[11px] font-medium text-red-700">{t("plan.notRanked")}</p>
      </div>
    );
  }
  return (
    <div className={cx("rounded-md px-2 py-1", rank <= 3 ? "bg-emerald-50" : "bg-stone-50")}>
      <p className="text-sm font-semibold tabular-nums">#{rank}</p>
      <p className="text-[11px] text-stone-600 tabular-nums">{money(income, currency)}</p>
      <p className="text-[11px] text-stone-400">{risk}</p>
    </div>
  );
}

export function StressTable({
  result,
  catalog,
  currency,
}: {
  result: NextCropStress | RotationStress;
  catalog?: Catalog;
  currency: string;
}) {
  const { t } = useTranslation();
  const rows =
    result.kind === "next_crop"
      ? result.crops.map((crop) => ({
          key: crop.id,
          label: cropName(catalog, crop.id),
          robust: crop.robust,
          cells: result.scenarios.map((s) => {
            const r = crop.results[s];
            return r ? { rank: r.rank, income: r.income_mean, risk: inTenYears(r.failure) } : null;
          }),
        }))
      : result.rotations.map((rotation) => ({
          key: rotation.key,
          label: rotationLabel(rotation.key, catalog, t),
          robust: rotation.robust,
          cells: result.scenarios.map((s) => {
            const r = rotation.results[s];
            return r ? { rank: r.rank, income: r.income_mean, risk: `${percent(r.failure)} ${t("plan.failures").toLowerCase()}` } : null;
          }),
        }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-separate border-spacing-1 text-left">
        <thead>
          <tr>
            <th className="text-xs font-medium text-stone-500">{t("plan.crop")}</th>
            {result.scenarios.map((s) => (
              <th key={s} className="text-xs font-medium text-stone-500">
                {t(`plan.scenario.${s}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="max-w-[14rem] pr-2 align-top text-sm font-medium text-stone-800">
                {row.label}
                {row.robust && (
                  <span className="mt-1 block" title={t("plan.robustHelp")}>
                    <Badge tone="green">{t("plan.robust")}</Badge>
                  </span>
                )}
              </th>
              {row.cells.map((cell, index) => (
                <td key={result.scenarios[index]} className="align-top">
                  {cell ? <StressCell {...cell} currency={currency} /> : <span className="text-stone-300">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
