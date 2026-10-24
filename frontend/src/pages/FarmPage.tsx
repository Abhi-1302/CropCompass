import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useDeleteFarm, useFarm, useRefreshFarm, useSources } from "../api/hooks";
import { fullDate } from "../lib/format";
import { Alert, Button, Card, cx, PageSpinner, Spinner } from "../components/ui";
import { SoilPanel } from "../features/soil/SoilPanel";
import { WeatherConfidence } from "../features/plan/WeatherConfidence";
import { StatusBadge } from "./FarmsPage";

const ClimatePanel = lazy(() =>
  import("../features/climate/ClimatePanel").then((module) => ({ default: module.ClimatePanel })),
);
const HistoryPanel = lazy(() =>
  import("../features/history/HistoryPanel").then((module) => ({ default: module.HistoryPanel })),
);
const CropFitPanel = lazy(() =>
  import("../features/crops/CropFitPanel").then((module) => ({ default: module.CropFitPanel })),
);
const PlanPanel = lazy(() => import("../features/plan/PlanPanel").then((module) => ({ default: module.PlanPanel })));
const NextCropSummary = lazy(() =>
  import("../features/plan/NextCropSummary").then((module) => ({ default: module.NextCropSummary })),
);
const SavedPlans = lazy(() => import("../features/plan/SavedPlans").then((module) => ({ default: module.SavedPlans })));
const FieldMap = lazy(() => import("../features/map/FieldMap").then((module) => ({ default: module.FieldMap })));

type Tab = "climate" | "history" | "crops" | "plan" | "soil";
const TABS: Tab[] = ["climate", "history", "crops", "plan", "soil"];
const PACK_TABS: Tab[] = ["crops", "plan"];

