import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { useSavePriorities } from "../../api/hooks";
import type { Farm, Irrigation, PillarKey, Priorities } from "../../api/types";
import { AboutData, Alert, Button, Field, SectionHeader, Segmented, Select } from "../../components/ui";
import { NextCropView } from "./NextCropView";
import type { StoryTab } from "../farm/Story";
import { RotationsView } from "./RotationsView";
import { SavedPlans } from "./SavedPlans";
import { DEFAULT_PRIORITIES, PILLARS, useDebounced } from "./parts";

type Mode = "next" | "rotations" | "saved";
const MODES: Mode[] = ["next", "rotations", "saved"];
const IRRIGATIONS: Irrigation[] = ["rainfed", "protective", "full"];

function same(a: Priorities, b: Priorities): boolean {
  return PILLARS.every((key) => a[key] === b[key]);
}

function PrioritiesCard({ farm, weights, onChange, irrigation, onIrrigation }: {
  farm: Farm;
  weights: Priorities;
  onChange: (value: Priorities) => void;
  irrigation: Irrigation;
  onIrrigation: (value: Irrigation) => void;
}) {
  const { t } = useTranslation();
  const save = useSavePriorities(farm.id);
  const stored = farm.priorities ?? DEFAULT_PRIORITIES;
  const [open, setOpen] = useState(false);
  const set = (key: PillarKey, value: number) => onChange({ ...weights, [key]: value });
  return (
    <div className="rounded-2xl border border-stone-200 bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <p className="min-w-0 text-sm text-stone-600">
          <span className="font-semibold text-stone-900">{t("plan.rankedFor")}</span>{" "}
          {PILLARS.map((key) => (
            <span key={key} className="mr-3 inline-flex items-center gap-1.5 whitespace-nowrap">
              {t(`plan.pillar.${key}`)} <span className="tabular font-semibold text-emerald-700">{weights[key]}</span>
            </span>
          ))}
          <span className="whitespace-nowrap">· {t(`farms.irrigation.${irrigation}`)}</span>
        </p>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {t(open ? "plan.prioritiesDone" : "plan.prioritiesAdjust")}
        </Button>
      </div>
      {open && <div className="border-t border-stone-200 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader title={t("plan.priorities")} subtitle={t("plan.prioritiesSub")} />
        <div className="w-56">
          <Field label={t("plan.water")}>
            {(id) => (
              <Select id={id} value={irrigation} onChange={(event) => onIrrigation(event.target.value as Irrigation)}>
                {IRRIGATIONS.map((key) => (
                  <option key={key} value={key}>
                    {t(`farms.irrigation.${key}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PILLARS.map((key) => (
          <div key={key}>
            <label htmlFor={`weight-${key}`} className="flex items-baseline justify-between text-sm font-medium text-stone-800">
              <span>{t(`plan.pillar.${key}`)}</span>
              <span className="text-lg font-semibold tabular-nums text-emerald-700">{weights[key]}</span>
            </label>
            <input
              id={`weight-${key}`}
              type="range"
              min={0}
              max={5}
              step={1}
              value={weights[key]}
              onChange={(event) => set(key, Number(event.target.value))}
              className="mt-1 w-full accent-emerald-700"
            />
            <p className="text-xs leading-snug text-stone-500">{t(`plan.pillarHelp.${key}`)}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" busy={save.isPending} disabled={same(weights, stored)} onClick={() => save.mutate(weights)}>
          {t("plan.savePriorities")}
        </Button>
        {save.isSuccess && same(weights, stored) && <span className="text-sm text-emerald-700">{t("plan.prioritiesSaved")}</span>}
      </div>
      {save.error && (
        <div className="mt-3">
          <Alert tone="error">{save.error.message}</Alert>
        </div>
      )}
      </div>}
    </div>
  );
}

export function PlanPanel({ farm, onOpenTab }: { farm: Farm; onOpenTab?: (tab: StoryTab) => void }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const mode = MODES.includes(params.get("mode") as Mode) ? params.get("mode") as Mode : "next";
  const setMode = (value: Mode) => setParams((current) => { current.set("mode", value); return current; });
  const [irrigation, setIrrigation] = useState<Irrigation>(farm.irrigation);
  const [weights, setWeights] = useState<Priorities>(farm.priorities ?? DEFAULT_PRIORITIES);
  const applied = useDebounced(weights, 600);

  return (
    <div className="space-y-6">
      <PrioritiesCard farm={farm} weights={weights} onChange={setWeights} irrigation={irrigation} onIrrigation={setIrrigation} />
      <Segmented label={t("farm.tabs.plan")} value={mode} onChange={setMode} items={MODES.map((key) => ({ key, label: t(`plan.mode.${key}`) }))} />
      <div>
        {mode === "next" && (
          <NextCropView farm={farm} irrigation={irrigation} weights={applied} onOpenTab={onOpenTab} />
        )}
        {mode === "rotations" && <RotationsView farm={farm} irrigation={irrigation} weights={applied} />}
        {mode === "saved" && <SavedPlans farm={farm} />}
      </div>
      <AboutData><p>{t("plan.disclaimer")}</p></AboutData>
    </div>
  );
}
