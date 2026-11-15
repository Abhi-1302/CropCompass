import { useState } from "react";
import { cx } from "./ui";

/**
 * A static satellite view of the farm: a block of Esri World Imagery tiles centred on the field,
 * with the drawn boundary (or a pin) on top. Plain <img> tiles, no map library.
 */

const TILE = 256;
const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

function project(lat: number, lon: number, zoom: number): [number, number] {
  const scale = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * scale;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  return [x * TILE, y * TILE];
}

export function SatelliteThumb({ lat, lon, boundary, zoom = 16, cols = 3, rows = 3, label, className }: {
  lat: number;
  lon: number;
  boundary?: { coordinates: number[][][] } | null;
  zoom?: number;
  /** Tiles across and down; odd numbers keep the field in the middle tile. */
  cols?: number;
  rows?: number;
  label: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [px, py] = project(lat, lon, zoom);
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  const halfX = Math.floor(cols / 2);
  const halfY = Math.floor(rows / 2);
  const originX = (tx - halfX) * TILE;
  const originY = (ty - halfY) * TILE;
  const ring = boundary?.coordinates[0]
    ?.map(([x, y]) => project(y, x, zoom))
    .map(([x, y]) => `${x - originX},${y - originY}`)
    .join(" ");

  return (
    <div
      role="img"
      aria-label={label}
      className={cx("relative overflow-hidden bg-stone-200", className)}
    >
      {!failed && (
        <div
          className="absolute"
          style={{ width: TILE * cols, height: TILE * rows, left: `calc(50% - ${px - originX}px)`, top: `calc(50% - ${py - originY}px)` }}
        >
          {Array.from({ length: rows }, (_, row) => row).flatMap((row) =>
            Array.from({ length: cols }, (_, col) => col).map((col) => (
              <img
                key={`${row}-${col}`}
                src={`${TILES}/${zoom}/${ty - halfY + row}/${tx - halfX + col}`}
                alt=""
                width={TILE}
                height={TILE}
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setFailed(true)}
                className="absolute max-w-none select-none"
                style={{ left: col * TILE, top: row * TILE }}
              />
            )),
          )}
          <svg width={TILE * cols} height={TILE * rows} className="absolute inset-0" aria-hidden="true">
            {ring ? (
              <polygon points={ring} fill="rgb(16 185 129 / 0.18)" stroke="#34d399" strokeWidth="2" strokeLinejoin="round" />
            ) : (
              <g transform={`translate(${px - originX} ${py - originY})`}>
                <circle r="11" fill="none" stroke="white" strokeOpacity="0.9" strokeWidth="2" />
                <circle r="3.5" fill="#34d399" stroke="white" strokeWidth="1.5" />
              </g>
            )}
          </svg>
        </div>
      )}
      <span className="pointer-events-none absolute right-1.5 bottom-1 text-[9px] text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
        Esri, Maxar
      </span>
    </div>
  );
}
