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


from shapely.geometry import box

from backend.services import static_hazards

# 가중치
_W_WAVE    = 0.30
_W_WIND    = 0.25
_W_VIS     = 0.20
_W_TRAFFIC = 0.10
_W_STATIC  = 0.15

_MIN_RAW = 0.30


def _vessels_per_cell(vessels: list[dict]) -> dict[tuple[float, float], int]:
    """Group vessels by their containing hex cell (CELL_DEG bucket)."""
    out: dict[tuple[float, float], int] = {}
    for v in vessels:
        lat = v.get("lat")
        lng = v.get("lng") or v.get("lon")
        if lat is None or lng is None:
            continue
        key = (
            round(round(lat / CELL_DEG) * CELL_DEG, 3),
            round(round(lng / CELL_DEG) * CELL_DEG, 3),
        )
        out[key] = out.get(key, 0) + 1
    return out


def _weather_by_cell(weather: dict) -> dict[tuple[float, float], dict]:
    out: dict[tuple[float, float], dict] = {}
    for pt in weather.get("cells", []):
        key = (round(pt["lat"], 3), round(pt["lng"], 3))
        out[key] = pt
    return out


def _top_cause(subscores: dict, raw: dict) -> str:
    contrib = {
        "wave":    _W_WAVE    * subscores["wave"],
        "wind":    _W_WIND    * subscores["wind"],
        "vis":     _W_VIS     * subscores["vis"],
        "traffic": _W_TRAFFIC * subscores["traffic"],
        "static":  _W_STATIC  * subscores["static"],
    }
    top = max(contrib, key=contrib.get)
    if top == "wave":
        return f"파고 {raw['wave_raw']:.1f}m"
    if top == "wind":
        return f"강풍 {raw['wind_raw']:.0f}kt"
    if top == "vis":
        return f"시정 {raw['vis_raw']:.1f}km"
    if top == "traffic":
        return f"선박 밀집 {raw['traffic_n']}척"
    if top == "static" and raw["static_names"]:
        return raw["static_names"][0]
    return "위험 해역"


def compute_cells(weather: dict, vessels: list[dict], features: list[dict]) -> list[dict]:
    """Compute per-cell score and cause from weather + traffic + static features.

    Args:
        weather: { "cells": [{lat, lng, wave_height, wind_speed, visibility, ...}] }
        vessels: list of vessel dicts (same shape as get_ais_vessels output)
        features: parameter reserved for caller-passed feature override; current
                  impl reads via static_hazards module to keep call sites simple.
    """
    weather_map = _weather_by_cell(weather)
    traffic_map = _vessels_per_cell(vessels)

    out: list[dict] = []
    for lat, lng in korea_cells():
        w = weather_map.get((lat, lng), {})
        wave_m  = float(w.get("wave_height", 0.0) or 0.0)
        wind_kt = float(w.get("wind_speed", 0.0) or 0.0)
        vis_m   = float(w.get("visibility", 20000.0) or 20000.0)
        n_ships = traffic_map.get((lat, lng), 0)

        cell_poly = box(lng - CELL_DEG / 2, lat - CELL_DEG / 2,
                        lng + CELL_DEG / 2, lat + CELL_DEG / 2)
        static_hits = static_hazards.intersecting(cell_poly)
        static_score = 1.0 if static_hits else 0.0
        static_names = [f["properties"]["name"] for f in static_hits]

        subscores = {
            "wave":    _normalize_wave(wave_m),
            "wind":    _normalize_wind(wind_kt),
            "vis":     _normalize_visibility(vis_m),
            "traffic": _normalize_traffic(n_ships),
            "static":  static_score,
        }
        raw = (
            _W_WAVE    * subscores["wave"] +
            _W_WIND    * subscores["wind"] +
            _W_VIS     * subscores["vis"] +
            _W_TRAFFIC * subscores["traffic"] +
            _W_STATIC  * subscores["static"]
        )
        if raw < _MIN_RAW:
            continue

        score = round(70 + raw * 30, 1)
        raw_values = {
            "wave_raw": wave_m,
            "wind_raw": wind_kt,
            "vis_raw":  vis_m / 1000.0,
            "traffic_n": n_ships,
            "static_names": static_names,
        }
        out.append({
            "lat": lat, "lng": lng,
            "score": score,
            "cause": _top_cause(subscores, raw_values),
            "subscores": {
                "wave":    round(subscores["wave"],    3),
                "wind":    round(subscores["wind"],    3),
                "vis":     round(subscores["vis"],     3),
                "traffic": round(subscores["traffic"], 3),
                "static":  round(subscores["static"],  3),
                "wave_raw":    round(wave_m, 2),
                "wind_raw":    round(wind_kt, 1),
                "vis_raw":     round(vis_m / 1000.0, 2),
                "traffic_n":   n_ships,
                "static_names": static_names,
            },
        })
    return out
