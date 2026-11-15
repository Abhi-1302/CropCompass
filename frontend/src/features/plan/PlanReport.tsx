import { AlertTriangle, CheckCircle2, ChevronDown, Printer, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Catalog, CropOutcome, NextCropAdvice, NextCropOption, Priorities } from "../../api/types";
import { cx, DotScale } from "../../components/ui";
import { fullDate, inTenYears, mm, money, monthDay, monthName, percent, signed } from "../../lib/format";
import { cropName, yieldText } from "../crops/text";
import { EvidenceTrail, type StoryTab } from "../farm/Story";

/**
 * The Plan tab's season report: where the field starts, what to sow (or not), how the options compare,
 * when each would be in the ground, and a short checklist. Built only from the next-crop advice already loaded.
 */

type Candidate = { outcome: CropOutcome; option?: NextCropOption };

const DAY = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const parse = (value: string) => new Date(`${value}T00:00:00Z`);

/** "MM-DD" placed in the year that puts it closest after `reference` (allowing a few weeks before). */
function near(mmdd: string, reference: Date): Date {
  const [month, day] = mmdd.split("-").map(Number);
  let date = new Date(Date.UTC(reference.getUTCFullYear(), month - 1, day));
  if (date.getTime() < reference.getTime() - 60 * DAY) date = new Date(Date.UTC(reference.getUTCFullYear() + 1, month - 1, day));
  return date;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="border-t border-stone-200 px-5 py-5 sm:px-6">
      <h3 className="text-base font-semibold text-stone-900">{title}</h3>
      {subtitle && <p className="mt-0.5 text-xs text-stone-500">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Recommendation({ data, top, catalog }: { data: NextCropAdvice; top?: NextCropOption; catalog?: Catalog }) {
  const { t } = useTranslation();
  const currency = data.economics.currency;
  const risky = top && (top.yield.failure.p ?? 0) >= 0.5;
  const tone = !top ? "none" : risky ? "risky" : "good";
  const frame = {
    good: "border-emerald-500/40 bg-emerald-50",
    risky: "border-amber-500/50 bg-amber-50",
    none: "border-amber-500/50 bg-amber-50",
  }[tone];
  const Icon = tone === "good" ? CheckCircle2 : tone === "risky" ? AlertTriangle : XCircle;
  return (
    <div className={cx("rounded-2xl border p-5", frame)}>
      <p className={cx("flex items-center gap-2 text-xs font-semibold tracking-wide uppercase", tone === "good" ? "text-emerald-700" : "text-amber-700")}>
        <Icon className="size-4" aria-hidden="true" />
        {t("report.recTitle")}
      </p>
      {top ? (
        <>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">
            {t(risky ? "report.recRisky" : "report.recSow", { crop: cropName(catalog, top.id) })}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <p className="text-xs text-stone-500">{t("plan.sowBy")}</p>
              <p className="font-semibold text-stone-900">{fullDate(top.sowing.best)}</p>
            </div>
            <div>
              <p className="text-xs text-stone-500">{t("plan.profit")}</p>
              <p className={cx("tabular font-semibold", (top.income.mean ?? 0) < 0 ? "text-red-700" : "text-stone-900")}>
                {t("plan.perHa", { value: money(top.income.mean, currency) })}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone-500">{t("plan.yield")}</p>
              <p className="tabular font-semibold text-stone-900">{yieldText(t, top.yield.p50)}</p>
            </div>
            <div>
              <p className="text-xs text-stone-500">{t("report.failed")}</p>
              <p className="flex items-center gap-2 font-semibold text-stone-900">
                <DotScale p={top.yield.failure.p} tone={risky ? "warn" : "good"} />
                {inTenYears(top.yield.failure)}
              </p>
            </div>
          </div>
          {top.reasons.length > 0 && (
            <p className="mt-3 text-sm text-stone-700">
              {top.reasons.slice(0, 3).map((reason) => t(`plan.reason.${reason.code}.${reason.pillar}`)).join(" · ")}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">{t("report.recNone")}</p>
          <p className="mt-2 max-w-3xl text-sm text-stone-700">{t("plan.noOptions")}</p>
        </>
      )}
    </div>
  );
}

function Compare({ candidates, currency, catalog, advised }: { candidates: Candidate[]; currency: string; catalog?: Catalog; advised: boolean }) {
  const { t } = useTranslation();
  const lows = candidates.map(({ outcome }) => outcome.income.p10 ?? outcome.income.mean ?? 0);
  const highs = candidates.map(({ outcome }) => outcome.income.p90 ?? outcome.income.mean ?? 0);
  const min = Math.min(0, ...lows);
  const max = Math.max(0, ...highs) || 1;
  const span = max - min || 1;
  const at = (value: number) => ((value - min) / span) * 100;
  return (
    <div>
      {!advised && <p className="mb-3 text-xs font-medium text-amber-700">{t("report.notAdvised")}</p>}
      <div className="hidden grid-cols-[11rem_minmax(0,1fr)_13rem_6rem] gap-4 pb-2 text-xs text-stone-500 sm:grid">
        <span>{t("plan.crop")}</span>
        <span>{t("report.profitRange")}</span>
        <span>{t("report.failed")}</span>
        <span className="text-right">{t("plan.yield")}</span>
      </div>
      <ul className="divide-y divide-stone-200">
        {candidates.map(({ outcome, option }) => {
          const low = outcome.income.p10 ?? outcome.income.mean ?? 0;
          const high = outcome.income.p90 ?? outcome.income.mean ?? 0;
          const mean = outcome.income.mean ?? 0;
          const failure = outcome.yield.failure.p ?? 0;
          return (
            <li key={outcome.id} className="grid items-center gap-x-4 gap-y-2 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_13rem_6rem]">
              <p className="flex items-center gap-2 font-semibold text-stone-900">
                {option && (
                  <span className={cx("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", option.rank === 1 ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-700")}>
                    {option.rank}
                  </span>
                )}
                <span className="min-w-0 truncate">{cropName(catalog, outcome.id)}</span>
              </p>
              <div>
                <div className="relative h-6" aria-hidden="true">
                  <div className="absolute inset-x-0 top-1/2 h-px bg-stone-200" />
                  <div className="absolute top-0 bottom-0 w-px bg-stone-400" style={{ left: `${at(0)}%` }} />
                  <div
                    className={cx("absolute top-1/2 h-2 -translate-y-1/2 rounded-full", mean >= 0 ? "bg-emerald-500/50" : "bg-red-500/45")}
                    style={{ left: `${at(low)}%`, width: `${Math.max(1, at(high) - at(low))}%` }}
                  />
                  <div className={cx("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface", mean >= 0 ? "bg-emerald-600" : "bg-red-600")} style={{ left: `${at(mean)}%` }} />
                </div>
                <p className="tabular mt-0.5 text-xs text-stone-500">
                  {money(low, currency)} … <span className="font-semibold text-stone-800">{money(mean, currency)}</span> … {money(high, currency)}
                </p>
              </div>
              <p className="flex items-center gap-2 text-xs whitespace-nowrap text-stone-600">
                <DotScale p={failure} tone={failure > 0.3 ? "warn" : "good"} />
                {inTenYears(outcome.yield.failure)}
              </p>
              <p className="tabular text-sm font-medium text-stone-800 sm:text-right">{yieldText(t, outcome.yield.p50)}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Timeline({ candidates, earliest, catalog }: { candidates: Candidate[]; earliest: string; catalog?: Catalog }) {
  const { t } = useTranslation();
  const reference = parse(earliest);
  const rows = candidates.map(({ outcome, option }) => {
    const sow = option?.sowing.best ? parse(option.sowing.best) : near(outcome.sowing.median ?? outcome.sowing.window[0], reference);
    const windowStart = near(outcome.sowing.window[0], reference);
    let windowEnd = near(outcome.sowing.window[1], reference);
    if (windowEnd < windowStart) windowEnd = new Date(windowEnd.getTime() + 365 * DAY);
    const harvest = new Date(sow.getTime() + outcome.duration_days * DAY);
    return { id: outcome.id, sow, windowStart, windowEnd, harvest };
  });
  const today = new Date();
  const earliestRow = Math.min(...rows.map((row) => Math.min(row.windowStart.getTime(), row.sow.getTime())));
  // Show today on the axis only when sowing is close; otherwise the axis would be mostly empty months.
  const withToday = today.getTime() < earliestRow && earliestRow - today.getTime() < 60 * DAY;
  const first = new Date(withToday ? today.getTime() : earliestRow);
  const last = new Date(Math.max(...rows.map((row) => row.harvest.getTime())) + 20 * DAY);
  const start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
  const total = end.getTime() - start.getTime();
  const at = (date: Date) => ((date.getTime() - start.getTime()) / total) * 100;
  const months: Date[] = [];
  for (let cursor = new Date(start); cursor < end; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) months.push(cursor);

  return (
    <div>
      <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4">
        <span />
        <div className="relative h-5 text-[11px] text-stone-500">
          {months.map((month) => (
            <span key={iso(month)} className="absolute border-l border-stone-200 pl-1" style={{ left: `${at(month)}%` }}>
              {monthName(month.getUTCMonth() + 1)}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <p className="truncate py-2 text-sm font-medium text-stone-800">{cropName(catalog, row.id)}</p>
            <div className="relative my-2 h-6">
              {months.map((month) => (
                <span key={iso(month)} className="absolute inset-y-0 border-l border-stone-200/70" style={{ left: `${at(month)}%` }} aria-hidden="true" />
              ))}
              <span
                className="absolute inset-y-1 rounded-md border border-dashed border-emerald-500/60 bg-emerald-500/10"
                style={{ left: `${at(row.windowStart)}%`, width: `${Math.max(0.8, at(row.windowEnd) - at(row.windowStart))}%` }}
                title={t("report.sowWindow")}
              />
              <span
                className="absolute inset-y-1.5 rounded-md bg-gradient-to-r from-emerald-500 to-amber-500"
                style={{ left: `${at(row.sow)}%`, width: `${Math.max(0.8, at(row.harvest) - at(row.sow))}%` }}
                title={`${fullDate(iso(row.sow))} → ${fullDate(iso(row.harvest))}`}
              />
              {at(today) >= 0 && at(today) <= 100 && <span className="absolute -inset-y-1 w-px bg-stone-900/70" style={{ left: `${at(today)}%` }} aria-hidden="true" />}
              <span className="tabular absolute -top-0.5 text-[10px] font-medium whitespace-nowrap text-stone-600" style={{ left: `calc(${at(row.harvest)}% + 4px)` }}>
                {monthDay(iso(row.harvest).slice(5))}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded border border-dashed border-emerald-500/60 bg-emerald-500/10" />{t("report.sowWindow")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-5 rounded bg-gradient-to-r from-emerald-500 to-amber-500" />{t("report.growing")}</span>
        <span>{t("report.todayIs", { date: fullDate(iso(today)) })}</span>
      </div>
    </div>
  );
}

function Checklist({ data, top, catalog }: { data: NextCropAdvice; top?: NextCropOption; catalog?: Catalog }) {
  const { t } = useTranslation();
  const items: string[] = [];
  if (top) {
    const crop = cropName(catalog, top.id);
    items.push(t("report.checkSow", { crop, date: fullDate(top.sowing.best), start: monthDay(top.sowing.window[0]), end: monthDay(top.sowing.window[1]) }));
    items.push(top.water.irrigations > 0
      ? t("report.checkWater", { count: top.water.irrigations, mm: mm(top.water.irrigation_mm) })
      : t("report.checkRainfed", { pct: percent(top.water.met) }));
    if (top.nitrogen.to_apply > 0) {
      items.push(top.nitrogen.credit > 0
        ? t("field.helpNitrogenCredit", { kg: Math.round(top.nitrogen.to_apply), credit: Math.round(top.nitrogen.credit) })
        : t("field.helpNitrogen", { kg: Math.round(top.nitrogen.to_apply) }));
    }
    if (top.carbon && data.carbon && top.carbon.kept.mid > top.carbon.removed.mid) {
      items.push(t("field.helpResidue", { kept: signed(top.carbon.kept.mid), removed: signed(top.carbon.removed.mid), years: data.carbon.years }));
    }
    items.push(t("report.checkHarvest", { date: fullDate(iso(new Date(parse(top.sowing.best).getTime() + top.duration_days * DAY))) }));
  } else {
    items.push(t("report.checkFallow"), t("report.checkIrrigate"), t("report.checkOther"));
  }
  items.push(t("report.checkLog"));
  return (
    <ol className="grid gap-2 sm:grid-cols-2">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
          <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">{index + 1}</span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

/** Print on a light page even when the app is in dark mode, then restore the viewer's theme. */
function printLight() {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  const restore = () => {
    if (previous) root.dataset.theme = previous;
    window.removeEventListener("afterprint", restore);
  };
  root.dataset.theme = "light";
  window.addEventListener("afterprint", restore);
  window.print();
}

export function PlanReport({ farmId, data, catalog, farmName, weights, seasonControl, onOpenTab }: {
  farmId: string;
  onOpenTab?: (tab: StoryTab) => void;
  data: NextCropAdvice;
  catalog?: Catalog;
  farmName: string;
  weights: Priorities;
  seasonControl: ReactNode;
}) {
  const { t } = useTranslation();
  const top = data.options[0];
  const advised = data.options.length > 0;
  const candidates: Candidate[] = advised
    ? data.options.slice(0, 4).map((option) => ({ outcome: option, option }))
    : [...data.unsuitable].sort((a, b) => (a.yield.failure.p ?? 1) - (b.yield.failure.p ?? 1)).slice(0, 3).map((outcome) => ({ outcome }));
  const notRanked = data.excluded.length + data.unsuitable.length + data.blocked.length;

  return (
    <article className="plan-report overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 pb-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.16em] text-emerald-700 uppercase">{t("report.kicker")}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-stone-900">
            {t("report.title", { season: t(`history.seasonName.${data.season}`), year: data.season_year })}
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            {t("report.sub", { farm: farmName, n: data.period.n_years, first: data.period.first_year, last: data.period.last_year })}
          </p>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          {seasonControl}
          <button
            type="button"
            onClick={printLight}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-stone-700 ring-1 ring-stone-300 hover:bg-stone-100"
          >
            <Printer className="size-4" aria-hidden="true" />
            {t("report.print")}
          </button>
        </div>
      </header>

      <EvidenceTrail farmId={farmId} data={data} weights={weights} onOpen={onOpenTab} />

      <div className="border-t border-stone-200 px-5 py-5 sm:px-6">
        <Recommendation data={data} top={top} catalog={catalog} />
      </div>

      {candidates.length > 0 && (
        <Section title={t("report.compareTitle")} subtitle={t("report.compareSub")}>
          <Compare candidates={candidates} currency={data.economics.currency} catalog={catalog} advised={advised} />
        </Section>
      )}

      {candidates.length > 0 && (
        <Section title={t("report.timelineTitle")} subtitle={t("report.timelineSub")}>
          <Timeline candidates={candidates} earliest={data.earliest_sowing} catalog={catalog} />
        </Section>
      )}

      <Section title={t("report.checklistTitle")}>
        <Checklist data={data} top={top} catalog={catalog} />
      </Section>

      {notRanked > 0 && (
        <details className="group border-t border-stone-200 px-5 py-3 text-sm text-stone-600 sm:px-6">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-medium text-stone-800 [&::-webkit-details-marker]:hidden">
            {t("plan.notRankedCount", { count: notRanked })}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-2 space-y-2">
            {data.excluded.length > 0 && <p>{t("plan.excluded", { crops: data.excluded.map((item) => cropName(catalog, item.id)).join(", ") })}</p>}
            {data.unsuitable.length > 0 && <p>{t("plan.unsuitable", { crops: data.unsuitable.map((item) => cropName(catalog, item.id)).join(", ") })}</p>}
            {data.blocked.length > 0 && (
              <p><span className="font-medium">{t("plan.blockedTitle")}: </span>{data.blocked.map((item) => cropName(catalog, item.id)).join(", ")}</p>
            )}
          </div>
        </details>
      )}
    </article>
  );
}
