import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EffectiveSoil, SoilLayer, SoilNow, SoilSummary } from "../../api/types";
import { mm } from "../../lib/format";

/** The soil the models use, drawn to scale: horizons with their texture and water store, a water gauge, and topsoil chemistry. */

type HorizonKey = "top" | "sub" | "deep" | "deeper";
const GROUPS: [HorizonKey, number, number][] = [
  ["top", 0, 30],
  ["sub", 30, 60],
  ["deep", 60, 100],
  ["deeper", 100, Infinity],
];
const SHADES = ["var(--soil-1)", "var(--soil-2)", "var(--soil-3)", "var(--soil-4)"];
const PROFILE_PX = 320;

/** Dot size and spacing per texture: coarse sands get a big open grain, clays a fine dense one. */
const GRAIN: Record<string, [number, number]> = {
  sand: [1.8, 8],
  "loamy sand": [1.6, 8],
  "sandy loam": [1.35, 8],
  "sandy clay loam": [1.2, 8],
  "sandy clay": [1.1, 7],
  loam: [1.05, 8],
  "silt loam": [0.9, 7],
  silt: [0.8, 6],
  "clay loam": [0.85, 6],
  "silty clay loam": [0.75, 6],
  "silty clay": [0.65, 5],
  clay: [0.6, 5],
};

type Horizon = { key: HorizonKey; top: number; bottom: number; texture: string | null; mm: number };

