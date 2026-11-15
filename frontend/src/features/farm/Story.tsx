import { ArrowRight, BookOpen, ChevronRight, CloudRain, History, Layers, Target } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useClimate, useSeasons, useSoil } from "../../api/hooks";
import type { Farm, NextCropAdvice, Priorities, SoilNow } from "../../api/types";
import { Badge, cx } from "../../components/ui";
import { fullDate, inTenYears, mm, percent } from "../../lib/format";
import { cropName } from "../crops/text";
import { PILLARS } from "../plan/parts";

/**
 * The farm page reads as a story: try crops on the field, look at the evidence (climate, soil,
 * crop history), and arrive at the season plan. Crop fit sits apart as the reference for every crop.
 */

export type StoryTab = "field" | "climate" | "soil" | "history" | "plan" | "crops";
type Group = "try" | "evidence" | "result" | "reference";

const GROUPS: { key: Group; tabs: StoryTab[] }[] = [
  { key: "try", tabs: ["field"] },
  { key: "evidence", tabs: ["climate", "soil", "history"] },
  { key: "result", tabs: ["plan"] },
  { key: "reference", tabs: ["crops"] },
];
export const STORY_ORDER: StoryTab[] = GROUPS.flatMap((group) => group.tabs);
const EVIDENCE: StoryTab[] = ["climate", "soil", "history"];

/** Chapter numbers for the tabs this farm has; the reference tab is not numbered. */
function numbering(available: StoryTab[]): Partial<Record<StoryTab, number>> {
  const numbers: Partial<Record<StoryTab, number>> = {};
  STORY_ORDER.filter((tab) => tab !== "crops" && available.includes(tab)).forEach((tab, index) => { numbers[tab] = index + 1; });
  return numbers;
}

