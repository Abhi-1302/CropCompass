import { useTranslation } from "react-i18next";
import type { SoilLayer } from "../../api/types";
import { cx } from "../../components/ui";
import { monthName } from "../../lib/format";
import type { RootZone, Sky, Verdict } from "./model";
import { VERDICT_TONE } from "./model";

/** A to-scale cross-section of the field: sky and weather above, soil layers, root zone and soil water below. */

const W = 800;
const H = 400;
const SURFACE = 124;
const BOTTOM = 372;
const LEFT = 64;
const RIGHT = 600; // annotations live to the right of this
const PLANTS = 7;

type Props = {
  soilDepthCm: number;
  depthAssumed: boolean;
  layers: SoilLayer[];
  waterFraction: number | null;
  sky: Sky | null;
  crop: { key: string; verdict: Verdict; zone: RootZone; wilted: boolean } | null;
  label: string;
};

function parseDepth(depth: string): [number, number] | null {
  const match = depth.match(/(\d+)\s*-\s*(\d+)/);
  return match ? [Number(match[1]) / 100, Number(match[2]) / 100] : null;
}

function Plant({ x, verdict, wilted }: { x: number; verdict: Verdict; wilted: boolean }) {
  const height = verdict === "good" ? 78 : verdict === "watch" ? 64 : 48;
  const droop = wilted || verdict === "poor" || verdict === "blocked";
  const leaves = [0.32, 0.55, 0.78].map((share, index) => {
    const y = -height * share;
    const side = index % 2 === 0 ? -1 : 1;
    const tipY = droop ? y + 14 : y - 10;
    return `M0 ${y} Q ${side * 12} ${y - 12} ${side * 26} ${tipY} Q ${side * 10} ${y - 2} 0 ${y}`;
  });
  return (
    <g transform={`translate(${x} ${SURFACE})`}>
      <g stroke="currentColor" className={cx("field-plant", VERDICT_TONE[verdict].plant)}>
        <path d={`M0 0 L0 ${-height}`} strokeWidth="2" fill="none" />
        {leaves.map((d) => (
          <path key={d} d={d} strokeWidth="1.4" fill="currentColor" fillOpacity="0.55" />
        ))}
        {!droop && <ellipse cx="0" cy={-height - 7} rx="4" ry="9" strokeWidth="1.6" className="fill-amber-200" />}
      </g>
    </g>
  );
}

function Roots({ x, bottom }: { x: number; bottom: number }) {
  const depth = bottom - SURFACE;
  const branches = [0.2, 0.38, 0.56, 0.74].map((share, index) => {
    const y = SURFACE + depth * share;
    const side = index % 2 === 0 ? -1 : 1;
    const reach = 20 * (1 - share * 0.6);
    return `M${x} ${y} q ${side * reach * 0.6} ${depth * 0.04} ${side * reach} ${depth * 0.12}`;
  });
  return (
    <g className="field-roots stroke-amber-700" fill="none" strokeLinecap="round">
      <path d={`M${x} ${SURFACE} C ${x - 3} ${SURFACE + depth * 0.4}, ${x + 3} ${SURFACE + depth * 0.7}, ${x} ${bottom}`} strokeWidth="1.6" />
      {branches.map((d) => (
        <path key={d} d={d} strokeWidth="1" opacity="0.8" />
      ))}
    </g>
  );
}

function Sun({ hot }: { hot: boolean }) {
  return (
    <g transform="translate(742 52)" className={hot ? "stroke-amber-500" : "stroke-stone-400"} strokeWidth="1.6" strokeLinecap="round">
      <circle r={hot ? 15 : 12} className={hot ? "fill-amber-200" : "fill-stone-200"} />
      {hot && Array.from({ length: 8 }, (_, index) => {
        const angle = (index * Math.PI) / 4;
        return (
          <line key={index} x1={Math.cos(angle) * 21} y1={Math.sin(angle) * 21} x2={Math.cos(angle) * 28} y2={Math.sin(angle) * 28} />
        );
      })}
    </g>
  );
}

function Rain() {
  return (
    <g transform="translate(650 26)" strokeLinecap="round">
      <path d="M0 22 a14 14 0 0 1 14 -14 a18 18 0 0 1 33 4 a11 11 0 0 1 1 22 h-44 a9 9 0 0 1 -4 -12z" className="fill-stone-200 stroke-stone-400" strokeWidth="1.2" />
      {[6, 18, 30, 42].map((x) => (
        <line key={x} x1={x} y1="42" x2={x - 5} y2="56" className="stroke-sky-500" strokeWidth="1.6" />
      ))}
    </g>
  );
}

function Wind() {
  return (
    <g transform="translate(640 34)" fill="none" className="stroke-stone-400" strokeWidth="1.6" strokeLinecap="round">
      <path d="M0 6 h40 a7 7 0 1 0 -7 -7" />
      <path d="M8 20 h52 a7 7 0 1 1 -7 7" />
      <path d="M0 34 h30" />
    </g>
  );
}

