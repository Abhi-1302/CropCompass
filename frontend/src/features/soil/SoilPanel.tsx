import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSaveSoil, useSoil } from "../../api/hooks";
import type { EffectiveSoil, SoilOverride, SoilProfile, SoilSummary, SoilType } from "../../api/types";
import { Alert, Badge, Button, Card, Field, Input, PageSpinner, SectionHeader, Select } from "../../components/ui";
import type en from "../../locales/en.json";
import type { T } from "../crops/text";

type TextureName = keyof typeof en.soil.textureName;
type PhClass = keyof typeof en.soil.phClass;
type CecClass = keyof typeof en.soil.cecClass;
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

const textureLabel = (t: T, value: string | null | undefined) =>
  value ? t(`soil.textureName.${value as TextureName}`) : "—";
const fraction = (value: number | undefined) => (value == null ? "—" : value.toFixed(2));
const text = (value: number | null | undefined) => (value == null ? "" : String(value));

function Stat({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <Card>
      <p className="text-sm font-medium text-stone-500">{title}</p>
      <p className="mt-2 text-xl font-semibold text-stone-900">{value}</p>
      {detail && <p className="mt-1 text-sm text-stone-600">{detail}</p>}
    </Card>
  );
}

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
    depth_cm: String(effective.depth_cm),
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
          <Field label={t("soil.depthLabel")}>
            {(id) => (
              <Select id={id} value={draft.depth_cm} onChange={set("depth_cm")}>
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
                <Input id={id} type="number" min="0" max="100" step="1" inputMode="decimal" value={draft[key]} onChange={set(key)} />
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

function MapLayers({ summary }: { summary: SoilSummary }) {
  const { t } = useTranslation();
  return (
    <Card>
      <SectionHeader title={t("soil.layers")} subtitle={t("soil.layersSub")} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-stone-200 text-xs tracking-wide text-stone-500 uppercase">
            <tr>
              <th className="py-2 pr-4 font-medium">{t("soil.depth")}</th>
              <th className="py-2 pr-4 font-medium">{t("soil.textureColumn")}</th>
              <th className="py-2 pr-4 font-medium">{t("soil.fc")}</th>
              <th className="py-2 pr-4 font-medium">{t("soil.wp")}</th>
              <th className="py-2 font-medium">{t("soil.aw")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 tabular-nums">
            {summary.layers.map((layer) => (
              <tr key={layer.depth}>
                <td className="py-2 pr-4 font-medium">{layer.depth}</td>
                <td className="py-2 pr-4">{textureLabel(t, layer.texture)}</td>
                <td className="py-2 pr-4">{fraction(layer.field_capacity)}</td>
                <td className="py-2 pr-4">{fraction(layer.wilting_point)}</td>
                <td className="py-2">{fraction(layer.available_water)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SoilFacts({ soil, summary }: { soil: EffectiveSoil; summary: SoilSummary | null }) {
  const { t } = useTranslation();
  const top = summary?.topsoil;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Stat
        title={t("soil.texture")}
        value={textureLabel(t, soil.texture)}
        detail={
          soil.clay_pct != null
            ? t("soil.textureDetail", { sand: soil.sand_pct, silt: soil.silt_pct, clay: soil.clay_pct })
            : undefined
        }
      />
      <Stat
        title={t("soil.water")}
        value={t("soil.waterValue", { mm: soil.awc_mm })}
        detail={t("soil.waterDetail", { depth: soil.depth_cm, perMetre: soil.awc_mm_per_m })}
      />
      <Stat
        title={t("soil.carbon")}
        value={soil.organic_carbon_pct != null ? `${soil.organic_carbon_pct}%` : "—"}
        detail={soil.soc_stock_t_ha_0_30cm != null ? t("soil.carbonDetail", { stock: soil.soc_stock_t_ha_0_30cm }) : undefined}
      />
      <Stat
        title={t("soil.ph")}
        value={soil.ph != null ? soil.ph.toFixed(1) : "—"}
        detail={soil.ph_class ? t(`soil.phClass.${soil.ph_class as PhClass}`) : undefined}
      />
      {top && (
        <Stat
          title={t("soil.cec")}
          value={top.cec_class ? t(`soil.cecClass.${top.cec_class as CecClass}`) : "—"}
          detail={top.cec_cmol_kg != null ? t("soil.cecDetail", { value: top.cec_cmol_kg }) : undefined}
        />
      )}
      {top && (
        <Stat
          title={t("soil.nitrogen")}
          value={top.nitrogen_g_kg != null ? t("soil.nitrogenValue", { value: top.nitrogen_g_kg }) : "—"}
        />
      )}
    </div>
  );
}

export function SoilPanel({ farmId }: { farmId: string }) {
  const { t } = useTranslation();
  const soil = useSoil(farmId, true);
  const save = useSaveSoil(farmId);
  const [editing, setEditing] = useState(false);
  if (soil.isPending) return <PageSpinner />;
  if (soil.isError) return <Alert tone="error">{soil.error.message}</Alert>;

  const data = soil.data;
  const summary = "topsoil" in data.summary ? (data.summary as SoilSummary) : null;
  const source = data.effective.source;
  return (
    <div className="space-y-6">
      {!summary && source !== "farmer" && <Alert tone="info">{t("soil.unavailable")}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-stone-900">{t("soil.used")}</h2>
          <Badge tone={source === "farmer" ? "green" : source === "soilgrids" ? "sky" : "amber"}>
            {t(`soil.source.${source}`)}
          </Badge>
        </div>
        {!editing && (
          <div className="flex flex-wrap gap-2">
            {data.override && (
              <Button variant="ghost" size="sm" busy={save.isPending} onClick={() => save.mutate(null)}>
                {t("soil.reset")}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {t("soil.edit")}
            </Button>
          </div>
        )}
      </div>
      {save.isSuccess && !editing && <Alert tone="info">{t("soil.saved")}</Alert>}
      {editing ? (
        <SoilEditor farmId={farmId} soil={data} onClose={() => setEditing(false)} />
      ) : (
        <SoilFacts soil={data.effective} summary={summary} />
      )}
      {summary && <MapLayers summary={summary} />}
      <p className="text-xs text-stone-500">{t("soil.sourceNote")}</p>
    </div>
  );
}
