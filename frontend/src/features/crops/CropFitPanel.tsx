import type { EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useCatalog, useCropFit } from "../../api/hooks";
import type { Catalog, CropFit, CropFitCrop, CropSeason, Farm, Irrigation } from "../../api/types";
import { AXIS_STYLE, EChart, SPLIT_LINE } from "../../components/EChart";
import { ChevronDown } from "lucide-react";
import { AboutData, Alert, cx, Field, Meter, PageSpinner, SectionHeader, Segmented, Select, Spinner } from "../../components/ui";
import { fullDate, inTenYears, mm, monthDay, percent, signed } from "../../lib/format";
import { catalogLabel, cropName, familyName, RULE_DOT, ruleText, yieldText } from "./text";

type Fit = "good" | "fair" | "poor" | "blocked";
type SortKey = "reliable" | "yield" | "water" | "carbon";

const SEASONS: CropSeason[] = ["kharif", "rabi", "summer"];
const IRRIGATIONS: Irrigation[] = ["rainfed", "protective", "full"];
const SORTS: SortKey[] = ["reliable", "yield", "water", "carbon"];

function fitOf(crop: CropFitCrop): Fit {
  if (crop.blocked) return "blocked";
  const failure = crop.yield.failure.p ?? 1;
  if (failure <= 0.1) return "good";
  return failure <= 0.3 ? "fair" : "poor";
}

const SORT_KEYS: Record<SortKey, (crop: CropFitCrop) => number[]> = {
  reliable: (crop) => [crop.yield.failure.p ?? 1, -crop.yield.relative],
  yield: (crop) => [-crop.yield.relative],
  water: (crop) => [crop.water.need_mm ?? Infinity],
  carbon: (crop) => [-(crop.carbon?.kept.mid ?? -Infinity)],
};

function sortCrops(crops: CropFitCrop[], sort: SortKey): CropFitCrop[] {
  const key = (crop: CropFitCrop) => [crop.blocked ? 1 : 0, ...SORT_KEYS[sort](crop)];
  return [...crops].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    const i = ka.findIndex((value, index) => value !== kb[index]);
    return i < 0 ? 0 : ka[i] - kb[i];
  });
}

function YieldChart({ crop }: { crop: CropFitCrop }) {
  const { t } = useTranslation();
  const option = useMemo<EChartsCoreOption>(() => {
    const attainable = crop.yield.attainable ?? 0;
    return {
      tooltip: {
        trigger: "axis",
        valueFormatter: (value: unknown) => (typeof value === "number" ? yieldText(t, value) : "—"),
      },
      grid: { left: 52, right: 64, top: 28, bottom: 32 },
      xAxis: {
        type: "category",
        data: crop.yield.by_year.map((row) => String(row.year)),
        axisTick: { show: false },
        ...AXIS_STYLE,
      },
      yAxis: {
        type: "value",
        max: attainable || undefined,
        ...AXIS_STYLE,
        axisLabel: {
          ...AXIS_STYLE.axisLabel,
          formatter: (value: number) => (attainable >= 10_000 ? `${value / 1000} t` : value.toLocaleString()),
        },
        ...SPLIT_LINE,
      },
      series: [
        {
          type: "bar",
          name: t("crops.typicalYield"),
          barMaxWidth: 14,
          data: crop.yield.by_year.map((row) => ({
            value: row.kg_ha,
            itemStyle: { color: row.kg_ha < attainable / 2 ? "#f59e0b" : "#10b981", borderRadius: [3, 3, 0, 0] },
          })),
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { type: "dashed", color: "#78716c" },
            label: { position: "end", color: "#44403c", formatter: "{b}" },
            data: [
              { name: t("crops.attainable"), yAxis: attainable },
              { name: t("crops.half"), yAxis: attainable / 2 },
            ],
          },
        },
      ],
    };
  }, [crop, t]);
  return <EChart option={option} label={t("crops.byYear")} height={230} />;
}