function Building() {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
        <Spinner className="size-6" />
      </div>
      <div>
        <h2 className="font-semibold">{t("farm.buildingTitle")}</h2>
        <p className="mt-1 max-w-xl text-sm text-stone-600">{t("farm.buildingText")}</p>
        <ol className="mt-4 space-y-2 text-sm text-stone-700">
          {(["step1", "step2", "step3"] as const).map((step, index) => (
            <li key={step} className="flex items-center gap-3">
              <span className="flex size-6 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold">
                {index + 1}
              </span>
              {t(`farm.${step}`)}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

export function FarmPage() {
  const { t } = useTranslation();
  const { farmId = "" } = useParams();
  const navigate = useNavigate();
  const farm = useFarm(farmId);
  const refresh = useRefreshFarm(farmId);
  const remove = useDeleteFarm();
  const [params, setParams] = useSearchParams();
  const setTab = (value: Tab) => setParams((current) => { current.set("tab", value); return current; });
  const sources = useSources(farmId);
  const verified = sources.data?.weather.status === "verified";
  const adviceAvailable = sources.data?.advice.available === true;
  const limited = sources.data?.advice.weather_context?.confidence === "low";
  const tab = TABS.includes(params.get("tab") as Tab) ? params.get("tab") as Tab : limited ? "plan" : "climate";

  if (farm.isPending) return <PageSpinner />;
  if (farm.isError) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <Alert tone="error">{farm.error.message}</Alert>
        <Link to="/" className="text-sm font-medium text-emerald-700">
          ← {t("common.back")}
        </Link>
      </div>
    );
  }

  const data = farm.data;
  const confirmDelete = () => {
    if (window.confirm(t("farm.confirmDelete"))) {
      remove.mutate(data.id, { onSuccess: () => navigate("/", { replace: true }) });
    }
  };

  return (
    <div>
      <Link to="/" className="text-sm font-medium text-emerald-700 hover:text-emerald-800">
        ← {t("common.back")}
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-2xl font-semibold">{data.name}</h1>
            <StatusBadge status={limited ? "limited" : verified ? data.data_status : sources.data?.weather.status === "needs_attention" || sources.data?.weather.status === "unverified" ? "error" : "pending"} />
          </div>
          <p className="mt-1 text-sm text-stone-500">
            {data.lat.toFixed(3)}°, {data.lon.toFixed(3)}° · {t("farm.cell", { cell: data.cell_id })} ·{" "}
            {t(`farms.irrigation.${data.irrigation}`)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            busy={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {t("farm.refresh")}
          </Button>
          <Button variant="danger" size="sm" busy={remove.isPending} onClick={confirmDelete}>
            {t("farm.delete")}
          </Button>
        </div>
      </div>

      {refresh.error && (
        <div className="mt-4">
          <Alert tone="error">{refresh.error.message}</Alert>
        </div>
      )}

      <div className="mt-6">
        {sources.data && (
          <dl className="mb-5 grid min-w-0 gap-4 border-y border-stone-200 py-4 text-sm sm:grid-cols-3" aria-live="polite">
            {(["weather", "soil", "satellite"] as const).map((source) => {
              const value = sources.data[source];
              return <div key={source} className="min-w-0 break-words">
                <dt className="font-semibold">{t(`quality.${source}`)}</dt>
                <dd>{t(`quality.${value.status}`)}</dd>
                {source === "weather" && <dd>{t("quality.progress", { done: sources.data.weather.years_done, total: sources.data.weather.years_total })}</dd>}
                {source === "satellite" && <dd>{t("quality.composites", { done: sources.data.satellite.done, total: sources.data.satellite.total })}</dd>}
                {"through" in value && value.through && <dd className="text-xs text-stone-500">{t("quality.through", { date: fullDate(value.through) })}</dd>}
                {value.updated_at && <dd className="text-xs text-stone-500">{t("quality.checked", { date: fullDate(value.updated_at.slice(0, 10)) })}</dd>}
              </div>;
            })}
          </dl>
        )}
        {sources.error && <Alert tone="error">{sources.error.message}</Alert>}
        <WeatherConfidence context={sources.data?.advice.weather_context} />
        {sources.data?.weather.error && <p className="mb-4 break-words text-sm text-amber-800">{sources.data.weather.error}</p>}
        {data.data_status === "pending" && !adviceAvailable && <Building />}
        {data.data_status === "error" && !adviceAvailable && (
          <Alert tone="error">
            <p className="font-medium">{t("farm.errorTitle")}</p>
            <p className="mt-1">{data.data_error}</p>
          </Alert>
        )}
        {(
          <>
            {data.data_error && !adviceAvailable && (
              <div className="mb-4">
                <Alert tone="warning">{data.data_error}</Alert>
              </div>
            )}
            <div role="tablist" aria-label={data.name} className="mt-4 flex w-fit max-w-full overflow-x-auto rounded-lg bg-stone-100 p-1">
              {TABS.filter((key) => !PACK_TABS.includes(key) || data.region === "IN").map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={cx(
                    "shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition",
                    tab === key ? "bg-white text-stone-900 shadow-sm" : "text-stone-600 hover:text-stone-900",
                  )}
                >
                  {t(`farm.tabs.${key}`)}
                </button>
              ))}
            </div>
            <div className="mt-6" role="tabpanel">
              <Suspense fallback={<PageSpinner />}>
                {!verified && ["climate", "crops"].includes(tab) && <Alert tone="warning">{t("quality.paused")}</Alert>}
                {!adviceAvailable && tab === "plan" && <><Alert tone="warning">{t("quality.advicePending")}</Alert><div className="mt-4"><SavedPlans farm={data} /></div></>}
                {verified && tab === "climate" && (
                  <div className="space-y-10">
                    {data.region === "IN" && <NextCropSummary farm={data} onOpenPlan={() => setTab("plan")} />}
                    <ClimatePanel farmId={data.id} onOpenHistory={() => setTab("history")} />
                  </div>
                )}
                {tab === "history" && <HistoryPanel farm={data} />}
                {verified && tab === "crops" && <CropFitPanel farm={data} onOpenHistory={() => setTab("history")} />}
                {adviceAvailable && tab === "plan" && <PlanPanel farm={data} onOpenHistory={() => setTab("history")} />}
                {tab === "soil" && <>
                  {data.boundary && <div className="mb-6"><FieldMap readOnly mode="boundary" pin={{ lat: data.lat, lon: data.lon }} corners={data.boundary.coordinates[0].slice(0, -1).map(([lon, lat]) => [lat, lon])} flyTo={null} onPin={() => {}} onCorners={() => {}} onSearch={() => {}} /></div>}
                  <SoilPanel farmId={data.id} />
                </>}
              </Suspense>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
