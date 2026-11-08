import { CloudRain, Droplets, GripVertical, Layers, Pencil, Search, Sprout as SproutIcon, Sun, Wind, X } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useClimate, useCropFit, useNextCrop, useSoil } from "../../api/hooks";
import type { Catalog, CropOutcome, EffectiveSoil, Farm, Irrigation, NextCropAdvice, NextCropOption, SoilSummary } from "../../api/types";
import { Alert, Badge, cx, Spinner } from "../../components/ui";
import { fullDate, mm, money, monthName, percent, signed } from "../../lib/format";
import { cropName, ruleText, yieldText } from "../crops/text";
import { DEFAULT_PRIORITIES } from "../plan/parts";
import { FieldScene } from "./FieldScene";
import type { Sky } from "./model";
import { driesOut, rootZone, skyOf, verdictOf, VERDICT_TONE } from "./model";

const IRRIGATIONS: Irrigation[] = ["rainfed", "protective", "full"];
const DRAG_TYPE = "application/x-cropcompass-crop";

function Tile({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-stone-200 bg-surface p-4">
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
        {icon}
        {title}
      </p>
      <div className="mt-2 space-y-0.5 text-sm text-stone-700">{children}</div>
    </div>
  );
}

function PreviousTile({ advice, previous, catalog }: {
  advice: NextCropAdvice | undefined;
  previous: { crops: string[]; end_date: string; harvested: boolean } | null | undefined;
  catalog?: Catalog;
}) {
  const { t } = useTranslation();
  const inField = advice?.in_field;
  return (
    <Tile icon={<SproutIcon className="size-3.5" aria-hidden="true" />} title={t(inField ? "field.inField" : "field.previous")}>
      {inField ? (
        <>
          <p className="text-base font-semibold text-stone-900">{cropName(catalog, inField.crop)}</p>
          <p className="text-xs text-stone-500">{t("field.harvestBy", { date: fullDate(inField.expected_harvest) })}</p>
        </>
      ) : previous?.crops.length ? (
        <>
          <p className="text-base font-semibold text-stone-900">{previous.crops.map((id) => cropName(catalog, id)).join(" + ")}</p>
          <p className="text-xs text-stone-500">{t("field.endedOn", { date: fullDate(previous.end_date) })}</p>
        </>
      ) : (
        <>
          <p className="text-base font-semibold text-stone-900">{t("field.noPrevious")}</p>
          <p className="text-xs text-stone-500">{t("field.noPreviousHint")}</p>
        </>
      )}
    </Tile>
  );
}

function WeatherTile({ sky, rain }: { sky: Sky; rain: { mm: number; median: number; percentile: number } | null }) {
  const { t } = useTranslation();
  const month = sky.month;
  const tags: { key: "hot" | "wet" | "windy"; icon: ReactNode }[] = [];
  if (sky.hot) tags.push({ key: "hot", icon: <Sun className="size-3.5" aria-hidden="true" /> });
  if (sky.wet) tags.push({ key: "wet", icon: <CloudRain className="size-3.5" aria-hidden="true" /> });
  if (sky.windy) tags.push({ key: "windy", icon: <Wind className="size-3.5" aria-hidden="true" /> });
  const band = rain ? (rain.percentile < 0.33 ? "rainBelow" : rain.percentile > 0.67 ? "rainAbove" : "rainNormal") : null;
  return (
    <Tile icon={<CloudRain className="size-3.5" aria-hidden="true" />} title={t("field.weather")}>
      {rain && band && (
        <p>
          <span className="font-semibold text-stone-900">{t(`field.${band}`)}</span>{" "}
          <span className="text-stone-500">{t("field.seasonRain", { mm: mm(rain.mm), median: mm(rain.median) })}</span>
        </p>
      )}
      <p className="tabular">
        {t("field.monthNormal", { month: monthName(month.month) })}: {t("field.tmax", { value: month.tmax_c.toFixed(0) })} ·{" "}
        {mm(month.rain_mm)}
        {month.wind_ms != null && <> · {t("field.wind", { value: month.wind_ms.toFixed(1) })}</>}
      </p>
      {tags.length > 0 && (
        <p className="flex flex-wrap gap-1.5 pt-1">
          {tags.map((tag) => (
            <span key={tag.key} className="inline-flex items-center gap-1 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
              {tag.icon}
              {t(`field.${tag.key}`)}
            </span>
          ))}
        </p>
      )}
      <p className="text-xs text-stone-500">{t("field.weatherAsOf", { date: fullDate(sky.asOf) })}</p>
    </Tile>
  );
}

