"""Area, centre and validity of a field boundary drawn on the map (fields are small: a local flat projection)."""

from __future__ import annotations

import math

METRES_PER_DEGREE = math.radians(1) * 6_371_008.8
MAX_SPAN_DEG = 0.5  # about 50 km
MIN_AREA_M2 = 100.0
MAX_AREA_HA = 100_000.0


class BoundaryError(ValueError):
    pass


def _cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _segments_cross(p1, p2, q1, q2) -> bool:
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def _self_intersects(points: list[tuple[float, float]]) -> bool:
    n = len(points)
    edges = [(points[i], points[(i + 1) % n]) for i in range(n)]
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # the first and last sides share a corner
            if _segments_cross(*edges[i], *edges[j]):
                return True
    return False


def field_shape(ring: list[tuple[float, float]]) -> tuple[float, float, float]:
    """(area in ha, centre latitude, centre longitude) of a closed [lon, lat] ring."""
    corners = ring[:-1]
    lons, lats = [c[0] for c in corners], [c[1] for c in corners]
    if max(lons) - min(lons) > MAX_SPAN_DEG or max(lats) - min(lats) > MAX_SPAN_DEG:
        raise BoundaryError("A field boundary must fit within about 50 km.")
    lon0, lat0 = corners[0]
    scale_x = METRES_PER_DEGREE * math.cos(math.radians(lat0))
    points = [((lon - lon0) * scale_x, (lat - lat0) * METRES_PER_DEGREE) for lon, lat in corners]
    if _self_intersects(points):
        raise BoundaryError("The sides of the boundary cross each other.")
    twice_area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1], strict=True):
        step = x0 * y1 - x1 * y0
        twice_area += step
        cx += (x0 + x1) * step
        cy += (y0 + y1) * step
    area_m2 = abs(twice_area) / 2
    if area_m2 < MIN_AREA_M2:
        raise BoundaryError("The field is too small to draw (under 0.01 ha).")
    if area_m2 / 10_000 > MAX_AREA_HA:
        raise BoundaryError("The field is too large.")
    cx, cy = cx / (3 * twice_area), cy / (3 * twice_area)
    return area_m2 / 10_000, lat0 + cy / METRES_PER_DEGREE, lon0 + cx / scale_x
