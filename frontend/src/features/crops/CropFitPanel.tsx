import type { EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import { useCatalog, useCropFit } from "../../api/hooks";
import type { Catalog, CropFit, CropFitCrop, CropSeason, Farm, Irrigation } from "../../api/types";
import { AXIS_STYLE, EChart, SPLIT_LINE } from "../../components/EChart";
import { Alert, Badge, Button, Card, cx, Field, Metric, PageSpinner, SectionHeader, Select, Spinner } from "../../components/ui";
import { fullDate, inTenYears, mm, monthDay, percent, signed } from "../../lib/format";
import { catalogLabel, cropName, familyName, RULE_DOT, ruleText, yieldText } from "./text";

type Fit = "good" | "fair" | "poor" | "blocked";
type SortKey = "reliable" | "yield" | "water" | "carbon";

const SEASONS: CropSeason[] = ["kharif", "rabi", "summer"];
const IRRIGATIONS: Irrigation[] = ["rainfed", "protective", "full"];
const SORTS: SortKey[] = ["reliable", "yield", "water", "carbon"];
const FIT_TONE = { good: "green", fair: "amber", poor: "red", blocked: "red" } as const;

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

function CropCard({ crop, catalog, irrigated, carbonYears, expanded, onToggle }: {
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
  const water =
    irrigated && crop.water.irrigations > 0
      ? t("crops.irrigationDetail", { count: crop.water.irrigations, amount: mm(crop.water.irrigation_mm) })
      : t("crops.waterDetail", { need: mm(crop.water.need_mm) });

  return (
    <Card className={cx(crop.blocked && "bg-stone-50")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-stone-900">{cropName(catalog, crop.id)}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {family && <Badge>{family}</Badge>}
            {product && <span className="text-xs text-stone-500">{t("crops.productNote", { product })}</span>}
          </div>
        </div>
        <Badge tone={FIT_TONE[fit]}>{t(`crops.fit.${fit}`)}</Badge>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric
          label={t("crops.typicalYield")}
          value={yieldText(t, crop.yield.p50)}
          detail={t("crops.yieldRange", { low: yieldText(t, crop.yield.p10), high: yieldText(t, crop.yield.p90) })}
        />
        <Metric
          label={t("crops.fails")}
          value={inTenYears(crop.yield.failure)}
          detail={t("crops.failsDetail", { value: yieldText(t, crop.yield.attainable) })}
          warn={(crop.yield.failure.p ?? 0) > 0.3}
        />
        <Metric label={t("crops.waterMet")} value={percent(crop.water.met)} detail={water} />
        <Metric
          label={t("crops.sowing")}
          value={monthDay(crop.sowing.median)}
          detail={t("crops.windowDetail", {
            start: monthDay(crop.sowing.window[0]),
            end: monthDay(crop.sowing.window[1]),
            harvest: monthDay(crop.harvest.median),
          })}
        />
      </dl>
      {crop.rules.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {crop.rules.map((rule, index) => (
            <li key={`${rule.rule}-${index}`} className="flex items-start gap-2 text-sm text-stone-700">
              <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", RULE_DOT[rule.kind])} aria-hidden="true" />
              {ruleText(t, rule, catalog)}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 -ml-3">
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onToggle}>
          {t(expanded ? "crops.hideDetails" : "crops.showDetails")}
        </Button>
      </div>
      {expanded && <CropDetails crop={crop} carbonYears={carbonYears} />}
    </Card>
  );
}

function Context({ data, catalog, onOpenHistory }: { data: CropFit; catalog?: Catalog; onOpenHistory: () => void }) {
  const { t } = useTranslation();
  const previous = data.previous;
  return (
    <div className="mt-5 space-y-1.5 border-t border-stone-100 pt-4 text-sm text-stone-600">
      {previous ? (
        <p>
          {t("crops.after", {
            crops: previous.crops.map((id) => cropName(catalog, id)).join(" + "),
            state: t(previous.harvested ? "crops.harvestedOn" : "crops.expectedOn"),
            date: fullDate(previous.end_date),
          })}
        </p>
      ) : (
        <p>
          {t("crops.noHistory")}{" "}
          <button type="button" className="font-medium text-emerald-700 underline" onClick={onOpenHistory}>
            {t("crops.openHistory")}
          </button>
        </p>
      )}
      <p>
        {t("crops.soilNote", {
          awc: data.soil.awc_mm,
          source: t(`soil.source.${data.soil.source}`),
        })}
      </p>
      {data.carbon && (
        <p>{t(data.carbon.baseline_source === "journal" ? "crops.carbonBaselineJournal" : "crops.carbonBaselineDefault")}</p>
      )}
    </div>
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
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
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
          />
          {fit.isFetching && (
            <span className="flex items-center gap-2 text-sm text-stone-500">
              <Spinner className="size-4" />
              {t("crops.updating")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="mb-1.5 text-sm font-medium text-stone-800">{t("crops.season")}</p>
            <div role="radiogroup" aria-label={t("crops.season")} className="inline-flex rounded-xl bg-stone-100 p-1">
              {SEASONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={activeSeason === key}
                  onClick={() => {
                    setSeason(key);
                    setOpen(null);
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
          </div>
          <div className="w-56">
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
          <div className="w-64">
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
        {data && <Context data={data} catalog={catalog.data} onOpenHistory={onOpenHistory} />}
      </Card>

      {fit.isPending && <PageSpinner />}
      {fit.isError && (
        <Alert tone={fit.error instanceof ApiError && fit.error.status === 409 ? "info" : "error"}>{fit.error.message}</Alert>
      )}
      {data && (
        <div className={cx("space-y-4 transition-opacity", fit.isPlaceholderData && "opacity-60")}>
          {crops.map((crop) => (
            <CropCard
              key={crop.id}
              crop={crop}
              catalog={catalog.data}
              irrigated={data.irrigation !== "rainfed"}
              carbonYears={data.carbon?.years ?? 10}
              expanded={open === crop.id}
              onToggle={() => setOpen(open === crop.id ? null : crop.id)}
            />
          ))}
        </div>
      )}
      <p className="text-xs leading-relaxed text-stone-500">{t("crops.method")}</p>
    </div>
  );
}
