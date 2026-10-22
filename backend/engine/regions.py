"""Region packs: which rule set applies at a location."""

from __future__ import annotations

# Approximate India bounding box; replace with country boundaries when more region packs exist.
_INDIA = (6.0, 37.5, 68.0, 97.5)


def region_for(lat: float, lon: float) -> str | None:
    south, north, west, east = _INDIA
    return "IN" if south <= lat <= north and west <= lon <= east else None
