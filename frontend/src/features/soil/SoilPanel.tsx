import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useClimate, useSaveSoil, useSoil } from "../../api/hooks";
import type { SoilOverride, SoilProfile, SoilSummary, SoilType } from "../../api/types";
import { AboutData, Alert, Badge, Button, Card, Field, Input, PageSpinner, SectionHeader, Select } from "../../components/ui";
import { SoilProfileView } from "./SoilProfileView";

type Preset = { sand_pct: number; silt_pct: number; clay_pct: number; awc_mm_per_m: number; depth_cm: number };

/** Typical values for India's main soil groups; the farmer can change any of them. */
const PRESETS: Record<Exclude<SoilType, "custom">, Preset> = {
  black: { sand_pct: 20, silt_pct: 25, clay_pct: 55, awc_mm_per_m: 180, depth_cm: 100 },
  red: { sand_pct: 65, silt_pct: 13, clay_pct: 22, awc_mm_per_m: 90, depth_cm: 50 },
  alluvial: { sand_pct: 40, silt_pct: 40, clay_pct: 20, awc_mm_per_m: 150, depth_cm: 150 },
  laterite: { sand_pct: 50, silt_pct: 15, clay_pct: 35, awc_mm_per_m: 80, depth_cm: 75 },
  sandy: { sand_pct: 85, silt_pct: 8, clay_pct: 7, awc_mm_per_m: 60, depth_cm: 100 },
};
const SOIL_TYPES: SoilType[] = ["black", "red", "alluvial", "laterite", "sandy", "custom"];
const DEPTHS = [30, 50, 75, 100, 150] as const;

const text = (value: number | null | undefined) => (value == null ? "" : String(value));

type Draft = { soil_type: SoilType } & Record<
  "sand_pct" | "silt_pct" | "clay_pct" | "awc_mm_per_m" | "depth_cm" | "organic_carbon_pct" | "ph",
  string
>;

function draftFrom(soil: SoilProfile): Draft {
  const own = soil.override ?? {};
  const effective = soil.effective;
  return {
    soil_type: own.soil_type ?? "custom",
    sand_pct: text(effective.sand_pct),
    silt_pct: text(effective.silt_pct),
    clay_pct: text(effective.clay_pct),
    awc_mm_per_m: text(own.awc_mm_per_m),
    depth_cm: text(own.depth_cm),
    organic_carbon_pct: text(effective.organic_carbon_pct),
    ph: text(effective.ph),
  };
}

function toOverride(draft: Draft): SoilOverride {
  const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
  return {
    soil_type: draft.soil_type,
    sand_pct: number(draft.sand_pct),
    silt_pct: number(draft.silt_pct),
    clay_pct: number(draft.clay_pct),
    awc_mm_per_m: number(draft.awc_mm_per_m),
    depth_cm: number(draft.depth_cm),
    organic_carbon_pct: number(draft.organic_carbon_pct),
    ph: number(draft.ph),
  };
}