function CropDetails({ crop, carbonYears }: { crop: CropFitCrop; carbonYears: number }) {
  const { t } = useTranslation();
  const nitrogen = t("crops.nitrogenValue", { kg: crop.nitrogen.to_apply });
  const facts: [string, string][] = [
    [
      t("crops.heat"),
      crop.heat.risk && crop.heat.threshold_c != null
        ? t("crops.heatValue", { odds: inTenYears(crop.heat.risk), threshold: crop.heat.threshold_c })
        : t("crops.noHeat"),
    ],
    [
      t("crops.nitrogen"),
      crop.nitrogen.fixed > 0
        ? `${nitrogen}; ${t("crops.nitrogenFixer", { fixed: crop.nitrogen.fixed, leaves: crop.nitrogen.leaves })}`
        : nitrogen,
    ],
    [t("crops.soilAtSowing"), mm(crop.water.soil_at_sowing_mm)],
  ];
  if (crop.carbon) {
    const { kept, removed } = crop.carbon;
    facts.push([
      t("crops.carbon", { years: carbonYears }),
      `${t("crops.carbonValue", { kept: signed(kept.mid), low: signed(kept.low), high: signed(kept.high) })}. ${t(
        "crops.carbonRemoved",
        { removed: signed(removed.mid) },
      )}.`,
    ]);
  }
  return (
    <div className="mt-4 border-t border-stone-100 pt-4">
      <SectionHeader title={t("crops.byYear")} subtitle={t("crops.byYearSub", { n: crop.yield.by_year.length })} />
      <YieldChart crop={crop} />
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-medium text-stone-500">{label}</dt>
            <dd className="mt-0.5 text-sm text-stone-800">{value}</dd>
          </div>
        ))}
      </dl>
      {crop.sowing.dry.k > 0 && (
        <p className="mt-3 text-xs text-stone-500">{t("crops.drySown", { k: crop.sowing.dry.k, n: crop.sowing.dry.n })}</p>
      )}
      {crop.sowing.late.k > 0 && (
        <p className="mt-1 text-xs text-stone-500">{t("crops.lateSown", { k: crop.sowing.late.k, n: crop.sowing.late.n })}</p>
      )}
    </div>
  );
}

