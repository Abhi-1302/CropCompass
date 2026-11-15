import { CircleDashed, Leaf, LoaderCircle, NotebookPen, Sprout, TriangleAlert, Wheat } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Farm } from "../api/types";
import { useCatalog, useFarms, usePlans, useSeasons } from "../api/hooks";
import { Alert, Badge, Card, cx, PageSpinner } from "../components/ui";
import { cropJourney, journalState } from "../features/crops/journey";
import { cropName } from "../features/crops/text";
import { fullDate, monthDay } from "../lib/format";

const STATUS_TONE = { pending: "amber", ready: "green", error: "red", limited: "amber" } as const;

export function StatusBadge({ status }: { status: Farm["data_status"] }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{status === "limited" ? t("plan.confidence.low") : t(`farms.status.${status}`)}</Badge>;
}

function JourneyStep({ label, name, detail, status, icon, tone = "neutral", empty = false }: {
  label: string; name: string; detail?: string; status?: string; icon: ReactNode;
  tone?: "neutral" | "green" | "amber"; empty?: boolean;
}) {
  return (
    <li className="relative flex min-w-0 flex-col items-center text-center [overflow-wrap:anywhere]">
      <span className="flex min-h-8 items-center text-xs font-medium text-stone-500">{label}</span>
      <span className={cx(
        "relative mt-1.5 flex size-9 shrink-0 items-center justify-center rounded-full border bg-surface",
        empty ? "border-dashed border-stone-300 text-stone-400" : tone === "green" ? "border-emerald-300 text-emerald-700" : tone === "amber" ? "border-amber-300 text-amber-700" : "border-stone-300 text-stone-600",
      )}>{icon}</span>
      <span className={cx("mt-2 block min-h-10 text-xs font-semibold leading-4", empty ? "text-stone-500" : "text-stone-900")}>{name}</span>
      <span className="tabular mt-1 block min-h-4 text-[11px] leading-4 text-stone-500">{detail}</span>
      <span className={cx("mt-1 block min-h-8 text-[11px] font-medium leading-4", tone === "amber" ? "text-amber-700" : tone === "green" ? "text-emerald-700" : "text-stone-500")}>{status}</span>
    </li>
  );
}

function CropJourney({ farmId }: { farmId: string }) {
  const { t } = useTranslation();
  const seasons = useSeasons(farmId);
  const plans = usePlans(farmId);
  const catalog = useCatalog();
  const journey = cropJourney(seasons.data ?? [], plans.data ?? []);
  const today = new Date().toISOString().slice(0, 10);
  const placeholder = (pending: boolean, error: boolean, empty: string) => pending ? t("common.loading") : error ? t("farmJourney.unavailable") : empty;
  const emptyIcon = (pending: boolean, error: boolean) => pending
    ? <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden="true" />
    : error ? <TriangleAlert className="size-5" aria-hidden="true" /> : <CircleDashed className="size-5" aria-hidden="true" />;
  const plan = plans.isError ? undefined : journey.plan;

  return (
    <div className="farm-journey-header flex-1 border-b border-stone-200 px-4 py-3" aria-busy={seasons.isPending || plans.isPending}>
      <ol aria-label={t("farmJourney.title")} className="relative grid grid-cols-3 gap-3 before:pointer-events-none before:absolute before:left-[16.67%] before:right-[16.67%] before:top-[56px] before:border-t before:border-dashed before:border-stone-300">
        {(["previous", "latest"] as const).map((position) => {
          const record = seasons.isError ? undefined : journey[position];
          const state = record ? journalState(record, today) : undefined;
          const group = catalog.data?.crops.find((crop) => crop.id === record?.crops[0])?.group;
          const Icon = group === "cereal" ? Wheat : group === "pulse" || group === "oilseed" ? Sprout : Leaf;
          return (
            <JourneyStep
              key={position}
              label={t(`farmJourney.${position}`)}
              name={record ? record.crops.map((crop) => cropName(catalog.data, crop).replaceAll("_", " ")).join(" + ") : placeholder(seasons.isPending, seasons.isError, t("farmJourney.noRecord"))}
              detail={record ? `${t(`history.seasonName.${record.season}`)} ${record.season_year}` : undefined}
              status={record && state ? `${t(`farmJourney.state.${state}`)}${state === "harvested" && record.harvest_date ? ` · ${monthDay(record.harvest_date.slice(5))}` : ""}` : undefined}
              icon={record ? <Icon className="size-6" aria-hidden="true" /> : emptyIcon(seasons.isPending, seasons.isError)}
              tone={record ? position === "latest" ? "green" : "neutral" : seasons.isError ? "amber" : "neutral"}
              empty={!record}
            />
          );
        })}
        <JourneyStep
          label={t("farmJourney.savedPlan")}
          name={plan?.title ?? placeholder(plans.isPending, plans.isError, t("farmJourney.noPlan"))}
          detail={plan ? fullDate(plan.created_at.slice(0, 10)) : undefined}
          status={plan ? t(`farmJourney.planStatus.${plan.weather_status}`) : undefined}
          icon={plan ? <NotebookPen className="size-5" aria-hidden="true" /> : emptyIcon(plans.isPending, plans.isError)}
          tone={plan ? plan.weather_status === "current" ? "green" : "amber" : plans.isError ? "amber" : "neutral"}
          empty={!plan}
        />
      </ol>
    </div>
  );
}

function FarmCard({ farm }: { farm: Farm }) {
  const { t } = useTranslation();
  return (
    <Link to={`/farms/${farm.id}`} className="group block focus-visible:outline-none">
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm transition group-hover:border-emerald-400/60 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-emerald-600">
        <CropJourney farmId={farm.id} />
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 break-words font-semibold text-stone-900">{farm.name}</h2>
            <StatusBadge status={farm.data_status} />
          </div>
          <p className="tabular mt-1 text-sm text-stone-500">
            {farm.lat.toFixed(3)}°, {farm.lon.toFixed(3)}°
            {farm.area_ha != null && <> · {t("farms.hectares", { value: farm.area_ha })}</>}
          </p>
          <p className="mt-3 text-xs text-stone-500">
            {t(farm.region ? "farms.regionIN" : "farms.regionNone")} · {t(`farms.irrigation.${farm.irrigation}`)}
          </p>
        </div>
      </div>
    </Link>
  );
}

export function FarmsPage() {
  const { t } = useTranslation();
  const farms = useFarms();

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 data-tour-id="farms-heading" className="text-2xl font-semibold">{t("farms.title")}</h1>
          <p className="mt-1 text-sm text-stone-500">{t("farms.subtitle")}</p>
        </div>
        <Link
          to="/farms/new"
          className="inline-flex items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-strong"
        >
          {t("farms.add")}
        </Link>
      </div>

      {farms.isPending && <PageSpinner />}
      {farms.isError && <Alert tone="error">{farms.error.message}</Alert>}
      {farms.data?.length === 0 && (
        <Card className="mx-auto max-w-lg py-12 text-center">
          <h2 className="text-lg font-semibold">{t("farms.emptyTitle")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-stone-500">{t("farms.emptyText")}</p>
          <Link
            to="/farms/new"
            className="mt-6 inline-flex rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-strong"
          >
            {t("farms.emptyCta")}
          </Link>
        </Card>
      )}
      {!!farms.data?.length && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-4">
          {farms.data.map((farm) => (
            <FarmCard key={farm.id} farm={farm} />
          ))}
        </div>
      )}
    </div>
  );
}
