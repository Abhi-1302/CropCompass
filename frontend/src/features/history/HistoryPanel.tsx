import type { EChartsCoreOption } from "echarts/core";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCatalog, useDeleteSeason, useResumeVegetation, useSeasons, useVegetation } from "../../api/hooks";
import type { Catalog, DetectedSeason, Farm, SeasonRecord, VegetationView } from "../../api/types";
import { AXIS_STYLE, EChart, SPLIT_LINE } from "../../components/EChart";
import { Alert, Badge, Button, Card, PageSpinner, SectionHeader, Spinner } from "../../components/ui";
import { fullDate, percent } from "../../lib/format";
import { catalogLabel, cropName, familyName, problemName } from "../crops/text";
import { draftFromRecord, EMPTY_DRAFT, type SeasonDraft, SeasonForm } from "./SeasonForm";

const ZOOM_YEARS = 6;
const DAY_MS = 86_400_000;

function cropNames(catalog: Catalog | undefined, ids: string[]): string {
  return ids.map((id) => cropName(catalog, id)).join(" + ");
}

function seasonLabel(t: ReturnType<typeof useTranslation>["t"], season: { season: DetectedSeason["season"]; season_year: number }) {
  return `${t(`history.seasonName.${season.season}`)} ${season.season_year}`;
}

function SatelliteChart({ view, records, catalog }: { view: VegetationView; records: SeasonRecord[]; catalog?: Catalog }) {
  const { t } = useTranslation();
  const option = useMemo<EChartsCoreOption>(() => {
    const last = view.points[view.points.length - 1].date;
    const zoomStart = new Date(Date.parse(last) - ZOOM_YEARS * 365.25 * DAY_MS).toISOString().slice(0, 10);
    const logged = records.map((record) => [
      { name: cropNames(catalog, record.crops), xAxis: record.sow_date, itemStyle: { color: "rgba(16,185,129,0.16)" } },
      { xAxis: record.harvest_date ?? last },
    ]);
    const unlogged = view.seasons
      .filter((season) => !season.logged)
      .map((season) => [
        { name: "?", xAxis: season.est_sowing, itemStyle: { color: "rgba(245,158,11,0.16)" } },
        { xAxis: season.est_harvest ?? last },
      ]);
    return {
      tooltip: { trigger: "axis", valueFormatter: (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "—") },
      legend: { bottom: 36, icon: "roundRect", textStyle: { color: "#44403c" } },
      grid: { left: 44, right: 16, top: 28, bottom: 96 },
      xAxis: { type: "time", ...AXIS_STYLE },
      yAxis: { type: "value", min: 0, max: 1, name: "NDVI", ...AXIS_STYLE, ...SPLIT_LINE },
      dataZoom: [
        { type: "inside", startValue: zoomStart },
        { type: "slider", startValue: zoomStart, height: 20, bottom: 8 },
      ],
      series: [
        {
          name: t("history.ndviSmooth"),
          type: "line",
          showSymbol: false,
          data: view.points.map((point) => [point.date, point.smooth]),
          lineStyle: { width: 2.5, color: "#047857" },
          itemStyle: { color: "#047857" },
          markArea: {
            silent: true,
            label: { color: "#44403c", fontSize: 11, position: "insideTop" },
            data: [...logged, ...unlogged],
          },
        },
        {
          name: t("history.ndviRaw"),
          type: "scatter",
          symbolSize: 4,
          data: view.points.filter((point) => point.raw != null).map((point) => [point.date, point.raw]),
          itemStyle: { color: "#a8a29e" },
        },
      ],
    };
  }, [view, records, catalog, t]);
  return <EChart option={option} label={t("history.satelliteTitle")} height={340} />;
}