export function FieldScene({ soilDepthCm, depthAssumed, layers, waterFraction, sky, crop, label }: Props) {
  const { t } = useTranslation();
  const soilM = soilDepthCm / 100;
  const maxM = Math.min(2, Math.max(1, Math.ceil(Math.max(soilM, crop?.zone.rootM ?? 0) * 2 + 0.01) / 2));
  const y = (depthM: number) => SURFACE + (Math.min(depthM, maxM) / maxM) * (BOTTOM - SURFACE);
  const soilBottom = y(soilM);
  const bands = layers
    .map((layer) => ({ range: parseDepth(layer.depth), texture: layer.texture }))
    .filter((band): band is { range: [number, number]; texture: string | undefined } => band.range !== null && band.range[0] < soilM);
  const wetZone = crop ? y(crop.zone.effectiveM) : y(Math.min(soilM, 1));
  const wet = waterFraction ?? 0;
  const xs = Array.from({ length: PLANTS }, (_, index) => LEFT + 40 + index * ((RIGHT - LEFT - 80) / (PLANTS - 1)));
  const ticks = Array.from({ length: Math.round(maxM / 0.5) + 1 }, (_, index) => index * 0.5);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full select-none">
      {/* Sky and weather */}
      <rect x="0" y="0" width={W} height={SURFACE} className="fill-sky-50" />
      {sky?.windy && <Wind />}
      {sky?.wet && <Rain />}
      {sky && !sky.wet && <Sun hot={sky.hot} />}
      {sky && (
        <text x="16" y="28" className="tabular fill-stone-600 text-[12px]">
          {[
            t("field.monthNormal", { month: monthName(sky.month.month) }),
            t("field.tmax", { value: sky.month.tmax_c.toFixed(0) }),
            `${Math.round(sky.month.rain_mm)} mm`,
            sky.month.wind_ms != null ? t("field.wind", { value: sky.month.wind_ms.toFixed(1) }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </text>
      )}

      <rect x="0" y={SURFACE} width={W} height={H - SURFACE} className="fill-amber-50" />
      {bands.map((band, index) => (
        <rect
          key={band.range.join("-")}
          x="0"
          y={y(band.range[0])}
          width={W}
          height={y(Math.min(band.range[1], soilM)) - y(band.range[0])}
          className={index % 2 ? "fill-amber-100" : "fill-amber-50"}
        />
      ))}
      {soilM < maxM && (
        <g>
          <rect x="0" y={soilBottom} width={W} height={H - soilBottom} className="fill-stone-100" />
          <line x1="0" x2={RIGHT + 20} y1={soilBottom} y2={soilBottom} className="stroke-stone-400" strokeDasharray="4 4" />
          <text x={LEFT + 8} y={Math.min(BOTTOM - 8, soilBottom + 20)} className="fill-stone-500 text-[11px]">
            {t("field.restrictive")}
          </text>
        </g>
      )}

      {/* Soil water in the root zone (modelled, not groundwater) */}
      <rect
        x="53"
        y={SURFACE}
        width={RIGHT + 20 - 53}
        height={wetZone - SURFACE}
        className="fill-sky-500 transition-[opacity] duration-500"
        opacity={0.06 + 0.3 * wet}
      />

      {/* Crop */}
      {crop && (
        <g key={crop.key} className="field-grow">
          {xs.map((x) => (
            <Roots key={`r${x}`} x={x} bottom={y(crop.zone.effectiveM)} />
          ))}
          {xs.map((x) => (
            <Plant key={`p${x}`} x={x} verdict={crop.verdict} wilted={crop.wilted} />
          ))}
          <line x1={LEFT} x2={RIGHT} y1={y(crop.zone.effectiveM)} y2={y(crop.zone.effectiveM)} className="stroke-amber-700" strokeDasharray="5 4" />
        </g>
      )}

      {/* Ground line */}
      <line x1="0" x2={W} y1={SURFACE} y2={SURFACE} className="stroke-stone-500" strokeWidth="1.5" />

      {/* Depth axis */}
      <g className="fill-stone-500 text-[11px]">
        <text x="12" y={SURFACE + 16} className="fill-stone-500">{t("field.depth")}</text>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1="44" x2="52" y1={y(tick)} y2={y(tick)} className="stroke-stone-400" />
            <text x="40" y={tick === 0 ? y(tick) - 4 : y(tick) + 4} textAnchor="end" className="tabular">
              {tick.toFixed(1)} m
            </text>
          </g>
        ))}
        <line x1="52" x2="52" y1={SURFACE} y2={BOTTOM} className="stroke-stone-400" />
      </g>

      {/* Annotations */}
      <line x1={RIGHT + 20} x2={RIGHT + 20} y1={SURFACE} y2={soilBottom} className="stroke-stone-400" />
      <foreignObject x={RIGHT + 30} y={SURFACE + 8} width={W - RIGHT - 40} height={BOTTOM - SURFACE - 8}>
        <div className="space-y-3 break-words text-xs leading-snug text-stone-600">
          {waterFraction != null && (
            <div className="text-sky-700">
              <div className="mb-1 h-2 overflow-hidden rounded bg-stone-200">
                <div className="h-full bg-sky-500" style={{ width: `${100 * Math.max(0, Math.min(1, waterFraction))}%` }} />
              </div>
              <p>{t("field.waterNowLabel", { pct: Math.round(waterFraction * 100) })}</p>
            </div>
          )}
          <div>
            <p className="font-semibold">{t("field.soilDepth", { value: soilM.toFixed(1) })}</p>
            <p>{t(depthAssumed ? "soil.depthAssumed" : "soil.depthEntered")}</p>
          </div>
          {crop && (
            <p className="font-semibold text-amber-700">
              {crop.zone.limited
                ? t("field.rootsLimited", { value: crop.zone.effectiveM.toFixed(1) })
                : t("field.rootsLabel", { value: crop.zone.rootM.toFixed(1) })}
            </p>
          )}
        </div>
      </foreignObject>
    </svg>
  );
}