function parseDepth(depth: string): [number, number] | null {
  const match = depth.match(/(\d+)\s*-\s*(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Group the soil-map layers into the horizons a farmer would name, and share the model's water store between them. */
function horizonsOf(soil: EffectiveSoil, layers: SoilLayer[]): Horizon[] {
  const depth = soil.depth_cm;
  const fromMap = soil.source === "soilgrids" && layers.length > 0;
  const parsed = layers
    .map((layer) => ({ range: parseDepth(layer.depth), layer }))
    .filter((entry): entry is { range: [number, number]; layer: SoilLayer } => entry.range !== null);

  const raw = GROUPS.filter(([, top]) => top < depth).map(([key, top, bottom]) => {
    const end = Math.min(bottom, depth);
    let texture: string | null = fromMap ? null : soil.texture;
    let awSum = 0;
    let awWeight = 0;
    let thickest = 0;
    if (fromMap) {
      for (const { range, layer } of parsed) {
        const overlap = Math.max(0, Math.min(range[1], end) - Math.max(range[0], top));
        if (!overlap) continue;
        if (layer.available_water != null) {
          awSum += layer.available_water * overlap;
          awWeight += overlap;
        }
        if (layer.texture && overlap > thickest) {
          thickest = overlap;
          texture = layer.texture;
        }
      }
    }
    const aw = awWeight ? awSum / awWeight : soil.awc_mm_per_m / 1000;
    return { key, top, bottom: end, texture: texture ?? soil.texture, raw: aw * (end - top) * 10 };
  });
  const total = raw.reduce((sum, horizon) => sum + horizon.raw, 0) || 1;
  return raw.map(({ raw: share, ...horizon }) => ({ ...horizon, mm: (share / total) * soil.awc_mm }));
}

function Gauge({ label, value, caption, children }: { label: string; value: string; caption?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-stone-500">{label}</p>
        <p className="tabular text-sm font-semibold text-stone-900">{value}</p>
      </div>
      <div className="mt-2">{children}</div>
      {caption && <p className="mt-1.5 text-xs text-stone-500">{caption}</p>}
    </div>
  );
}

/** A bar with a marker at `value`; `background` paints the bands, `ticks` sit evenly underneath. */
function Scale({ min, max, value, background, ticks }: { min: number; max: number; value: number; background: string; ticks: string[] }) {
  const at = Math.min(1, Math.max(0, (value - min) / (max - min))) * 100;
  return (
    <div>
      <div className="relative h-2 rounded-full" style={{ background }}>
        <span
          className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stone-900 ring-2 ring-surface"
          style={{ left: `${at}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-stone-500">
        {ticks.map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

const band = (stops: [string, number][]) =>
  `linear-gradient(90deg, ${stops.map(([color, at], index) => `${color} ${index ? stops[index - 1][1] : 0}% ${at}%`).join(", ")})`;

export function SoilProfileView({ soil, summary, soilNow, depthAssumed }: {
  soil: EffectiveSoil;
  summary: SoilSummary | null;
  soilNow: SoilNow | null;
  depthAssumed: boolean;
}) {
  const { t } = useTranslation();
  const horizons = horizonsOf(soil, summary?.layers ?? []);
  const fraction = soilNow ? Math.min(1, Math.max(0, soilNow.fraction)) : null;
  const top = summary?.topsoil;
  const texture = (value: string | null) => (value ? t(`soil.textureName.${value}`, { defaultValue: value }) : t("field.soilUnknown"));
  const parts = soil.sand_pct != null && soil.silt_pct != null && soil.clay_pct != null
    ? ([
        ["sand", soil.sand_pct, "var(--soil-sand)"],
        ["silt", soil.silt_pct, "var(--soil-silt)"],
        ["clay", soil.clay_pct, "var(--soil-clay)"],
      ] as const)
    : null;
  const partsTotal = parts ? parts.reduce((sum, [, value]) => sum + value, 0) || 1 : 1;
  const depthM = (soil.depth_cm / 100).toFixed(1);
  const label = t("soil.vis.label", {
    depth: depthM,
    texture: texture(soil.texture),
    mm: Math.round(soil.awc_mm),
  });

  const hasGauges = Boolean(parts) || soil.ph != null || soil.organic_carbon_pct != null || top?.cec_cmol_kg != null || top?.nitrogen_g_kg != null;

  return (
    <div className={hasGauges ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]" : undefined}>
      <figure className="min-w-0" aria-label={label}>
        <div className="overflow-hidden rounded-xl border border-stone-200">
          <div className="relative flex flex-col" style={{ height: PROFILE_PX }}>
            {horizons.map((horizon, index) => {
              const [dot, gap] = GRAIN[horizon.texture ?? ""] ?? [1, 8];
              return (
                <div
                  key={horizon.key}
                  className="soil-grain relative min-h-12 border-b border-black/15 px-4 py-3 last:border-b-0"
                  style={{
                    flexGrow: horizon.bottom - horizon.top,
                    flexBasis: 0,
                    backgroundColor: SHADES[Math.min(index, SHADES.length - 1)],
                    "--grain-dot": `${dot}px`,
                    "--grain-gap": `${gap}px`,
                  } as CSSProperties}
                >
                  <div className="max-w-[62%]" style={{ color: "var(--soil-ink)" }}>
                    <p className="text-sm font-semibold">{t(`soil.vis.horizon.${horizon.key}`)}</p>
                    <p className="tabular text-xs" style={{ color: "var(--soil-ink-muted)" }}>
                      {[
                        t("soil.vis.range", { top: horizon.top, bottom: horizon.bottom }),
                        horizon.texture && texture(horizon.texture),
                        t("soil.vis.holds", { mm: mm(horizon.mm) }),
                      ].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              );
            })}

            {/* Water gauge for the whole root zone: capacity is the outline, water now fills from the bottom. */}
            <div className="absolute inset-y-0 right-0 w-[32%] border-l border-dashed border-sky-300/70">
              {fraction != null && <div className="soil-water absolute inset-x-0 bottom-0" style={{ height: `${fraction * 100}%` }} />}
              <div
                className="absolute inset-x-0 px-3 text-xs"
                style={{ color: "var(--soil-ink)", ...(fraction != null && fraction > 0.18 ? { bottom: `calc(${fraction * 100}% - 3.25rem)` } : { top: "0.75rem" }) }}
              >
                <p className="text-sm font-semibold">{t("soil.vis.water")}</p>
                <p className="tabular" style={{ color: "var(--soil-ink-muted)" }}>
                  {soilNow
                    ? t("soil.vis.waterNow", { mm: Math.round(soilNow.mm), capacity: Math.round(soilNow.capacity_mm) })
                    : t("soil.vis.capacity", { mm: Math.round(soil.awc_mm) })}
                </p>
              </div>
            </div>
          </div>

          {/* The modelled bottom of the profile: an assumption unless the farmer entered it. */}
          <div className="relative border-t-2 border-dashed border-stone-400 px-4 py-2.5" style={{ background: "var(--soil-below)" }}>
            <p className="text-xs text-stone-600">
              <span className="tabular font-semibold text-stone-800">{depthM} m</span> · {t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}
            </p>
            <p className="text-[11px] text-stone-500">{t("field.restrictive")}</p>
          </div>
        </div>
        <figcaption className="mt-2 text-xs text-stone-500">
          {t("soil.vis.caption", { perMetre: Math.round(soil.awc_mm_per_m) })}
        </figcaption>
      </figure>

      {hasGauges && <div className="space-y-6">
        {parts && <Gauge label={t("soil.vis.texture")} value={texture(soil.texture)}>
          {(
            <>
              <div className="flex h-2 overflow-hidden rounded-full" aria-hidden="true">
                {parts.map(([key, value, color]) => (
                  <div key={key} style={{ width: `${(value / partsTotal) * 100}%`, background: color }} />
                ))}
              </div>
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-600">
                {parts.map(([key, value, color]) => (
                  <li key={key} className="tabular inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
                    {t(`soil.vis.${key}`, { pct: Math.round(value) })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Gauge>}

        {soil.ph != null && (
          <Gauge label={t("soil.ph")} value={soil.ph.toFixed(1)} caption={soil.ph_class ? t(`soil.phClass.${soil.ph_class}`, { defaultValue: soil.ph_class }) : undefined}>
            <Scale
              min={4.5}
              max={9.5}
              value={soil.ph}
              background="linear-gradient(90deg, var(--color-red-500), var(--color-amber-500) 30%, var(--color-emerald-500) 50%, var(--color-sky-500) 72%, var(--color-sky-700))"
              ticks={[t("soil.phClass.acidic"), t("soil.phClass.neutral"), t("soil.phClass.alkaline")]}
            />
          </Gauge>
        )}

        {soil.organic_carbon_pct != null && (
          <Gauge
            label={t("soil.carbon")}
            value={`${soil.organic_carbon_pct.toFixed(2)}%`}
            caption={soil.soc_stock_t_ha_0_30cm != null ? t("soil.carbonDetail", { stock: soil.soc_stock_t_ha_0_30cm }) : undefined}
          >
            {/* Soil Health Card bands: low below 0.5%, medium to 0.75%, high above. */}
            <Scale
              min={0}
              max={1.5}
              value={soil.organic_carbon_pct}
              background={band([["var(--color-amber-400)", 33.3], ["var(--color-emerald-300)", 50], ["var(--color-emerald-600)", 100]])}
              ticks={[t("soil.vis.low"), t("soil.vis.medium"), t("soil.vis.high")]}
            />
          </Gauge>
        )}

        {top?.cec_cmol_kg != null && (
          <Gauge label={t("soil.cec")} value={t("soil.cecDetail", { value: top.cec_cmol_kg })}>
            <Scale
              min={0}
              max={40}
              value={top.cec_cmol_kg}
              background={band([["var(--color-amber-400)", 25], ["var(--color-emerald-300)", 62.5], ["var(--color-emerald-600)", 100]])}
              ticks={[t("soil.vis.low"), t("soil.vis.medium"), t("soil.vis.high")]}
            />
          </Gauge>
        )}

        {top?.nitrogen_g_kg != null && (
          <Gauge label={t("soil.nitrogen")} value={t("soil.nitrogenValue", { value: top.nitrogen_g_kg })}>
            <Scale
              min={0}
              max={2.5}
              value={top.nitrogen_g_kg}
              background="linear-gradient(90deg, var(--color-stone-200), var(--color-emerald-500))"
              ticks={["0", "2.5 g/kg"]}
            />
          </Gauge>
        )}
      </div>}
    </div>
  );
}