function SoilTile({ soil, depthAssumed, onOpenSoil }: { soil: EffectiveSoil; depthAssumed: boolean; onOpenSoil: () => void }) {
  const { t } = useTranslation();
  return (
    <Tile icon={<Layers className="size-3.5" aria-hidden="true" />} title={t("field.soil")}>
      <p className="text-base font-semibold text-stone-900 capitalize">
        {soil.texture ? t(`soil.textureName.${soil.texture}`, { defaultValue: soil.texture }) : t("field.soilUnknown")}
      </p>
      <p className="tabular">{t("field.soilLine", { depth: (soil.depth_cm / 100).toFixed(1), mm: mm(soil.awc_mm) })}</p>
      <p className="text-xs font-medium text-stone-700">{t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}</p>
      <p className="tabular text-xs text-stone-500">
        {[
          soil.organic_carbon_pct != null && t("field.oc", { value: soil.organic_carbon_pct.toFixed(2) }),
          soil.ph != null && t("field.ph", { value: soil.ph.toFixed(1) }),
          t(`soil.source.${soil.source}`, { defaultValue: soil.source }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <button type="button" onClick={onOpenSoil} className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 hover:underline">
        <Pencil className="size-3.5 shrink-0" aria-hidden="true" />{t("field.editSoil")}
      </button>
    </Tile>
  );
}

function WaterTile({ advice }: { advice: NextCropAdvice }) {
  const { t } = useTranslation();
  const now = advice.soil_now;
  const compare = now.percentile < 0.5 ? t("plan.drierThan", { pct: percent(1 - now.percentile) }) : t("plan.wetterThan", { pct: percent(now.percentile) });
  return (
    <Tile icon={<Droplets className="size-3.5" aria-hidden="true" />} title={t("field.water")}>
      <p className="text-base font-semibold text-stone-900 tabular">{percent(now.fraction)}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-200" aria-hidden="true">
        <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, now.fraction)) * 100)}%` }} />
      </div>
      <p className="tabular text-xs text-stone-500">{t("field.waterLine", { mm: mm(now.mm), capacity: mm(now.capacity_mm) })}</p>
      <p className="text-xs text-stone-500">{compare}</p>
    </Tile>
  );
}

type Pick = { id: string; source: "next" | "seasonal"; outcome: CropOutcome; option?: NextCropOption };

function CropCard({ pick, catalog, active, disabled, previewId, onPlace }: {
  pick: Pick; catalog?: Catalog; active: boolean; disabled: boolean; previewId: string; onPlace: () => void;
}) {
  const { t } = useTranslation();
  const verdict = verdictOf(pick.outcome);
  const fail = pick.outcome.yield.failure;
  const start = (event: DragEvent) => {
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: pick.id, source: pick.source }));
    event.dataTransfer.setData("text/plain", cropName(catalog, pick.id));
    event.dataTransfer.effectAllowed = "copy";
  };
  return (
    <li>
      <button
        type="button"
        draggable={!disabled}
        disabled={disabled}
        onDragStart={start}
        onClick={onPlace}
        aria-pressed={active}
        aria-controls={previewId}
        aria-label={`${t(active ? "field.previewing" : "field.tryMe")}: ${cropName(catalog, pick.id)}`}
        className={cx(
          "group flex w-full cursor-grab items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition active:cursor-grabbing disabled:cursor-wait disabled:opacity-50",
          active ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-surface hover:border-stone-400",
        )}
      >
        <GripVertical className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
        {pick.option && (
          <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-md bg-stone-900 text-xs font-semibold text-stone-50">
            {pick.option.rank}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block break-words font-semibold text-stone-900">{cropName(catalog, pick.id)}</span>
          <span className="tabular block text-xs text-stone-500">
            {t("field.failsShort", { k: fail.k, n: fail.n })} · {t("field.waterShort", { pct: percent(pick.outcome.water.met) })}
          </span>
          <span className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <span className={cx("text-xs", VERDICT_TONE[verdict].text)}>{t(`field.verdict.${verdict}`)}</span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              <SproutIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t(active ? "field.previewing" : "field.tryMe")}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

function WaterBalance({ outcome }: { outcome: CropOutcome }) {
  const { t } = useTranslation();
  const water = outcome.water;
  const parts = [
    { key: "balanceStored", value: water.soil_at_sowing_mm ?? 0, color: "bg-sky-700" },
    { key: "balanceRain", value: water.rain_mm ?? 0, color: "bg-sky-500" },
    { key: "balanceIrrigation", value: water.irrigation_mm, color: "bg-emerald-500" },
  ] as const;
  const supply = parts.reduce((sum, part) => sum + part.value, 0);
  const need = water.need_mm ?? 0;
  const scale = Math.max(supply, need, 1);
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{t("field.balanceTitle")}</p>
      <div className="relative mt-2 h-4 overflow-hidden rounded bg-stone-100">
        <div className="flex h-full">
          {parts.map((part) => (
            <div key={part.key} className={part.color} style={{ width: `${(part.value / scale) * 100}%` }} />
          ))}
        </div>
        {need > 0 && <div className="absolute inset-y-0 w-0.5 bg-stone-900" style={{ left: `min(${(need / scale) * 100}%, calc(100% - 2px))` }} aria-hidden="true" />}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
        {parts.map((part) => (
          <li key={part.key} className="tabular inline-flex items-center gap-1.5">
            <span className={cx("size-2 rounded-sm", part.color)} aria-hidden="true" />
            {t(`field.${part.key}`)} {mm(part.value)}
          </li>
        ))}
        <li className="tabular inline-flex items-center gap-1.5 font-medium text-stone-800">
          <span className="h-3 w-0.5 bg-stone-900" aria-hidden="true" />
          {t("field.balanceNeed", { mm: mm(need) })}
        </li>
        {need > supply && (
          <li className="tabular inline-flex items-center gap-1.5 font-medium text-amber-700">
            <span className="size-2 rounded-sm border border-amber-600" aria-hidden="true" />
            {t("field.balanceShort", { mm: mm(need - supply) })}
          </li>
        )}
      </ul>
    </div>
  );
}

function Readout({ pick, catalog, soil, depthAssumed, irrigation, onIrrigation, carbonYears, currency }: {
  pick: Pick;
  catalog?: Catalog;
  soil: EffectiveSoil;
  depthAssumed: boolean;
  irrigation: Irrigation;
  onIrrigation: (value: Irrigation) => void;
  carbonYears: number | null;
  currency: string;
}) {
  const { t } = useTranslation();
  const outcome = pick.outcome;
  const verdict = verdictOf(outcome);
  const rootM = catalog?.species?.[pick.id]?.root_m;
  const zone = rootM != null ? rootZone(rootM, soil.depth_cm, soil.awc_mm_per_m) : null;
  const fail = outcome.yield.failure;
  const heat = outcome.heat.risk;

  const why: string[] = [];
  if (zone) {
    why.push(
      t(zone.limited ? "field.whyRootsLimited" : "field.whyRoots", {
        root: zone.rootM.toFixed(1),
        soil: zone.soilM.toFixed(1),
        mm: mm(zone.storeMm),
      }),
    );
  }
  if (outcome.water.met != null) why.push(t("field.whyWater", { pct: percent(outcome.water.met), need: mm(outcome.water.need_mm) }));
  if (driesOut(outcome)) why.push(t("field.whyDry"));
  if (fail.n > 0) why.push(t("field.whyFail", { k: fail.k, n: fail.n }));
  if (heat && heat.p != null && heat.p > 0 && outcome.heat.threshold_c != null) {
    why.push(t("field.whyHeat", { c: outcome.heat.threshold_c, k: heat.k, n: heat.n }));
  }
  for (const rule of outcome.rules) why.push(ruleText(t, rule, catalog));

  const help: { text: string; action?: ReactNode; general?: boolean }[] = [];
  const nextIrrigation = IRRIGATIONS[IRRIGATIONS.indexOf(irrigation) + 1];
  if (driesOut(outcome) && nextIrrigation) {
    help.push({
      text: t("field.helpIrrigate"),
      action: (
        <button type="button" onClick={() => onIrrigation(nextIrrigation)} className="font-medium text-emerald-700 underline-offset-2 hover:underline">
          {t("field.helpIrrigateAction", { level: t(`farms.irrigation.${nextIrrigation}`) })}
        </button>
      ),
    });
  }
  const sowing = pick.option?.sowing;
  if (sowing?.options.length) {
    const rates = sowing.options.map((entry) => entry.failure.p ?? 0);
    const best = sowing.options.find((entry) => entry.date === sowing.best)?.failure.p ?? Math.min(...rates);
    const worst = Math.max(...rates);
    if (worst - best >= 0.1) help.push({ text: t("field.helpSow", { date: fullDate(sowing.best), best: percent(best), worst: percent(worst) }) });
  }
  if (outcome.carbon && carbonYears) {
    const { kept, removed } = outcome.carbon;
    if (kept.mid > removed.mid) {
      help.push({ text: t("field.helpResidue", { kept: signed(kept.mid), removed: signed(removed.mid), years: carbonYears }) });
    }
  }
  if (outcome.nitrogen.to_apply > 0) {
    help.push({
      text: outcome.nitrogen.credit > 0
        ? t("field.helpNitrogenCredit", { kg: Math.round(outcome.nitrogen.to_apply), credit: Math.round(outcome.nitrogen.credit) })
        : t("field.helpNitrogen", { kg: Math.round(outcome.nitrogen.to_apply) }),
    });
  }
  if (soil.organic_carbon_pct != null && soil.organic_carbon_pct < 0.75) {
    help.push({ text: t("field.helpOrganic", { value: soil.organic_carbon_pct.toFixed(2) }), general: true });
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-surface p-5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-semibold text-stone-900">{cropName(catalog, pick.id)}</h3>
        <Badge tone={VERDICT_TONE[verdict].badge}>{t(`field.verdict.${verdict}`)}</Badge>
        {pick.option && <span className="text-xs text-stone-500">{t("field.rank", { rank: pick.option.rank })}</span>}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 border-y border-stone-200 py-4 sm:grid-cols-4">
        {([
          ["field.mYield", yieldText(t, outcome.yield.p50)],
          ["field.mIncome", money(outcome.income.mean, currency)],
          ["field.mFail", fail.n ? `${fail.k} / ${fail.n}` : "—"],
          ["field.mIrrigation", outcome.water.irrigations ? `${outcome.water.irrigations} × · ${mm(outcome.water.irrigation_mm)}` : "—"],
        ] as const).map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs font-medium text-stone-500">{t(key)}</dt>
            <dd className="tabular mt-0.5 text-lg font-semibold text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <WaterBalance outcome={outcome} />
          <div>
            <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{t("field.why")}</p>
            <p className="mt-2 text-xs text-stone-600">{t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}</p>
            <ul className="mt-2 space-y-1.5 text-sm text-stone-700">
              {why.map((line) => (
                <li key={line} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-stone-400" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">{t("field.helpTitle")}</p>
          {help.length ? (
            <ol className="mt-2 space-y-2 text-sm text-stone-700">
              {help.map((item, index) => (
                <li key={item.text} className="flex gap-3 rounded-lg border border-stone-200 p-3">
                  <span className="tabular text-xs font-semibold text-stone-400">0{index + 1}</span>
                  <span className="min-w-0">
                    {item.text}
                    {item.general && <span className="text-stone-500"> {t("field.general")}</span>}
                    {item.action && <span className="mt-1 block">{item.action}</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-stone-600">{t("field.helpNone")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** `verified` is false while weather is still being checked: next-crop advice can run on a disclosed proxy,
 * but the climate profile and the all-crop fit need the verified record. */
export function FieldPanel({ farm, verified, onOpenSoil }: { farm: Farm; verified: boolean; onOpenSoil: () => void }) {
  const { t } = useTranslation();
  const [irrigation, setIrrigation] = useState<Irrigation>(farm.irrigation);
  const [placed, setPlaced] = useState<{ id: string; source: Pick["source"] } | null>(null);
  const [search, setSearch] = useState("");
  const [over, setOver] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const searchId = useId();
  const catalog = useCatalog().data;
  const climate = useClimate(farm.id, verified);
  const soil = useSoil(farm.id, true);
  const advice = useNextCrop(farm.id, undefined, irrigation, farm.priorities ?? DEFAULT_PRIORITIES);
  const fit = useCropFit(farm.id, undefined, irrigation, verified);

  const updating = advice.isFetching || (verified && fit.isFetching);
  const adviceData = !advice.isPlaceholderData && !advice.isError && !advice.isFetching ? advice.data : undefined;
  const fitData = verified && !fit.isPlaceholderData && !fit.isError && !fit.isFetching ? fit.data : undefined;
  const nextPicks: Pick[] = (adviceData?.options ?? []).map((option) => ({ id: option.id, source: "next", outcome: option, option }));
  const top = nextPicks.slice(0, 5);
  const seasonalPicks: Pick[] = (fitData?.crops ?? [])
    .map((crop): Pick => ({ id: crop.id, source: "seasonal", outcome: crop }))
    .sort((a, b) => cropName(catalog, a.id).localeCompare(cropName(catalog, b.id)));
  const unranked: Pick[] = [...(adviceData?.blocked ?? []), ...(adviceData?.unsuitable ?? [])]
    .map((outcome) => ({ id: outcome.id, source: "next", outcome }));
  const picks = [...nextPicks, ...unranked, ...seasonalPicks];
  const pick = !updating && placed ? picks.find((item) => item.id === placed.id && item.source === placed.source) ?? null : null;
  const matches = (item: Pick) => `${cropName(catalog, item.id)} ${item.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleTop = top.filter(matches);
  const visibleSeasonal = seasonalPicks.filter(matches);
  const period = pick?.source === "seasonal" ? fitData?.period : adviceData?.period;
  const carbonYears = (pick?.source === "seasonal" ? fitData?.carbon : adviceData?.carbon)?.years ?? null;

  const effective = soil.data?.effective;
  const depthAssumed = soil.data?.override?.depth_cm == null;
  const summary = soil.data && "layers" in soil.data.summary ? (soil.data.summary as SoilSummary) : null;
  const sky = climate.data ? skyOf(climate.data) : null;
  const season = adviceData ? `${t(`history.seasonName.${adviceData.season}`)} ${adviceData.season_year}` : "";
  const rootM = pick ? catalog?.species?.[pick.id]?.root_m : undefined;
  const zone = pick && effective && rootM != null ? rootZone(rootM, effective.depth_cm, effective.awc_mm_per_m) : null;
  const waterFraction = adviceData?.soil_now.fraction ?? climate.data?.soil_now?.fraction ?? null;
  const verdict = pick ? verdictOf(pick.outcome) : null;

  const place = (item: Pick) => {
    setPlaced({ id: item.id, source: item.source });
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1023px)").matches) {
        previewRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      }
    });
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (updating) return;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      const item = picks.find((candidate) => candidate.id === payload?.id && candidate.source === payload?.source);
      if (item) place(item);
    } catch {}
  };

  const sceneLabel = pick && zone
    ? t("field.sceneLabel", { crop: cropName(catalog, pick.id), root: zone.effectiveM.toFixed(1), soil: zone.soilM.toFixed(1), pct: percent(waterFraction) })
    : t("field.sceneEmpty", { soil: effective ? (effective.depth_cm / 100).toFixed(1) : "—", pct: percent(waterFraction) });

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-stone-900">{t("field.conditionsTitle")}</h2>
          <p className="text-sm text-stone-500">{t("field.conditionsSub")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PreviousTile advice={adviceData} previous={fitData?.previous} catalog={catalog} />
          {!verified || climate.isError ? (
            <Tile icon={<CloudRain className="size-3.5" aria-hidden="true" />} title={t("field.weather")}>
              <p className="text-sm text-stone-600">{t("field.weatherPending")}</p>
            </Tile>
          ) : sky ? <WeatherTile sky={sky} rain={climate.data?.current_season ? { mm: climate.data.current_season.rain_mm, median: climate.data.current_season.median_mm, percentile: climate.data.current_season.rain_percentile } : null} /> : <Tile icon={<CloudRain className="size-3.5" aria-hidden="true" />} title={t("field.weather")}><Spinner className="size-4" /></Tile>}
          {effective ? <SoilTile soil={effective} depthAssumed={depthAssumed} onOpenSoil={onOpenSoil} /> : <Tile icon={<Layers className="size-3.5" aria-hidden="true" />} title={t("field.soil")}><Spinner className="size-4" /></Tile>}
          {adviceData ? <WaterTile advice={adviceData} /> : <Tile icon={<Droplets className="size-3.5" aria-hidden="true" />} title={t("field.water")}>{advice.isError ? <span>{t("field.previewUnavailable")}</span> : <Spinner className="size-4" />}</Tile>}
        </div>
      </section>

      {(advice.error || (verified && fit.error)) && <Alert tone="error">{(advice.error ?? fit.error)?.message}</Alert>}

      <section className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <fieldset>
            <legend className="text-sm font-medium text-stone-800">{t("field.irrigation")}</legend>
            <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-stone-100 p-1">
              {IRRIGATIONS.map((key) => (
                <button key={key} type="button" aria-pressed={irrigation === key} onClick={() => setIrrigation(key)}
                  className={cx("break-words rounded-md px-2 py-1.5 text-xs font-medium transition", irrigation === key ? "bg-surface text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900")}>
                  {t(`farms.irrigation.${key}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={searchId} className="text-sm font-medium text-stone-800">{t("field.searchCrops")}</label>
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute top-3 left-3 size-4 text-stone-500" aria-hidden="true" />
              <input id={searchId} type="search" value={search} onChange={(event) => setSearch(event.target.value)}
                className="w-full min-w-0 rounded-lg border border-stone-300 bg-surface py-2 pr-3 pl-9 text-sm text-stone-900" />
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-stone-900">{t("field.trayTitle", { season })}</h2>
            <p className="text-sm text-stone-500">{t("field.nextSource")}</p>
          </div>
          {advice.isFetching || advice.isPending ? (
            <p className="flex items-center gap-2 text-sm text-stone-500"><Spinner className="size-4" />{t("field.loading")}</p>
          ) : advice.isError ? null : visibleTop.length ? (
            <ol className="space-y-2">
              {visibleTop.map((item) => (
                <CropCard key={item.id} pick={item} catalog={catalog} active={placed?.id === item.id && placed.source === item.source}
                  disabled={updating} previewId={previewId} onPlace={() => place(item)} />
              ))}
            </ol>
          ) : (
            <p className="text-sm text-amber-800">{t(top.length ? "field.noMatches" : "plan.noOptions")}</p>
          )}
          <details open={search.trim() ? true : undefined}>
            <summary className="cursor-pointer py-2 text-sm font-semibold text-stone-900">{t("field.browseCrops")}</summary>
            <p className="mb-3 text-xs text-stone-500">{t("field.seasonalSource")}</p>
            {!verified ? <p className="text-sm text-stone-500">{t("field.anyCropPending")}</p> : fit.isPending || fit.isFetching ? (
              <p className="flex items-center gap-2 text-sm text-stone-500"><Spinner className="size-4" />{t("field.loading")}</p>
            ) : fit.isError ? null : visibleSeasonal.length ? (
              <ul className="max-h-96 space-y-2 overflow-y-auto p-1">
                {visibleSeasonal.map((item) => (
                  <CropCard key={item.id} pick={item} catalog={catalog} active={placed?.id === item.id && placed.source === item.source}
                    disabled={updating} previewId={previewId} onPlace={() => place(item)} />
                ))}
              </ul>
            ) : <p className="text-sm text-stone-500">{t("field.noMatches")}</p>}
          </details>
        </div>

        <div id={previewId} ref={previewRef} className="min-w-0 scroll-mt-40 space-y-4 self-start lg:sticky lg:top-24" aria-busy={updating}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-stone-900">{t("field.previewTitle")}</h2>
            <Badge tone="stone">{t("field.unsaved")}</Badge>
          </div>
          <div role="status" aria-live="polite" className="text-sm text-stone-600">
            {updating ? <span className="inline-flex items-center gap-2"><Spinner className="size-4" />{t("field.updating")}</span>
              : pick ? `${cropName(catalog, pick.id)} · ${t(pick.source === "next" ? "field.nextSource" : "field.seasonalSource")}`
              : placed ? t("field.previewUnavailable") : t("field.choosePreview")}
          </div>
          <div
            onDragOver={(event) => {
              if (!updating && event.dataTransfer.types.includes(DRAG_TYPE)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setOver(true);
              }
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
            className={cx(
              "relative overflow-hidden rounded-xl border bg-surface transition",
              over ? "border-emerald-500 ring-2 ring-emerald-500/40" : "border-stone-200",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-2.5">
              <p className="min-w-0 truncate text-sm font-semibold text-stone-900">
                {farm.name}
                {pick && <span className={cx("ml-2 font-medium", verdict && VERDICT_TONE[verdict].text)}>· {cropName(catalog, pick.id)}</span>}
              </p>
              {placed && (
                <button type="button" onClick={() => setPlaced(null)} className="inline-flex items-center gap-1 text-xs font-medium text-stone-600 hover:text-stone-900">
                  <X className="size-3.5" aria-hidden="true" />
                  {t("field.clear")}
                </button>
              )}
            </div>
            {effective ? (
              <div className="overflow-x-auto"><div className="min-w-[620px]">
              <FieldScene
                soilDepthCm={effective.depth_cm}
                depthAssumed={depthAssumed}
                layers={summary?.layers ?? []}
                waterFraction={waterFraction}
                sky={sky}
                crop={pick && zone && verdict ? { key: `${pick.id}-${irrigation}`, verdict, zone, wilted: driesOut(pick.outcome) } : null}
                label={`${sceneLabel} ${t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}.`}
              />
              </div></div>
            ) : (
              <div className="flex h-72 items-center justify-center"><Spinner className="size-6 text-stone-400" /></div>
            )}
            {!placed && !updating && effective && (
              <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center px-4">
                <p className={cx("rounded-lg border border-dashed px-4 py-2 text-sm font-medium backdrop-blur-sm", over ? "border-emerald-500 bg-emerald-50/80 text-emerald-800" : "border-stone-400 bg-surface/80 text-stone-600")}>
                  {t(over ? "field.releasePreview" : "field.choosePreview")}
                </p>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-stone-500">{t("field.groundwaterNote")}</p>
          {pick && effective && (
            <Readout pick={pick} catalog={catalog} soil={effective} depthAssumed={depthAssumed} irrigation={irrigation} onIrrigation={setIrrigation}
              carbonYears={carbonYears} currency={adviceData?.economics.currency ?? catalog?.economics.currency ?? "INR"} />
          )}
          {period && (
            <p className="text-xs text-stone-500">
              {t("field.modelNote", { n: period.n_years, first: period.first_year, last: period.last_year })}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
