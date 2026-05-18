"""Korean coastal static hazard zones loaded from GeoJSON."""
import json
import logging
import os
from functools import lru_cache
from typing import Any

from shapely.geometry import shape, Polygon

logger = logging.getLogger(__name__)

_GEOJSON_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "static_hazards.geojson"
)


@lru_cache(maxsize=1)
def _raw_features() -> tuple[dict, ...]:
    with open(_GEOJSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    logger.info("Loaded %d static hazard features from %s", len(data["features"]), _GEOJSON_PATH)
    return tuple(data["features"])


@lru_cache(maxsize=1)
def _shaped() -> tuple[tuple[dict, Any], ...]:
    return tuple((f, shape(f["geometry"])) for f in _raw_features())


def load() -> list[dict]:
    """Return list of GeoJSON Feature dicts (raw, immutable)."""
    return list(_raw_features())


def intersecting(cell: Polygon) -> list[dict]:
    """Return features whose geometry intersects the given cell polygon."""
    return [feat for feat, geom in _shaped() if cell.intersects(geom)]
