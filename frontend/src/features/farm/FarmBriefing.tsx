import { ChevronDown, CloudRain, Droplets, Sprout as SproutIcon, Target } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useCatalog, useClimate, useNextCrop, useSeasons, useSoil } from "../../api/hooks";
import type { Farm, SoilNow, Sources, SourceStatus } from "../../api/types";
import { SatelliteThumb } from "../../components/SatelliteThumb";
import { cx, Spinner } from "../../components/ui";
import { fullDate, inTenYears, mm, percent } from "../../lib/format";
import { cropName } from "../crops/text";
import { DEFAULT_PRIORITIES } from "../plan/parts";

/**
 * The farm's briefing: real satellite imagery of the field with the four facts that matter most
 * today (soil water, season rain, next-season outlook, last crop). It sits above every farm tab,
 * so those facts are not repeated inside the tabs. The panel is always dark, in both themes.
 */

const SOURCES = ["weather", "soil", "satellite"] as const;
const DOT: Record<SourceStatus, string> = {
  verified: "bg-[#4ade80]", ready: "bg-[#4ade80]", farmer: "bg-[#4ade80]", default: "bg-[#fbbf24]",
  partial: "bg-[#7dd3fc]", downloading: "bg-[#7dd3fc]", validating: "bg-[#7dd3fc]", pending: "bg-white/40",
  unverified: "bg-[#fbbf24]", needs_attention: "bg-[#f87171]", error: "bg-[#f87171]",
};
const BUSY = new Set<SourceStatus>(["partial", "downloading", "validating"]);