function SoilEditor({ farmId, soil, onClose }: { farmId: string; soil: SoilProfile; onClose: () => void }) {
  const { t } = useTranslation();
  const save = useSaveSoil(farmId);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(soil));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  function choose(type: SoilType) {
    const preset = type === "custom" ? null : PRESETS[type];
    setDraft((current) => ({
      ...current,
      soil_type: type,
      ...(preset && {
        sand_pct: String(preset.sand_pct),
        silt_pct: String(preset.silt_pct),
        clay_pct: String(preset.clay_pct),
        awc_mm_per_m: String(preset.awc_mm_per_m),
        depth_cm: String(preset.depth_cm),
      }),
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const values = toOverride(draft);
    const parts = [values.sand_pct, values.silt_pct, values.clay_pct];
    if (parts.some((part) => part !== undefined)) {
      if (parts.some((part) => part === undefined)) {
        setProblem(t("soil.textureAll"));
        return;
      }
      const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
      if (total < 98 || total > 102) {
        setProblem(t("soil.textureSum", { total: Math.round(total) }));
        return;
      }
    }
    setProblem(null);
    save.mutate(values, { onSuccess: onClose });
  }

  return (
    <Card>
      <SectionHeader title={t("soil.editTitle")} subtitle={t("soil.editSub")} />
      <form className="space-y-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("soil.soilType")} hint={draft.soil_type !== "custom" ? t("soil.presetHint") : undefined}>
            {(id) => (
              <Select id={id} value={draft.soil_type} onChange={(event) => choose(event.target.value as SoilType)}>
                {SOIL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`soil.type.${type}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("soil.depthLabel")} hint={t("soil.depthHint")}>
            {(id) => (
              <Select id={id} value={draft.depth_cm} onChange={set("depth_cm")}>
                <option value="">{t("soil.depthUnknown")}</option>
                {draft.depth_cm && !DEPTHS.some((depth) => String(depth) === draft.depth_cm) && (
                  <option value={draft.depth_cm}>{draft.depth_cm} cm</option>
                )}
                {DEPTHS.map((depth) => (
                  <option key={depth} value={depth}>
                    {t(`soil.depthOption.${depth}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {(["sand_pct", "silt_pct", "clay_pct"] as const).map((key) => (
            <Field key={key} label={t(`soil.${key}`)}>
              {(id) => (
                <Input id={id} type="number" min="0" max="100" step="any" inputMode="decimal" value={draft[key]} onChange={set(key)} />
              )}
            </Field>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("soil.awcLabel")} hint={t("soil.awcHint")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min="30"
                max="300"
                step="5"
                inputMode="numeric"
                value={draft.awc_mm_per_m}
                onChange={set("awc_mm_per_m")}
              />
            )}
          </Field>
          <Field label={t("soil.ocLabel")} hint={t("soil.optional")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min="0"
                max="10"
                step="0.01"
                inputMode="decimal"
                value={draft.organic_carbon_pct}
                onChange={set("organic_carbon_pct")}
              />
            )}
          </Field>
          <Field label={t("soil.phLabel")} hint={t("soil.optional")}>
            {(id) => (
              <Input id={id} type="number" min="3" max="11" step="0.1" inputMode="decimal" value={draft.ph} onChange={set("ph")} />
            )}
          </Field>
        </div>
        {(problem || save.error) && <Alert tone="error">{problem ?? save.error?.message}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("soil.cancel")}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {t("soil.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SoilPanel({ farmId, verified }: { farmId: string; verified: boolean }) {
  const { t } = useTranslation();
  const soil = useSoil(farmId, true);
  const climate = useClimate(farmId, verified);
  const save = useSaveSoil(farmId);
  const [editing, setEditing] = useState(false);
  if (soil.isPending) return <PageSpinner />;
  if (soil.isError) return <Alert tone="error">{soil.error.message}</Alert>;

  const data = soil.data;
  const summary = "topsoil" in data.summary ? (data.summary as SoilSummary) : null;
  const source = data.effective.source;
  const depthAssumed = data.override?.depth_cm == null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-stone-900">{t("soil.used")}</h2>
            <Badge tone={source === "farmer" ? "green" : source === "soilgrids" ? "sky" : "amber"}>
              {t(`soil.source.${source}`)}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-stone-500">
            {!summary && source !== "farmer" ? t("soil.unavailable") : depthAssumed ? t("soil.depthAssumptionNote") : t("soil.vis.yours")}
          </p>
        </div>
        {!editing && (
          <div className="flex flex-wrap gap-2">
            {data.override && (
              <Button variant="ghost" size="sm" busy={save.isPending} onClick={() => save.mutate(null)}>
                {t("soil.reset")}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-tour-id="soil-edit">
              {t("soil.edit")}
            </Button>
          </div>
        )}
      </div>
      {save.isSuccess && !editing && <Alert tone="info">{t("soil.saved")}</Alert>}
      {editing ? (
        <SoilEditor farmId={farmId} soil={data} onClose={() => setEditing(false)} />
      ) : (
        <Card>
          <SoilProfileView soil={data.effective} summary={summary} soilNow={climate.data?.soil_now ?? null} depthAssumed={depthAssumed} />
        </Card>
      )}
      <AboutData><p>{t("soil.sourceNote")}</p></AboutData>
    </div>
  );
}