/** Every simulated season as a hairline bar: green when the crop made at least half its attainable yield, amber when it failed. */
function SeasonBars({ crop }: { crop: CropFitCrop }) {
  const rows = crop.yield.by_year;
  const top = Math.max(crop.yield.attainable ?? 0, ...rows.map((row) => row.kg_ha), 1);
  const half = (crop.yield.attainable ?? top) / 2;
  return (
    <span className="flex h-6 w-28 items-end gap-px" aria-hidden="true">
      {rows.map((row) => (
        <span
          key={row.year}
          className={cx("min-h-px flex-1 rounded-[1px]", row.kg_ha < half ? "bg-amber-500" : "bg-emerald-500")}
          style={{ height: `${Math.max(4, (row.kg_ha / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

const FIT_DOT = { good: "bg-emerald-500", fair: "bg-amber-500", poor: "bg-red-500", blocked: "bg-stone-400" } as const;

function CropRow({ crop, catalog, irrigated, carbonYears, expanded, onToggle }: {
  crop: CropFitCrop;
  catalog?: Catalog;
  irrigated: boolean;
  carbonYears: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const info = catalog?.crops.find((item) => item.id === crop.id);
  const family = info?.family ? familyName(catalog, info.family) : undefined;
  const rawProduct = catalog?.agronomy?.[crop.id]?.product;
  const product = rawProduct ? catalogLabel("product", rawProduct, rawProduct) : undefined;
  const fit = fitOf(crop);
  const failure = crop.yield.failure.p;
  const water =
    irrigated && crop.water.irrigations > 0
      ? t("crops.irrigationDetail", { count: crop.water.irrigations, amount: mm(crop.water.irrigation_mm) })
      : t("crops.waterDetail", { need: mm(crop.water.need_mm) });
  const detailsId = `crop-${crop.id}-details`;
  const cell = "px-4 py-3 align-top";

  return (
    <>
      <tr className={cx("border-t border-stone-200", crop.blocked && "bg-stone-100/50", expanded && "bg-stone-100/40")}>
        <th scope="row" className={cx(cell, "text-left font-normal")}>
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={detailsId} className="text-left">
            <span className="block font-semibold text-stone-900 hover:text-emerald-700">{cropName(catalog, crop.id)}</span>
            <span className="block text-xs text-stone-500">
              {[family, product && t("crops.productNote", { product })].filter(Boolean).join(" · ")}
            </span>
          </button>
          {crop.rules[0] && (
            <p className="mt-1 flex max-w-xs items-start gap-1.5 text-xs text-stone-600">
              <span className={cx("mt-1 size-1.5 shrink-0 rounded-full", RULE_DOT[crop.rules[0].kind])} aria-hidden="true" />
              <span className="line-clamp-2">{ruleText(t, crop.rules[0], catalog)}</span>
            </p>
          )}
        </th>
        <td className={cell}>
          <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-stone-800">
            <span className={cx("size-2 rounded-full", FIT_DOT[fit])} aria-hidden="true" />
            {t(`crops.fit.${fit}`)}
          </span>
        </td>
        <td className={cell}>
          <p className="tabular font-semibold text-stone-900">{yieldText(t, crop.yield.p50)}</p>
          <p className="tabular text-xs text-stone-500">{yieldText(t, crop.yield.p10)} – {yieldText(t, crop.yield.p90)}</p>
        </td>
        <td className={cell}>
          <SeasonBars crop={crop} />
          <p className={cx("mt-1 whitespace-nowrap text-xs", (failure ?? 0) > 0.3 ? "font-medium text-amber-700" : "text-stone-600")}>{inTenYears(crop.yield.failure)}</p>
        </td>
        <td className={cell}>
          <Meter value={crop.water.met} className="w-20" />
          <p className="tabular mt-1 text-xs text-stone-600">{percent(crop.water.met)}</p>
        </td>
        <td className={cell}>
          <p className="tabular whitespace-nowrap font-medium text-stone-900">{monthDay(crop.sowing.median)}</p>
          <p className="tabular whitespace-nowrap text-xs text-stone-500">{monthDay(crop.sowing.window[0])} – {monthDay(crop.sowing.window[1])}</p>
        </td>
        <td className={cx(cell, "text-right")}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={t(expanded ? "crops.hideDetails" : "crops.showDetails")}
            title={t(expanded ? "crops.hideDetails" : "crops.showDetails")}
            className="rounded-md p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <ChevronDown className={cx("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr id={detailsId} className="bg-stone-100/40">
          <td colSpan={7} className="px-4 pb-5">
            <dl className="grid gap-4 border-t border-stone-200 pt-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-stone-500">{t("crops.fails")}</dt>
                <dd className="mt-0.5 text-stone-800">{t("crops.failsDetail", { value: yieldText(t, crop.yield.attainable) })}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-stone-500">{t("crops.waterMet")}</dt>
                <dd className="mt-0.5 text-stone-800">{water}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-stone-500">{t("crops.sowing")}</dt>
                <dd className="mt-0.5 text-stone-800">
                  {t("crops.windowDetail", {
                    start: monthDay(crop.sowing.window[0]),
                    end: monthDay(crop.sowing.window[1]),
                    harvest: monthDay(crop.harvest.median),
                  })}
                </dd>
              </div>
            </dl>
            {crop.rules.length > 1 && (
              <ul className="mt-4 space-y-1.5">
                {crop.rules.slice(1).map((rule, index) => (
                  <li key={`${rule.rule}-${index}`} className="flex items-start gap-2 text-sm text-stone-700">
                    <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", RULE_DOT[rule.kind])} aria-hidden="true" />
                    {ruleText(t, rule, catalog)}
                  </li>
                ))}
              </ul>
            )}
            <CropDetails crop={crop} carbonYears={carbonYears} />
          </td>
        </tr>
      )}
    </>
  );
}

function PreviousLine({ data, catalog, onOpenHistory }: { data: CropFit; catalog?: Catalog; onOpenHistory: () => void }) {
  const { t } = useTranslation();
  const previous = data.previous;
  return (
    <p>
      {previous ? (
        t("crops.after", {
          crops: previous.crops.map((id) => cropName(catalog, id)).join(" + "),
          state: t(previous.harvested ? "crops.harvestedOn" : "crops.expectedOn"),
          date: fullDate(previous.end_date),
        })
      ) : (
        <>
          {t("crops.noHistory")}{" "}
          <button type="button" className="font-medium text-emerald-700 underline" onClick={onOpenHistory}>
            {t("crops.openHistory")}
          </button>
        </>
      )}
    </p>
  );
}

export function CropFitPanel({ farm, onOpenHistory }: { farm: Farm; onOpenHistory: () => void }) {
  const { t } = useTranslation();
  const [season, setSeason] = useState<CropSeason | undefined>();
  const [irrigation, setIrrigation] = useState<Irrigation>(farm.irrigation);
  const [sort, setSort] = useState<SortKey>("reliable");
  const [open, setOpen] = useState<string | null>(null);
  const catalog = useCatalog();
  const fit = useCropFit(farm.id, season, irrigation);
  const data = fit.isError ? undefined : fit.data;
  const activeSeason = season ?? data?.season;
  const crops = useMemo(() => (data ? sortCrops(data.crops, sort) : []), [data, sort]);

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title={
            data
              ? t("crops.title", { season: t(`history.seasonName.${data.season}`), year: data.season_year })
              : t("crops.titlePlain")
          }
          subtitle={
            data
              ? t("crops.subtitle", { first: data.period.first_year, last: data.period.last_year, n: data.period.n_years })
              : undefined
          }
          action={fit.isFetching ? (
            <span className="flex items-center gap-2 text-sm text-stone-500">
              <Spinner className="size-4" />
              {t("crops.updating")}
            </span>
          ) : undefined}
        />
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="mb-1.5 text-sm font-medium text-stone-800">{t("crops.season")}</p>
            <Segmented
              label={t("crops.season")}
              value={activeSeason}
              onChange={(key) => { setSeason(key); setOpen(null); }}
              items={SEASONS.map((key) => ({ key, label: t(`history.seasonName.${key}`) }))}
            />
          </div>
          <div className="w-52">
            <Field label={t("crops.water")}>
              {(id) => (
                <Select id={id} value={irrigation} onChange={(event) => setIrrigation(event.target.value as Irrigation)}>
                  {IRRIGATIONS.map((key) => (
                    <option key={key} value={key}>
                      {t(`farms.irrigation.${key}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="w-56">
            <Field label={t("crops.sort")}>
              {(id) => (
                <Select id={id} value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  {SORTS.map((key) => (
                    <option key={key} value={key}>
                      {t(`crops.sortBy.${key}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </div>
      </section>

      {fit.isPending && <PageSpinner />}
      {fit.isError && (
        <Alert tone={fit.error instanceof ApiError && fit.error.status === 409 ? "info" : "error"}>{fit.error.message}</Alert>
      )}
      {data && (
        <div className={cx("overflow-x-auto rounded-2xl border border-stone-200 bg-surface transition-opacity", fit.isPlaceholderData && "opacity-60")}>
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="text-xs text-stone-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">{t("plan.crop")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("crops.fitCol")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("crops.typicalYield")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("crops.fails")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("crops.waterMet")}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t("crops.sowing")}</th>
                <th scope="col" className="w-10 px-4 py-3"><span className="sr-only">{t("crops.showDetails")}</span></th>
              </tr>
            </thead>
            <tbody>
              {crops.map((crop) => (
                <CropRow
                  key={crop.id}
                  crop={crop}
                  catalog={catalog.data}
                  irrigated={data.irrigation !== "rainfed"}
                  carbonYears={data.carbon?.years ?? 10}
                  expanded={open === crop.id}
                  onToggle={() => setOpen(open === crop.id ? null : crop.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AboutData>
        {data && <PreviousLine data={data} catalog={catalog.data} onOpenHistory={onOpenHistory} />}
        {data && <p>{t("crops.soilNote", { awc: data.soil.awc_mm, source: t(`soil.source.${data.soil.source}`) })}</p>}
        {data?.carbon && <p>{t(data.carbon.baseline_source === "journal" ? "crops.carbonBaselineJournal" : "crops.carbonBaselineDefault")}</p>}
        <p>{t("crops.method")}</p>
      </AboutData>
    </div>
  );
}