function SourceChips({ sources, plain = false }: { sources: Sources; plain?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const extra = (source: (typeof SOURCES)[number]) =>
    source === "weather"
      ? t("quality.progress", { done: sources.weather.years_done, total: sources.weather.years_total })
      : source === "satellite"
        ? t("quality.composites", { done: sources.satellite.done, total: sources.satellite.total })
        : null;
  return (
    <div data-tour-id="farm-readiness" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {SOURCES.map((source) => {
          const status = sources[source].status;
          const detail = extra(source);
          return (
            <span
              key={source}
              title={t(`quality.${status}`)}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs",
                plain ? "border border-stone-200 bg-surface text-stone-600" : "bg-black/35 text-white/75 ring-1 ring-white/15 backdrop-blur-sm",
              )}
            >
              {BUSY.has(status) ? <Spinner className={cx("size-3", plain ? "text-sky-600" : "text-[#7dd3fc]")} /> : <span className={cx("size-1.5 rounded-full", DOT[status])} aria-hidden="true" />}
              <span className={cx("font-semibold", plain ? "text-stone-800" : "text-white")}>{t(`quality.${source}`)}</span>
              {!plain && t(`quality.${status}`)}
              {detail && !plain && <span className="tabular text-white/60">· {detail}</span>}
            </span>
          );
        })}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium", plain ? "text-stone-500 hover:text-stone-800" : "text-white/70 hover:text-white")}
        >
          {t("farm.sourceDates")}
          <ChevronDown className={cx("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <dl className={cx("mt-3 grid max-w-3xl gap-4 rounded-xl p-4 text-xs sm:grid-cols-3", plain ? "border border-stone-200 bg-surface [&_dd]:text-stone-600 [&_dt]:text-stone-900" : "bg-black/55 ring-1 ring-white/15 backdrop-blur")}>
          {SOURCES.map((source) => {
            const value = sources[source];
            return (
              <div key={source} className="min-w-0 break-words">
                <dt className="text-sm font-semibold text-white">{t(`quality.${source}`)}</dt>
                <dd className="text-white/80">{t(`quality.${value.status}`)}</dd>
                {"through" in value && value.through && <dd className="text-white/60">{t("quality.through", { date: fullDate(value.through) })}</dd>}
                {value.updated_at && <dd className="text-white/60">{t("quality.checked", { date: fullDate(value.updated_at.slice(0, 10)) })}</dd>}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function Panel({ icon, label, accent, children, onClick }: {
  icon: ReactNode; label: string; accent: string; children: ReactNode; onClick?: () => void;
}) {
  const body = (
    <>
      <p className="flex items-center gap-2 text-[11px] font-medium text-white/70">
        <span className={cx("flex size-5 items-center justify-center rounded-md", accent)}>{icon}</span>
        <span className="truncate">{label}</span>
      </p>
      <div className="mt-2">{children}</div>
    </>
  );
  const frame = "min-w-0 rounded-xl bg-white/[0.07] px-3.5 py-3 text-left ring-1 ring-white/12 backdrop-blur-md";
  return onClick ? (
    <button type="button" onClick={onClick} className={cx(frame, "transition-colors hover:bg-white/[0.12]")}>{body}</button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/** Soil water as a ring: full circle = root zone at capacity. */
function Ring({ value }: { value: number | null }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const share = value == null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <svg viewBox="0 0 64 64" className="size-12 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(255 255 255 / 0.14)" strokeWidth="7" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="#5cc8f5" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${share * c} ${c}`} />
    </svg>
  );
}

function Big({ children, tone = "text-white" }: { children: ReactNode; tone?: string }) {
  return <p className={cx("tabular text-lg font-semibold leading-tight tracking-tight", tone)}>{children}</p>;
}
const Caption = ({ children }: { children: ReactNode }) => <p className="mt-1 text-xs leading-snug text-white/65">{children}</p>;
const Missing = () => <p className="text-lg font-semibold text-white/40">—</p>;

/** The slim header used on every tab except the farm's home tab. */
function FarmBar({ farm, sources, status, actions }: { farm: Farm; sources?: Sources; status: ReactNode; actions: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-stone-200 bg-surface p-3 pr-4">
      <SatelliteThumb
        lat={farm.lat}
        lon={farm.lon}
        boundary={farm.boundary}
        zoom={15}
        label={t("farm.satelliteAlt", { name: farm.name })}
        className="h-14 w-20 shrink-0 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 data-tour-id="farm-heading" className="break-words text-lg font-semibold tracking-tight text-stone-900">{farm.name}</h1>
          {status}
        </div>
        <p className="tabular mt-0.5 text-xs text-stone-500">
          {farm.lat.toFixed(3)}°, {farm.lon.toFixed(3)}°
          {farm.area_ha != null && <> · {t("farms.hectares", { value: farm.area_ha })}</>} · {t(`farms.irrigation.${farm.irrigation}`)}
        </p>
      </div>
      {sources && <SourceChips sources={sources} plain />}
      <div className="flex items-center gap-2">{actions}</div>
    </section>
  );
}

export function FarmBriefing({ compact = false, ...props }: Parameters<typeof Briefing>[0] & { compact?: boolean }) {
  return compact ? <FarmBar farm={props.farm} sources={props.sources} status={props.status} actions={props.actions} /> : <Briefing {...props} />;
}

function Briefing({ farm, sources, verified, adviceAvailable, status, actions, onOpenHistory, onOpenPlan }: {
  farm: Farm;
  sources?: Sources;
  verified: boolean;
  adviceAvailable: boolean;
  status: ReactNode;
  actions: ReactNode;
  onOpenHistory: () => void;
  onOpenPlan: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const pack = farm.region === "IN";
  const climate = useClimate(farm.id, verified);
  const soil = useSoil(farm.id, true);
  const seasons = useSeasons(farm.id);
  const advice = useNextCrop(farm.id, undefined, farm.irrigation, farm.priorities ?? DEFAULT_PRIORITIES, pack && adviceAvailable);
  const adviceData = advice.isError ? undefined : advice.data;

  const now: SoilNow | null = adviceData?.soil_now ?? climate.data?.soil_now ?? null;
  const rain = climate.data?.current_season;
  const top = adviceData?.options[0];
  const inField = adviceData?.in_field;
  const last = [...(seasons.data ?? [])].sort((a, b) => b.sow_date.localeCompare(a.sow_date))[0];
  const assumed = now?.assumed[0];
  const effective = soil.data?.effective;
  const rainShare = rain && rain.median_mm > 0 ? rain.rain_mm / rain.median_mm - 1 : null;

  return (
    <section className="farm-hero relative isolate overflow-hidden rounded-2xl bg-[#0b1d18] text-white ring-1 ring-black/10">
      {/* Deep field-green base, a cool light from the top right and a faint warm earth glow bottom left. */}
      <div
        className="absolute inset-0 -z-10"
        aria-hidden="true"
        style={{
          background: [
            "radial-gradient(70% 140% at 100% 0%, rgba(45, 212, 191, 0.20) 0%, rgba(45, 212, 191, 0) 60%)",
            "radial-gradient(55% 120% at 0% 100%, rgba(217, 160, 82, 0.16) 0%, rgba(217, 160, 82, 0) 65%)",
            "linear-gradient(120deg, #0a1915 0%, #0f2a22 45%, #123a2f 75%, #0e2b26 100%)",
          ].join(", "),
        }}
      />
      {/* Fine crop-row lines fading in towards the right edge. */}
      <div
        className="absolute inset-0 -z-10 opacity-[0.07]"
        aria-hidden="true"
        style={{
          backgroundImage: "repeating-linear-gradient(115deg, #ffffff 0 1px, transparent 1px 14px)",
          maskImage: "linear-gradient(90deg, transparent 35%, #000 100%)",
          WebkitMaskImage: "linear-gradient(90deg, transparent 35%, #000 100%)",
        }}
      />
      <div className="absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" aria-hidden="true" />

      <div className="p-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.18em] text-[#6ee7b7] uppercase">{t("briefing.kicker")}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <h1 data-tour-id="farm-heading" className="break-words text-2xl font-semibold tracking-tight text-white">{farm.name}</h1>
              {status}
            </div>
            <p className="tabular mt-1.5 text-sm text-white/70">
              {farm.lat.toFixed(3)}°, {farm.lon.toFixed(3)}°
              {farm.area_ha != null && <> · {t("farms.hectares", { value: farm.area_ha })}</>} · {t(`farms.irrigation.${farm.irrigation}`)}
              {effective?.texture && <> · {t(`soil.textureName.${effective.texture}`, { defaultValue: effective.texture })}</>}
              {" "}· {t("farm.cell", { cell: farm.cell_id })}
            </p>
          </div>
          <div className="flex items-center gap-2">{actions}</div>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <Panel icon={<Droplets className="size-3.5" aria-hidden="true" />} label={t("field.water")} accent="bg-sky-400/20 text-[#7dd3fc]">
            {now ? (
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Ring value={now.fraction} />
                  <span className="tabular absolute inset-0 flex items-center justify-center text-xs font-semibold">{percent(now.fraction)}</span>
                </div>
                <div className="min-w-0">
                  <p className="tabular text-sm font-semibold">{t("soilNow.stored", { mm: mm(now.mm), capacity: mm(now.capacity_mm) })}</p>
                  <Caption>
                    {now.percentile < 0.5 ? t("plan.drierThan", { pct: percent(1 - now.percentile) }) : t("plan.wetterThan", { pct: percent(now.percentile) })}
                  </Caption>
                  {adviceData?.weather_context.mode === "historical_proxy" && <p className="mt-1 text-[11px] text-[#f6cf8a]">{t("quality.scenarioSoil")}</p>}
                  {assumed ? (
                    <button
                      type="button"
                      onClick={onOpenHistory}
                      title={t("soilNow.assumed", { season: t(`history.seasonName.${assumed.season}`), year: assumed.season_year, crop: cropName(catalog, assumed.crop) })}
                      className="mt-1 text-left text-[11px] text-[#f6cf8a] underline-offset-2 hover:underline"
                    >
                      {t("briefing.assumes", { crop: cropName(catalog, assumed.crop), season: t(`history.seasonName.${assumed.season}`), year: assumed.season_year })}
                    </button>
                  ) : (
                    <p className="mt-1 line-clamp-2 text-[11px] text-white/55">
                      {now.recorded_fallow ? t("quality.fallow") : now.replayed.length === 0 ? t("soilNow.bare", { date: fullDate(now.since) }) : t("soilNow.journal")}
                    </p>
                  )}
                </div>
              </div>
            ) : <Missing />}
          </Panel>

          <Panel icon={<CloudRain className="size-3.5" aria-hidden="true" />} label={rain ? t("climate.rainSince", { date: fullDate(rain.start) }) : t("field.weather")} accent="bg-blue-400/20 text-[#a5c8ff]">
            {rain ? (
              <>
                <Big>{mm(rain.rain_mm)}</Big>
                <div className="mt-2 space-y-1" aria-hidden="true">
                  <div className="h-1.5 rounded-full bg-white/12">
                    <div className={cx("h-full rounded-full", (rainShare ?? 0) < 0 ? "bg-[#f2b25c]" : "bg-[#5cc8f5]")} style={{ width: `${Math.min(1, rain.rain_mm / Math.max(rain.rain_mm, rain.median_mm, 1)) * 100}%` }} />
                  </div>
                  <div className="h-1.5 rounded-full bg-white/12">
                    <div className="h-full rounded-full bg-white/45" style={{ width: `${Math.min(1, rain.median_mm / Math.max(rain.rain_mm, rain.median_mm, 1)) * 100}%` }} />
                  </div>
                </div>
                <Caption>
                  <span className={cx("font-semibold", (rainShare ?? 0) < 0 ? "text-[#f2c27c]" : "text-[#8fdcff]")}>
                    {rainShare != null && t(rainShare < 0 ? "briefing.below" : "briefing.above", { pct: percent(Math.abs(rainShare)) })}
                  </span>{" "}
                  {t("briefing.typical", { mm: mm(rain.median_mm) })}
                </Caption>
              </>
            ) : verified && climate.isPending ? <Spinner className="size-5 text-white/60" /> : <Missing />}
          </Panel>

          {pack ? (
            <Panel
              icon={<Target className="size-3.5" aria-hidden="true" />}
              label={adviceData ? t("briefing.outlook", { season: t(`history.seasonName.${adviceData.season}`), year: adviceData.season_year }) : t("briefing.outlookPlain")}
              accent="bg-emerald-400/20 text-[#86efac]"
              onClick={adviceAvailable ? onOpenPlan : undefined}
            >
              {top ? (
                <>
                  <p className="text-[11px] font-medium text-white/60">{t("briefing.bestBet")}</p>
                  <Big>{cropName(catalog, top.id)}</Big>
                  <Caption>
                    {t("briefing.fails", { odds: inTenYears(top.yield.failure) })} · {t("farm.summarySow", { date: fullDate(top.sowing.best) })}
                  </Caption>
                </>
              ) : adviceData ? (
                <>
                  <Big tone="text-[#f2c27c]">{t("field.noTopTitle")}</Big>
                  <Caption>{t("briefing.hardSeason")}</Caption>
                </>
              ) : advice.isFetching ? <Spinner className="size-5 text-white/60" /> : <Missing />}
            </Panel>
          ) : (
            <Panel icon={<Target className="size-3.5" aria-hidden="true" />} label={t("climate.aridity")} accent="bg-emerald-400/20 text-[#86efac]">
              {climate.data ? (
                <>
                  <Big>{t(`climate.aridityClass.${climate.data.aridity.class as "arid"}`)}</Big>
                  <Caption>{t("climate.aridityDetail", { pct: percent(climate.data.aridity.index), et0: mm(climate.data.aridity.et0_mm) })}</Caption>
                </>
              ) : <Missing />}
            </Panel>
          )}

          <Panel icon={<SproutIcon className="size-3.5" aria-hidden="true" />} label={t(inField ? "field.inField" : "field.previous")} accent="bg-lime-400/20 text-[#bef264]">
            {inField ? (
              <>
                <Big>{cropName(catalog, inField.crop)}</Big>
                <Caption>{t("field.harvestBy", { date: fullDate(inField.expected_harvest) })}</Caption>
              </>
            ) : last ? (
              <>
                <Big>{last.crops.map((id) => cropName(catalog, id)).join(" + ") || t("plan.fallow")}</Big>
                <Caption>{t(`history.seasonName.${last.season}`)} {last.season_year}</Caption>
              </>
            ) : (
              <>
                <Big tone="text-white/80">{t("field.noPrevious")}</Big>
                <button type="button" onClick={onOpenHistory} className="mt-1 text-xs font-medium text-[#86efac] hover:underline">
                  {t("field.logIt")}
                </button>
              </>
            )}
          </Panel>
        </div>

        {sources && <div className="mt-4"><SourceChips sources={sources} /></div>}
      </div>
    </section>
  );
}

export function BackToFarms() {
  const { t } = useTranslation();
  return (
    <Link to="/" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
      ← {t("common.back")}
    </Link>
  );
}
