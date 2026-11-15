import { GripVertical, Search, Sprout as SproutIcon, X } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useClimate, useCropFit, useNextCrop, useSoil } from "../../api/hooks";
import type { Catalog, CropOutcome, EffectiveSoil, Farm, Irrigation, NextCropOption, SoilSummary } from "../../api/types";
import { AboutData, Alert, Badge, cx, DotScale, Segmented, Spinner } from "../../components/ui";
import { fullDate, mm, money, percent, signed } from "../../lib/format";
import { cropName, familyName, ruleText, yieldText } from "../crops/text";
import { DEFAULT_PRIORITIES } from "../plan/parts";
import { FieldScene } from "./FieldScene";
import { driesOut, rootZone, skyOf, verdictOf, VERDICT_TONE } from "./model";

const IRRIGATIONS: Irrigation[] = ["rainfed", "protective", "full"];
const DRAG_TYPE = "application/x-cropcompass-crop";

const VERDICT_EDGE = { good: "border-t-emerald-500", watch: "border-t-amber-500", poor: "border-t-red-500", blocked: "border-t-red-500" } as const;

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
        data-tour-id={pick.option?.rank === 1 ? "field-crops" : undefined}
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
      <p className="text-sm font-semibold text-stone-900">{t("field.balanceTitle")}</p>
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

