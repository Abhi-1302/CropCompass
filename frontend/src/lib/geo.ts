/** Area (ha) and centre of a small field from its [lat, lon] corners, as the server computes them. */
const METRES_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;

export type LatLon = [number, number];

export function fieldShape(corners: LatLon[]): { areaHa: number; lat: number; lon: number } | null {
  if (corners.length < 3) return null;
  const [lat0, lon0] = corners[0];
  const scaleX = METRES_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const points = corners.map(([lat, lon]) => [(lon - lon0) * scaleX, (lat - lat0) * METRES_PER_DEGREE]);
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  points.forEach(([x0, y0], index) => {
    const [x1, y1] = points[(index + 1) % points.length];
    const step = x0 * y1 - x1 * y0;
    twiceArea += step;
    cx += (x0 + x1) * step;
    cy += (y0 + y1) * step;
  });
  if (Math.abs(twiceArea) < 1e-6) return null;
  return {
    areaHa: Math.abs(twiceArea) / 2 / 10_000,
    lat: lat0 + cy / (3 * twiceArea) / METRES_PER_DEGREE,
    lon: lon0 + cx / (3 * twiceArea) / scaleX,
  };
}
