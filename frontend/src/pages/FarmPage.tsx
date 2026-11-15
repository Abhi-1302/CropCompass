import { MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useDeleteFarm, useFarm, useRefreshFarm, useSources } from "../api/hooks";
import { Alert, Card, cx, PageSpinner, Spinner } from "../components/ui";
import { BackToFarms, FarmBriefing } from "../features/farm/FarmBriefing";
import { ChapterEnd, ChapterIntro, STORY_ORDER, StoryNav, type StoryTab } from "../features/farm/Story";
import { SoilPanel } from "../features/soil/SoilPanel";
import { WeatherConfidence } from "../features/plan/WeatherConfidence";
import { StatusBadge } from "./FarmsPage";
import { AskSprout } from "../features/sprout/Sprout";
import { useFarmTourScope } from "../features/tour/TourProvider";

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
const SavedPlans = lazy(() => import("../features/plan/SavedPlans").then((module) => ({ default: module.SavedPlans })));
const FieldPanel = lazy(() => import("../features/field/FieldPanel").then((module) => ({ default: module.FieldPanel })));
const FieldMap = lazy(() => import("../features/map/FieldMap").then((module) => ({ default: module.FieldMap })));

type Tab = StoryTab;
/** Story order: try crops, the evidence (climate, soil, history), the plan, then the crop reference. */
const TABS: Tab[] = STORY_ORDER;
const PACK_TABS: Tab[] = ["field", "crops", "plan"];
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