function Readout({ pick, catalog, soil, irrigation, onIrrigation, carbonYears, currency }: {
  pick: Pick;
  catalog?: Catalog;
  soil: EffectiveSoil;
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
  if (heat && heat.p != null && heat.p > 0 && outcome.heat.threshold_c != null) {
    why.push(t("field.whyHeat", { c: outcome.heat.threshold_c, k: heat.k, n: heat.n }));
  }
  for (const rule of outcome.rules) why.push(ruleText(t, rule, catalog));

  const help: { text: string; action?: ReactNode; general?: boolean }[] = [];
  const nextIrrigation = IRRIGATIONS[IRRIGATIONS.indexOf(irrigation) + 1];
  if (driesOut(outcome) && nextIrrigation) {
    help.push({
      text: "",
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

  const name = cropName(catalog, pick.id);
  const info = catalog?.crops.find((crop) => crop.id === pick.id);
  const family = info?.family ? familyName(catalog, info.family) : null;
  const profile = [
    family,
    info && t("field.briefDays", { min: info.duration_days[0], max: info.duration_days[1] }),
    rootM != null && t("field.briefRoots", { value: rootM.toFixed(1) }),
  ].filter(Boolean).join(" · ");
  const limit = verdict === "blocked" && outcome.rules[0]
    ? ruleText(t, outcome.rules[0], catalog)
    : driesOut(outcome)
      ? t("field.briefLimitWater")
      : heat && heat.p != null && heat.p > 0.2
        ? t("field.briefLimitHeat")
        : verdict === "good" ? t("field.briefLimitNone") : null;
  const brief = [t(`field.brief.${verdict}`, { crop: name }), limit].filter(Boolean).join(" ");
  const shown = new Set([limit]);
  const reasons = why.filter((line) => !shown.has(line));
  const failShare = fail.n ? fail.k / fail.n : null;

  return (
    <section className={cx("overflow-hidden rounded-2xl border border-t-4 border-stone-200 bg-surface", VERDICT_EDGE[verdict])} aria-live="polite">
      <div className="border-b border-stone-200 px-5 pt-5 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xl font-semibold tracking-tight text-stone-900">{t("field.reportTitle", { crop: name })}</h3>
          <Badge tone={VERDICT_TONE[verdict].badge}>{t(`field.verdict.${verdict}`)}</Badge>
          {pick.option && <span className="text-xs text-stone-500">{t("field.rank", { rank: pick.option.rank })}</span>}
        </div>
        {profile && <p className="mt-1 text-xs text-stone-500">{profile}</p>}
        <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-stone-800">{brief}</p>
      </div>

      <dl className="grid grid-cols-2 divide-stone-200 border-b border-stone-200 sm:grid-cols-4 sm:divide-x">
        <div className="px-5 py-4">
          <dt className="text-xs font-medium text-stone-500">{t("field.mYield")}</dt>
          <dd className="tabular mt-1 text-lg font-semibold text-stone-900">{yieldText(t, outcome.yield.p50)}</dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-xs font-medium text-stone-500">{t("field.mIncome")}</dt>
          <dd className={cx("tabular mt-1 text-lg font-semibold", (outcome.income.mean ?? 0) < 0 ? "text-red-700" : "text-stone-900")}>{money(outcome.income.mean, currency)}</dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-xs font-medium text-stone-500">{t("field.mFail")}</dt>
          <dd className="tabular mt-1 text-lg font-semibold text-stone-900">{fail.n ? `${fail.k} / ${fail.n}` : "—"}</dd>
          {failShare != null && <dd className="mt-1.5"><DotScale p={failShare} tone={failShare > 0.3 ? "warn" : "good"} /></dd>}
        </div>
        <div className="px-5 py-4">
          <dt className="text-xs font-medium text-stone-500">{t("field.mIrrigation")}</dt>
          <dd className="tabular mt-1 text-lg font-semibold text-stone-900">{outcome.water.irrigations ? `${outcome.water.irrigations} × · ${mm(outcome.water.irrigation_mm)}` : "—"}</dd>
        </div>
      </dl>

      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-5">
          <WaterBalance outcome={outcome} />
          {reasons.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-stone-900">{t("field.why")}</p>
              <ul className="mt-2 space-y-1.5 text-sm text-stone-700">
                {reasons.map((line) => (
                  <li key={line} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-stone-400" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-semibold text-stone-900">{t("field.helpTitle")}</p>
          {help.length ? (
            <ol className="mt-2 space-y-2 text-sm text-stone-700">
              {help.map((item, index) => (
                <li key={index} className="flex gap-3 rounded-lg bg-stone-100/70 px-3 py-2.5">
                  <span className="tabular pt-px text-xs font-semibold text-emerald-700">{index + 1}</span>
                  <span className="min-w-0">
                    {item.text}
                    {item.general && <span className="text-stone-500"> {t("field.general")}</span>}
                    {item.action && <span className={cx(item.text && "mt-1", "block")}>{item.action}</span>}
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
export function FieldPanel({ farm, verified }: { farm: Farm; verified: boolean }) {
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
      {(advice.error || (verified && fit.error)) && <Alert tone="error">{(advice.error ?? fit.error)?.message}</Alert>}

      <section className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <div>
            <p className="text-sm font-medium text-stone-800">{t("field.irrigation")}</p>
            <Segmented
              className="mt-1.5 flex w-full"
              label={t("field.irrigation")}
              value={irrigation}
              onChange={setIrrigation}
              items={IRRIGATIONS.map((key) => ({ key, label: t(`field.irrigationShort.${key}`), title: t(`farms.irrigation.${key}`) }))}
            />
          </div>
          <div>
            <label htmlFor={searchId} data-tour-id="field-search" className="text-sm font-medium text-stone-800">{t("field.searchCrops")}</label>
            <div className="relative mt-1.5">
              <Search className="pointer-events-none absolute top-3 left-3 size-4 text-stone-500" aria-hidden="true" />
              <input id={searchId} type="search" value={search} onChange={(event) => setSearch(event.target.value)}
                className="w-full min-w-0 rounded-lg border border-stone-300 bg-surface py-2 pr-3 pl-9 text-sm text-stone-900" />
            </div>
          </div>
          <div className="border-t border-stone-200 pt-5">
            <h2 className="text-base font-semibold text-stone-900">{t("field.trayTitle", { season })}</h2>
            <p className="mt-0.5 text-xs text-stone-500">{t("field.nextSource")}</p>
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
          ) : top.length ? (
            <p className="text-sm text-stone-500">{t("field.noMatches")}</p>
          ) : (
            <div className="rounded-xl border border-dashed border-amber-500/50 bg-amber-50 px-4 py-3">
              <p className="text-sm font-semibold text-amber-900">{t("field.noTopTitle")}</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-900/80">{t("field.noTopHint")}</p>
            </div>
          )}
          <details open={search.trim() ? true : undefined}>
            <summary className="cursor-pointer rounded-md py-2 text-sm font-semibold text-emerald-700 hover:text-emerald-800">{t("field.browseCrops")}</summary>
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

        <div id={previewId} ref={previewRef} className="min-w-0 scroll-mt-40 space-y-4 self-start" aria-busy={updating}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-stone-900">{t("field.previewTitle")}</h2>
              <div role="status" aria-live="polite" className="mt-0.5 text-xs text-stone-500">
                {updating ? <span className="inline-flex items-center gap-2"><Spinner className="size-3.5" />{t("field.updating")}</span>
                  : pick ? `${cropName(catalog, pick.id)} · ${t(pick.source === "next" ? "field.nextSource" : "field.seasonalSource")}`
                  : placed ? t("field.previewUnavailable") : t("field.dropHint")}
              </div>
            </div>
            <Badge tone="stone">{t("field.unsaved")}</Badge>
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
            {over && !updating && effective && (
              <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center px-4">
                <p className="rounded-lg border border-dashed border-emerald-500 bg-emerald-50/80 px-4 py-2 text-sm font-medium text-emerald-800 backdrop-blur-sm">
                  {t("field.releasePreview")}
                </p>
              </div>
            )}
          </div>
          {pick && effective && (
            <Readout pick={pick} catalog={catalog} soil={effective} irrigation={irrigation} onIrrigation={setIrrigation}
              carbonYears={carbonYears} currency={adviceData?.economics.currency ?? catalog?.economics.currency ?? "INR"} />
          )}
          <AboutData>
            <p>{t("field.groundwaterNote")}</p>
            <p>{t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}. {depthAssumed && t("soil.depthAssumptionNote")}</p>
            {period && <p>{t("field.modelNote", { n: period.n_years, first: period.first_year, last: period.last_year })}</p>}
          </AboutData>
        </div>
      </section>
    </div>
  );
}
