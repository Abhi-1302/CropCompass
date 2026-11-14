import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Farm } from "../api/types";
import { useFarms } from "../api/hooks";
import { SatelliteThumb } from "../components/SatelliteThumb";
import { Alert, Badge, Card, PageSpinner } from "../components/ui";

const STATUS_TONE = { pending: "amber", ready: "green", error: "red", limited: "amber" } as const;

export function StatusBadge({ status }: { status: Farm["data_status"] }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{status === "limited" ? t("plan.confidence.low") : t(`farms.status.${status}`)}</Badge>;
}

function FarmCard({ farm }: { farm: Farm }) {
  const { t } = useTranslation();
  return (
    <Link to={`/farms/${farm.id}`} className="group block focus-visible:outline-none">
      <div className="h-full overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm transition group-hover:border-emerald-400/60 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-emerald-600">
        <SatelliteThumb
          lat={farm.lat}
          lon={farm.lon}
          boundary={farm.boundary}
          label={t("farm.satelliteAlt", { name: farm.name })}
          className="h-36 w-full"
        />
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {farms.data.map((farm) => (
            <FarmCard key={farm.id} farm={farm} />
          ))}
        </div>
      )}
    </div>
  );
}