function SatelliteCard({ farmId, view, records, catalog }: {
  farmId: string;
  view?: VegetationView;
  records: SeasonRecord[];
  catalog?: Catalog;
}) {
  const { t } = useTranslation();
  const resume = useResumeVegetation(farmId);
  const busy = !!view && (view.running || view.status === "pending" || view.status === "partial");
  const { done = 0, total = 0 } = view?.progress ?? {};

  return (
    <Card>
      <SectionHeader title={t("history.satelliteTitle")} subtitle={t("history.satelliteSub")} />
      {busy && (
        <div className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <div className="flex items-center gap-2 font-medium">
            <Spinner className="size-4" />
            {total ? t("history.downloading", { done, total }) : t("history.downloadingStart")}
          </div>
          {total > 0 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-emerald-100">
              <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${(100 * done) / total}%` }} />
            </div>
          )}
          <p className="mt-2 text-xs text-emerald-800">{t("history.slow")}</p>
        </div>
      )}
      {view?.status === "error" && !view.running && (
        <div className="mb-4">
          <Alert tone="warning">
            <span>{t("history.error")} </span>
            <button type="button" className="font-medium underline" disabled={resume.isPending} onClick={() => resume.mutate()}>
              {t("history.resume")}
            </button>
          </Alert>
        </div>
      )}
      {resume.error && <Alert tone="error">{resume.error.message}</Alert>}
      {view && view.points.length >= 5 ? (
        <>
          <SatelliteChart view={view} records={records} catalog={catalog} />
          <p className="mt-2 text-xs text-stone-500">{t("history.legend")}</p>
        </>
      ) : (
        !busy && <p className="text-sm text-stone-500">{t("history.noData")}</p>
      )}
    </Card>
  );
}

function Suggestions({ seasons, onLog }: { seasons: DetectedSeason[]; onLog: (season: DetectedSeason) => void }) {
  const { t } = useTranslation();
  const open = seasons
    .filter((season) => !season.logged)
    .sort((a, b) => b.peak.localeCompare(a.peak))
    .slice(0, 3);
  if (!open.length) return null;
  return (
    <section>
      <SectionHeader title={t("history.suggestionsTitle")} subtitle={t("history.suggestionsSub")} />
      <div className="grid gap-4 md:grid-cols-3">
        {open.map((season) => (
          <Card key={season.peak} className="flex flex-col border-amber-200 bg-amber-50/40">
            <div className="flex items-center justify-between gap-2">
              <Badge tone="amber">{seasonLabel(t, season)}</Badge>
              <span className="text-xs font-medium text-stone-500">
                {t(season.in_progress ? "history.growingNow" : "history.seenCrop")}
              </span>
            </div>
            <p className="mt-3 text-sm text-stone-700">
              {season.in_progress
                ? t("history.growingDetail", { greenUp: fullDate(season.green_up) })
                : t("history.seenDetail", {
                    greenUp: fullDate(season.green_up),
                    peak: fullDate(season.peak),
                    harvest: fullDate(season.est_harvest),
                  })}
            </p>
            {season.vigour_percentile != null && (
              <p className="mt-1 text-xs text-stone-500">
                {t("history.vigour", {
                  pct: percent(season.vigour_percentile),
                  season: t(`history.seasonName.${season.season}`),
                })}
              </p>
            )}
            <div className="mt-auto pt-4">
              <Button size="sm" variant="secondary" onClick={() => onLog(season)}>
                {t("history.logThis")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);
}

function JournalRow({ record, catalog, onEdit, onDelete, deleting }: {
  record: SeasonRecord;
  catalog?: Catalog;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const families = [
    ...new Set(
      record.crops
        .map((id) => catalog?.crops.find((crop) => crop.id === id)?.family)
        .filter((family): family is string => !!family)
        .map((family) => familyName(catalog, family)),
    ),
  ];
  const details = [
    record.residue && catalogLabel("residue", record.residue, catalog?.residue[record.residue]),
    record.yield_kg_ha != null && t("history.yield", { value: record.yield_kg_ha.toLocaleString() }),
    record.irrigations != null && t("history.irrigations", { count: record.irrigations }),
    record.herbicide,
  ].filter(Boolean);

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={record.status === "in_field" ? "sky" : "stone"}>{seasonLabel(t, record)}</Badge>
          <span className="font-semibold">{cropNames(catalog, record.crops)}</span>
          {families.map((family) => (
            <Badge key={family} tone="green">
              {family}
            </Badge>
          ))}
          {record.source === "satellite" && <Badge tone="amber">{t("history.fromSatellite")}</Badge>}
        </div>
        <p className="mt-1 text-sm text-stone-600">
          {record.harvest_date && record.status === "harvested"
            ? t("history.dates", {
                sow: fullDate(record.sow_date),
                harvest: fullDate(record.harvest_date),
                days: daysBetween(record.sow_date, record.harvest_date),
              })
            : `${t("history.sownOn", { date: fullDate(record.sow_date) })} · ${t("history.inField")}`}
        </p>
        {details.length > 0 && <p className="mt-1 text-sm text-stone-500">{details.join(" · ")}</p>}
        {record.problems.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {record.problems.map((problem) => (
              <Badge key={problem} tone="amber">
                {problemName(catalog, problem)}
              </Badge>
            ))}
          </div>
        )}
        {record.notes && <p className="mt-2 text-sm text-stone-500 italic">{record.notes}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t("history.edit")}
        </Button>
        <Button size="sm" variant="ghost" busy={deleting} onClick={onDelete}>
          {t("history.delete")}
        </Button>
      </div>
    </li>
  );
}

function draftFromDetected(season: DetectedSeason): SeasonDraft {
  const today = new Date().toISOString().slice(0, 10);
  const harvested = !season.in_progress && !!season.est_harvest && season.est_harvest <= today;
  return {
    ...EMPTY_DRAFT,
    season: season.season,
    sow_date: season.est_sowing,
    harvest_date: season.est_harvest ?? "",
    status: harvested ? "harvested" : "in_field",
    source: "satellite",
  };
}

export function HistoryPanel({ farm }: { farm: Farm }) {
  const { t } = useTranslation();
  const catalog = useCatalog();
  const seasons = useSeasons(farm.id);
  const vegetation = useVegetation(farm.id);
  const remove = useDeleteSeason(farm.id);
  const [editing, setEditing] = useState<{ id?: string; draft: SeasonDraft } | null>(null);

  if (seasons.isPending || catalog.isPending) return <PageSpinner />;
  if (seasons.isError) return <Alert tone="error">{seasons.error.message}</Alert>;
  if (catalog.isError) return <Alert tone="error">{catalog.error.message}</Alert>;

  const records = seasons.data;
  const confirmDelete = (record: SeasonRecord) => {
    if (window.confirm(t("history.confirmDelete"))) remove.mutate(record.id);
  };

  return (
    <div className="space-y-8">
      <SatelliteCard farmId={farm.id} view={vegetation.data} records={records} catalog={catalog.data} />
      {vegetation.error && <Alert tone="error">{vegetation.error.message}</Alert>}
      <Suggestions seasons={vegetation.data?.seasons ?? []} onLog={(season) => setEditing({ draft: draftFromDetected(season) })} />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeader title={t("history.journalTitle")} subtitle={t("history.journalSub")} />
          <Button size="sm" onClick={() => setEditing({ draft: EMPTY_DRAFT })}>
            {t("history.add")}
          </Button>
        </div>
        {records.length === 0 ? (
          <p className="py-6 text-center text-sm text-stone-500">{t("history.empty")}</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {records.map((record) => (
              <JournalRow
                key={record.id}
                record={record}
                catalog={catalog.data}
                onEdit={() => setEditing({ id: record.id, draft: draftFromRecord(record) })}
                onDelete={() => confirmDelete(record)}
                deleting={remove.isPending && remove.variables === record.id}
              />
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <SeasonForm
          farmId={farm.id}
          isIndia={farm.region === "IN"}
          catalog={catalog.data}
          recordId={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
