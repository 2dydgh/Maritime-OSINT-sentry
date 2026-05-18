"""Korean coastal hex grid for area hazard scoring.

Defines the cell coordinates over Korean EEZ. Score computation (compute_cells,
normalize functions, top_cause) lives in this module but is added in
subsequent tasks.
"""
import logging
from backend.services import land_filter

logger = logging.getLogger(__name__)

KOREA_BBOX = (33.0, 39.5, 124.0, 132.0)  # min_lat, max_lat, min_lng, max_lng
CELL_DEG = 1.2

# Cells whose center has no land within this many degrees are considered
# deep open ocean and excluded.
_MAX_DIST_FROM_LAND_DEG = 2.0


def korea_cells() -> list[tuple[float, float]]:
    """Cell center coordinates inside KOREA_BBOX, filtered to coastal sea.

    If land_filter is not yet loaded, all cells inside bbox are returned
    (graceful degradation — caller may re-request after land data loads).
    """
    min_lat, max_lat, min_lng, max_lng = KOREA_BBOX
    out: list[tuple[float, float]] = []
    land_ready = land_filter.is_loaded()
    lat = min_lat + CELL_DEG / 2
    while lat < max_lat:
        lng = min_lng + CELL_DEG / 2
        while lng < max_lng:
            if not land_ready or _is_useful_cell(lat, lng):
                out.append((round(lat, 3), round(lng, 3)))
            lng += CELL_DEG
        lat += CELL_DEG
    return out


def _is_useful_cell(lat: float, lng: float) -> bool:
    """True if the cell center is over sea AND within reasonable coastal distance."""
    if land_filter.is_land_point(lat, lng):
        return False
    return land_filter.has_land_near(lat, lng, _MAX_DIST_FROM_LAND_DEG)


def _clip(x: float) -> float:
    return max(0.0, min(1.0, x))


def _normalize_wave(wave_m: float) -> float:
    """1m → 0, 5m → 1, linear."""
    return _clip((wave_m - 1.0) / 4.0)


def _normalize_wind(wind_kts: float) -> float:
    """10kt → 0, 50kt → 1, linear."""
    return _clip((wind_kts - 10.0) / 40.0)


def _normalize_visibility(vis_m: float) -> float:
    """1km → 1, 10km → 0, linear (inverted)."""
    return _clip(1.0 - (vis_m - 1000.0) / 9000.0)


def _normalize_traffic(n_ships: int) -> float:
    """0척 → 0, 15척+ → 1, linear."""
    return _clip(n_ships / 15.0)