/** Refresh and delete are occasional actions, so they live behind one menu button. */
function FarmActions({ refreshing, deleting, onRefresh, onDelete, onDark }: {
  refreshing: boolean; deleting: boolean; onRefresh: () => void; onDelete: () => void; onDark: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const item = "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm disabled:opacity-60";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("farm.actions")}
        title={t("farm.actions")}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "flex size-9 items-center justify-center rounded-lg",
          onDark ? "bg-black/30 text-white ring-1 ring-white/25 backdrop-blur-sm hover:bg-white/10" : "text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100 hover:text-stone-900",
        )}
      >
        {refreshing || deleting ? <Spinner className="size-4" /> : <MoreHorizontal className="size-4" aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-[600] mt-2 w-48 rounded-xl border border-stone-200 bg-surface p-1 shadow-lg">
          <button type="button" role="menuitem" disabled={refreshing} className={cx(item, "text-stone-700 hover:bg-stone-100")}
            onClick={() => { setOpen(false); onRefresh(); }}>
            <RefreshCw className="size-4" aria-hidden="true" />{t("farm.refresh")}
          </button>
          <button type="button" role="menuitem" disabled={deleting} className={cx(item, "text-red-700 hover:bg-red-50")}
            onClick={() => { setOpen(false); onDelete(); }}>
            <Trash2 className="size-4" aria-hidden="true" />{t("farm.delete")}
          </button>
        </div>
      )}
    </div>
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
  const storyTop = useRef<HTMLDivElement>(null);
  /** Move to another chapter and bring its opening into view (used by the in-page "next" links). */
  const openChapter = (value: Tab) => {
    setTab(value);
    const top = storyTop.current;
    if (top && top.getBoundingClientRect().top < 0) window.scrollTo({ top: top.getBoundingClientRect().top + window.scrollY - 72, behavior: "smooth" });
  };
  const sources = useSources(farmId);
  const verified = sources.data?.weather.status === "verified";
  const adviceAvailable = sources.data?.advice.available === true;
  useFarmTourScope(farm.data, verified, adviceAvailable);
  const limited = sources.data?.advice.weather_context?.confidence === "low";
  const fallback: Tab = farm.data?.region === "IN" && adviceAvailable ? "field" : limited ? "plan" : "climate";
  const tab = TABS.includes(params.get("tab") as Tab) ? params.get("tab") as Tab : fallback;
  /** The farm's home tab carries the full briefing; the other tabs get a slim header so their own content leads. */
  const home: Tab = farm.data?.region === "IN" ? "field" : "climate";

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
  const available = TABS.filter((key) => !PACK_TABS.includes(key) || data.region === "IN");

  return (
    <div>
      <BackToFarms />
      <div className="mt-4">
        <FarmBriefing
          compact={tab !== home}
          farm={data}
          sources={sources.data}
          verified={verified}
          adviceAvailable={adviceAvailable}
          status={<StatusBadge status={limited ? "limited" : verified ? data.data_status : sources.data?.weather.status === "needs_attention" || sources.data?.weather.status === "unverified" ? "error" : "pending"} />}
          actions={<>
            <AskSprout farmId={data.id} text={t("sprout.farmQuestion")} intent="farm" />
            <FarmActions onDark={tab === home} refreshing={refresh.isPending} deleting={remove.isPending} onRefresh={() => refresh.mutate()} onDelete={confirmDelete} />
          </>}
          onOpenHistory={() => setTab("history")}
          onOpenPlan={() => setTab("plan")}
        />
      </div>

      <div className="mt-4 space-y-4 empty:hidden">
        {refresh.error && <Alert tone="error">{refresh.error.message}</Alert>}
        {sources.error && <Alert tone="error">{sources.error.message}</Alert>}
        {sources.data?.weather.error && <p className="break-words text-sm text-amber-800">{sources.data.weather.error}</p>}
        {data.data_status === "pending" && !adviceAvailable && <Building />}
        {data.data_status === "error" && !adviceAvailable && (
          <Alert tone="error">
            <p className="font-medium">{t("farm.errorTitle")}</p>
            <p className="mt-1">{data.data_error}</p>
          </Alert>
        )}
        {data.data_error && !adviceAvailable && data.data_status !== "error" && <Alert tone="warning">{data.data_error}</Alert>}
      </div>
      <WeatherConfidence context={sources.data?.advice.weather_context} />

      <div ref={storyTop} />
      <div className="z-[500] -mx-4 mt-4 bg-stone-50/95 px-4 backdrop-blur lg:sticky lg:top-16">
        <StoryNav available={available} value={tab} onChange={setTab} label={data.name} />
      </div>

      <div className="mt-8" role="tabpanel">
        {tab !== "field" && <ChapterIntro tab={tab} available={available} onOpen={openChapter} />}
        <Suspense fallback={<PageSpinner />}>
          {!verified && ["climate", "crops"].includes(tab) && <Alert tone="warning">{t("quality.paused")}</Alert>}
          {!adviceAvailable && tab === "field" && <Alert tone="warning">{t("quality.advicePending")}</Alert>}
          {adviceAvailable && tab === "field" && <FieldPanel farm={data} verified={verified} />}
          {!adviceAvailable && tab === "plan" && <><Alert tone="warning">{t("quality.advicePending")}</Alert><div className="mt-4"><SavedPlans farm={data} /></div></>}
          {verified && tab === "climate" && <ClimatePanel farmId={data.id} />}
          {tab === "history" && <HistoryPanel farm={data} />}
          {verified && tab === "crops" && <CropFitPanel farm={data} onOpenHistory={() => openChapter("history")} />}
          {adviceAvailable && tab === "plan" && <PlanPanel farm={data} onOpenTab={openChapter} />}
          {tab === "soil" && <>
            {data.boundary && <div className="mb-6"><FieldMap readOnly mode="boundary" pin={{ lat: data.lat, lon: data.lon }} corners={data.boundary.coordinates[0].slice(0, -1).map(([lon, lat]) => [lat, lon])} flyTo={null} onPin={() => {}} onCorners={() => {}} onSearch={() => {}} /></div>}
            <SoilPanel farmId={data.id} verified={verified} />
          </>}
          <ChapterEnd tab={tab} farm={data} verified={verified} available={available} onOpen={openChapter} />
        </Suspense>
      </div>
    </div>
  );
}