/** The chapter bar: grouped, numbered tabs that read left to right towards the plan. */
export function StoryNav({ available, value, onChange, label }: {
  available: StoryTab[];
  value: StoryTab;
  onChange: (tab: StoryTab) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const numbers = numbering(available);
  const groups = GROUPS.map((group) => ({ ...group, tabs: group.tabs.filter((tab) => available.includes(tab)) })).filter((group) => group.tabs.length);
  return (
    <div role="tablist" aria-label={label} className="flex max-w-full items-end gap-1 overflow-x-auto border-b border-stone-200 pt-2">
      {groups.map((group, index) => (
        <Fragment key={group.key}>
          {index > 0 && group.key !== "reference" && <ChevronRight className="mb-3 size-4 shrink-0 text-stone-300" aria-hidden="true" />}
          <div className={cx("shrink-0", group.key === "reference" && "ml-auto border-l border-stone-200 pl-2")}>
            <p className="flex items-center gap-2 px-3 text-[10px] font-semibold tracking-[0.14em] text-stone-400 uppercase">
              {t(`story.group.${group.key}`)}
              {group.tabs.length > 1 && <span className="h-px flex-1 bg-stone-200" aria-hidden="true" />}
            </p>
            <div className="flex">
              {group.tabs.map((tab) => {
                const active = tab === value;
                const result = tab === "plan";
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-tour-id={`farm-tab-${tab}`}
                    onClick={() => onChange(tab)}
                    className={cx(
                      "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                      active ? "border-emerald-600 text-stone-900" : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800",
                      result && !active && "text-emerald-700 hover:text-emerald-800",
                    )}
                  >
                    {tab === "crops" ? (
                      <BookOpen className={cx("size-4", active ? "text-emerald-600" : "text-stone-400")} aria-hidden="true" />
                    ) : (
                      <span
                        className={cx(
                          "tabular flex size-5 items-center justify-center rounded-full text-[11px] font-semibold",
                          active ? "bg-emerald-600 text-white" : result ? "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-600/40" : "bg-stone-200 text-stone-600",
                        )}
                      >
                        {numbers[tab]}
                      </span>
                    )}
                    {t(`farm.tabs.${tab}`)}
                  </button>
                );
              })}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** The opening of a chapter: where it sits in the story, the question it answers, and a one-line lead. */
export function ChapterIntro({ tab, available, onOpen }: { tab: StoryTab; available: StoryTab[]; onOpen: (tab: StoryTab) => void }) {
  const { t } = useTranslation();
  const evidence = EVIDENCE.filter((key) => available.includes(key));
  const step = evidence.indexOf(tab);
  const group: Group = GROUPS.find((item) => item.tabs.includes(tab))!.key;
  const number = numbering(available)[tab];
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-stone-200 pb-6">
      <div className="max-w-3xl">
        <p className="text-[11px] font-semibold tracking-[0.16em] text-emerald-700 uppercase">
          {number ? `${t("story.chapter", { n: number })} · ` : ""}{t(`story.group.${group}`)}
        </p>
        <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-stone-900">{t(`story.intro.${tab as Exclude<StoryTab, "field">}.title`)}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{t(`story.intro.${tab as Exclude<StoryTab, "field">}.lead`)}</p>
      </div>
      {step >= 0 && (
        <div className="flex items-center gap-4">
          <div>
            <p className="text-[11px] text-stone-500">{t("story.evidenceStep", { n: step + 1, total: evidence.length })}</p>
            <div className="mt-1.5 flex gap-1" aria-hidden="true">
              {evidence.map((key, index) => (
                <span key={key} className={cx("h-1.5 w-8 rounded-full", index <= step ? "bg-emerald-600" : "bg-stone-200")} />
              ))}
            </div>
          </div>
          {available.includes("plan") && (
            <button type="button" onClick={() => onOpen("plan")} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/30 hover:bg-emerald-500/15">
              {t("story.feedsPlan")}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </header>
  );
}

type Tone = "warn" | "good" | "info";
/** "Almost every year" reads mid-sentence as "almost every year". */
const inline = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
type Takeaway = { tone: Tone; text: string };
const TONE_DOT: Record<Tone, string> = { warn: "bg-amber-500", good: "bg-emerald-500", info: "bg-sky-500" };

/** Season names for records, which may also say "other". */
function useSeasonName() {
  const { t } = useTranslation();
  return (season: string) => t(`history.seasonName.${season as "kharif"}`, { defaultValue: season });
}

/** What each evidence chapter adds to the plan, worded from the farm's own numbers. */
function useTakeaways(tab: StoryTab, farm: Farm, verified: boolean): Takeaway[] {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const climate = useClimate(farm.id, verified && (tab === "climate" || tab === "soil" || tab === "history")).data;
  const soil = useSoil(farm.id, tab === "soil").data;
  const seasons = useSeasons(farm.id).data;
  const seasonOf = useSeasonName();
  const items: Takeaway[] = [];

  if (tab === "climate" && climate) {
    const season = climate.current_season;
    if (season && season.median_mm > 0) {
      const share = season.rain_mm / season.median_mm - 1;
      const date = fullDate(season.start);
      if (share <= -0.15) items.push({ tone: "warn", text: t("story.take.rainBelow", { date, pct: percent(-share) }) });
      else if (share >= 0.15) items.push({ tone: "good", text: t("story.take.rainAbove", { date, pct: percent(share) }) });
      else items.push({ tone: "info", text: t("story.take.rainNormal", { date }) });
    }
    const monsoon = climate.monsoon;
    if (monsoon && (monsoon.rabi_terminal_heat.p ?? 0) >= 0.3) items.push({ tone: "warn", text: t("story.take.heat", { odds: inline(inTenYears(monsoon.rabi_terminal_heat)) }) });
    if (monsoon && (monsoon.dry_spells_jul_sep.ge_14d.p ?? 0) >= 0.2) items.push({ tone: "warn", text: t("story.take.drySpell", { odds: inline(inTenYears(monsoon.dry_spells_jul_sep.ge_14d)) }) });
    items.push({
      tone: "info",
      text: t("story.take.aridity", { pct: percent(climate.aridity.index), class: t(`climate.aridityClass.${climate.aridity.class as "arid"}`).toLowerCase() }),
    });
  }

  if (tab === "soil") {
    const now = climate?.soil_now;
    if (now) {
      items.push({
        tone: now.fraction < 0.35 ? "warn" : now.fraction > 0.65 ? "good" : "info",
        text: t("story.take.soilNow", { pct: percent(now.fraction), mm: mm(now.mm), capacity: mm(now.capacity_mm) }),
      });
    }
    const effective = soil?.effective;
    if (effective) {
      const texture = effective.texture ? t(`soil.textureName.${effective.texture as "loam"}`, { defaultValue: effective.texture }) : null;
      items.push({
        tone: "info",
        text: texture
          ? t("story.take.soilHolds", { texture, awc: mm(effective.awc_mm), depth: effective.depth_cm })
          : t("story.take.soilHoldsPlain", { awc: mm(effective.awc_mm), depth: effective.depth_cm }),
      });
      if (effective.source === "default") items.push({ tone: "warn", text: t("story.take.soilDefault") });
    }
  }

  if (tab === "history") {
    const last = [...(seasons ?? [])].filter((row) => row.status !== "planned").sort((a, b) => b.sow_date.localeCompare(a.sow_date))[0];
    const assumed = climate?.soil_now?.assumed[0];
    if (last) {
      items.push({
        tone: "good",
        text: t("story.take.lastCrop", {
          crop: last.crops.map((id) => cropName(catalog, id)).join(" + "),
          season: seasonOf(last.season),
          year: last.season_year,
        }),
      });
    } else if (assumed) {
      items.push({ tone: "warn", text: t("story.take.assumed", { crop: cropName(catalog, assumed.crop), season: seasonOf(assumed.season), year: assumed.season_year }) });
    } else if (seasons) {
      items.push({ tone: "warn", text: t("story.take.noRecords") });
    }
    items.push({ tone: "info", text: t("story.take.soilFromHistory") });
  }
  return items;
}

function NextButton({ label, detail, primary = false, onClick }: { label: string; detail?: string; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-colors",
        primary ? "bg-brand text-white shadow-sm hover:bg-brand-strong" : "bg-surface text-stone-900 ring-1 ring-stone-300 hover:bg-stone-100",
      )}
    >
      <span className="min-w-0">
        {detail && <span className={cx("block text-[11px]", primary ? "text-white/75" : "text-stone-500")}>{detail}</span>}
        <span className="block text-sm font-semibold">{label}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  );
}

/** The close of a chapter: what it means for the plan, and where the story goes next. */
export function ChapterEnd({ tab, farm, verified, available, onOpen }: {
  tab: StoryTab;
  farm: Farm;
  verified: boolean;
  available: StoryTab[];
  onOpen: (tab: StoryTab) => void;
}) {
  const { t } = useTranslation();
  const takeaways = useTakeaways(tab, farm, verified);
  const numbers = numbering(available);
  const hasPlan = available.includes("plan");
  const chapters = STORY_ORDER.filter((key) => key !== "crops" && available.includes(key));
  const next = chapters[chapters.indexOf(tab) + 1];
  const evidence = EVIDENCE.includes(tab);

  let lead: ReactNode;
  let actions: ReactNode = null;
  if (evidence) {
    lead = takeaways.length > 0 && (
      <>
        <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-500 uppercase">{t("story.takeaway")}</p>
        <ul className="mt-3 space-y-2.5">
          {takeaways.map((item) => (
            <li key={item.text} className="flex gap-3 text-sm leading-relaxed text-stone-700">
              <span className={cx("mt-[7px] size-2 shrink-0 rounded-full", TONE_DOT[item.tone])} aria-hidden="true" />
              {item.text}
            </li>
          ))}
        </ul>
      </>
    );
    if (next === "plan") actions = <NextButton primary label={t("story.toPlan")} detail={t("story.allEvidence")} onClick={() => onOpen("plan")} />;
    else if (next) {
      actions = (
        <>
          <NextButton label={t(`farm.tabs.${next}`)} detail={t("story.nextChapter", { n: numbers[next] })} onClick={() => onOpen(next)} />
          {hasPlan && <button type="button" onClick={() => onOpen("plan")} className="text-xs font-medium text-emerald-700 hover:text-emerald-800">{t("story.skipToPlan")} →</button>}
        </>
      );
    }
  } else if (tab === "field") {
    lead = (
      <>
        <p className="text-base font-semibold text-stone-900">{t("story.fieldEndTitle")}</p>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-600">{t("story.fieldEndText")}</p>
      </>
    );
    if (next) {
      actions = (
        <>
          <NextButton primary label={t(`farm.tabs.${next}`)} detail={t("story.startEvidence")} onClick={() => onOpen(next)} />
          {hasPlan && <button type="button" onClick={() => onOpen("plan")} className="text-xs font-medium text-emerald-700 hover:text-emerald-800">{t("story.skipToPlan")} →</button>}
        </>
      );
    }
  } else if (tab === "plan") {
    lead = <p className="text-sm leading-relaxed text-stone-600">{t("story.planEndText")}</p>;
    if (available.includes("crops")) actions = <NextButton label={t("story.openGuide")} detail={t("story.group.reference")} onClick={() => onOpen("crops")} />;
  } else if (tab === "crops") {
    lead = <p className="text-sm leading-relaxed text-stone-600">{t("story.cropsEndText")}</p>;
    if (hasPlan) actions = <NextButton primary label={t("story.backToPlan")} onClick={() => onOpen("plan")} />;
  }

  if (!lead && !actions) return null;
  return (
    <section className="no-print mt-12 overflow-hidden rounded-2xl border border-stone-200 bg-surface">
      <div className={cx("grid", actions && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="p-5 sm:p-6">{lead}</div>
        {actions && (
          <div className="flex flex-col justify-center gap-2.5 border-t border-stone-200 bg-stone-50 p-5 lg:border-t-0 lg:border-l">
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- The plan's evidence pipeline ---------- */

function EvidenceNode({ icon, accent, chapter, value, caption, onClick }: {
  icon: ReactNode;
  accent: string;
  chapter: string;
  value: ReactNode;
  caption?: ReactNode;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const body = (
    <>
      <p className="flex items-center gap-2 text-xs font-medium text-stone-500">
        <span className={cx("flex size-6 items-center justify-center rounded-md", accent)}>{icon}</span>
        <span className="truncate">{chapter}</span>
      </p>
      <p className="tabular mt-2.5 text-lg leading-tight font-semibold tracking-tight text-stone-900">{value}</p>
      {caption && <p className="mt-1 text-xs leading-snug text-stone-500">{caption}</p>}
      {onClick && (
        <span className="no-print mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {t("story.openChapter")} <ArrowRight className="size-3" aria-hidden="true" />
        </span>
      )}
    </>
  );
  const frame = "relative z-10 min-w-0 rounded-xl border border-stone-200 bg-surface px-4 py-3.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={cx(frame, "group transition-colors hover:border-emerald-500/50")}>{body}</button>
  ) : (
    <div className={frame}>{body}</div>
  );
}

/**
 * How the plan was reached: the three evidence chapters, each with its headline number, flowing into
 * the plan's own inputs (water supply, earliest sowing, confidence).
 */
export function EvidenceTrail({ farmId, data, weights, onOpen }: { farmId: string; data: NextCropAdvice; weights: Priorities; onOpen?: (tab: StoryTab) => void }) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const climate = useClimate(farmId, true).data;
  const soilProfile = useSoil(farmId, true).data;
  const seasons = useSeasons(farmId).data;
  const seasonOf = useSeasonName();
  const proxy = data.weather_context.mode === "historical_proxy";
  const soil: SoilNow = data.soil_now;
  const rain = climate?.current_season;
  const share = rain && rain.median_mm > 0 ? rain.rain_mm / rain.median_mm - 1 : null;
  const last = [...(seasons ?? [])].filter((row) => row.status !== "planned").sort((a, b) => b.sow_date.localeCompare(a.sow_date))[0];
  const assumed = soil.assumed[0];
  const texture = soilProfile?.effective.texture;
  const confidenceTone = data.confidence.level === "high" ? "green" : data.confidence.level === "medium" ? "amber" : "red";
  const open = (tab: StoryTab) => (onOpen ? () => onOpen(tab) : undefined);

  return (
    <div className="border-t border-stone-200 px-5 py-5 sm:px-6">
      <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-500 uppercase">{t("story.builtFrom")}</p>
      <div className="relative mt-3 grid gap-3 lg:grid-cols-[repeat(3,minmax(0,1fr))_1.75rem_minmax(0,1.2fr)]">
        {/* the pipe the evidence flows along */}
        <div className="absolute top-1/2 right-8 left-8 hidden h-0.5 -translate-y-1/2 bg-gradient-to-r from-sky-400/50 via-amber-400/50 to-emerald-500/70 lg:block" aria-hidden="true" />
        <EvidenceNode
          icon={<CloudRain className="size-3.5" aria-hidden="true" />}
          accent="bg-sky-500/15 text-sky-700"
          chapter={t("farm.tabs.climate")}
          value={rain ? mm(rain.rain_mm) : climate ? t(`climate.aridityClass.${climate.aridity.class as "arid"}`) : "—"}
          caption={
            rain && share != null
              ? `${t("story.trail.since", { date: fullDate(rain.start) })} · ${share < 0 ? t("briefing.below", { pct: percent(-share) }) : t("briefing.above", { pct: percent(share) })} ${t("story.trail.typical")}`
              : climate && t("story.trail.aridity", { pct: percent(climate.aridity.index) })
          }
          onClick={open("climate")}
        />
        <EvidenceNode
          icon={<Layers className="size-3.5" aria-hidden="true" />}
          accent="bg-amber-500/15 text-amber-700"
          chapter={proxy ? t("quality.scenarioSoil") : t("farm.tabs.soil")}
          value={t("story.trail.full", { pct: percent(soil.fraction) })}
          caption={`${t("soilNow.stored", { mm: mm(soil.mm), capacity: mm(soil.capacity_mm) })}${texture ? ` · ${t(`soil.textureName.${texture as "loam"}`, { defaultValue: texture })}` : ""}`}
          onClick={open("soil")}
        />
        <EvidenceNode
          icon={<History className="size-3.5" aria-hidden="true" />}
          accent="bg-stone-500/15 text-stone-700"
          chapter={t("farm.tabs.history")}
          value={last ? last.crops.map((id) => cropName(catalog, id)).join(" + ") : t("story.trail.noCrop")}
          caption={
            last
              ? `${seasonOf(last.season)} ${last.season_year} · ${t("story.trail.rotation")}`
              : assumed
                ? t("story.trail.assumes", { crop: cropName(catalog, assumed.crop) })
                : t("story.trail.logIt")
          }
          onClick={open("history")}
        />
        <div className="relative z-10 hidden items-center justify-center lg:flex" aria-hidden="true">
          <span className="flex size-7 items-center justify-center rounded-full bg-emerald-600 text-white ring-4 ring-surface">
            <ArrowRight className="size-3.5" />
          </span>
        </div>
        <div className="relative z-10 min-w-0 rounded-xl border border-emerald-600/40 bg-emerald-50 px-4 py-3.5">
          <p className="flex items-center gap-2 text-xs font-medium text-emerald-800">
            <span className="flex size-6 items-center justify-center rounded-md bg-emerald-600 text-white"><Target className="size-3.5" aria-hidden="true" /></span>
            {t("story.planNode")}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-stone-500">{t("plan.water")}</dt>
            <dd className="font-semibold text-stone-900">{t(`farms.irrigation.${data.irrigation}`)}</dd>
            <dt className="text-stone-500">{t("plan.earliest")}</dt>
            <dd className="font-semibold text-stone-900">{fullDate(data.earliest_sowing)}</dd>
            <dt className="text-stone-500">{t("plan.confidenceLabel")}</dt>
            <dd className="whitespace-nowrap"><Badge tone={confidenceTone}>{t(`plan.confidence.${data.confidence.level}`)}</Badge></dd>
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-stone-500">
            {t("plan.rankedFor")} {PILLARS.map((key) => `${t(`plan.pillar.${key}`)} ${weights[key]}`).join(" · ")}
          </p>
          {data.in_field && (
            <p className="mt-1 text-[11px] leading-snug text-stone-500">{t("plan.inField", { crop: cropName(catalog, data.in_field.crop), date: fullDate(data.in_field.expected_harvest) })}</p>
          )}
        </div>
      </div>
      {data.confidence.flags.length > 0 && (
        <p className="mt-3 text-xs text-stone-500 first-letter:uppercase">
          {data.confidence.flags.map((flag) => flag === "weather_proxy" ? t("quality.proxySummary") : t(`plan.flag.${flag}`)).join("; ")}
        </p>
      )}
    </div>
  );
}
