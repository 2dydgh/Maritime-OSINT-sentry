"""Hazard endpoints — per-cell area risk for Korean coastal waters.

The /hazard/korea endpoint exists solely to feed the 사고 (hazard) rail mode
on the frontend, which is a demo experience. Real Korean coastal weather is
generally calm and live AIS coverage of the bbox is sparse, so neither would
produce visible risk cells. Instead we synthesize weather + vessel traffic
around six fixed coastal hot-spots (Busan, Yeosu, Mokpo, Boryeong, Jeju
strait, Dokdo) and run them through the normal compute_cells pipeline so the
scoring, top-cause, and subscores are still consistent with the algorithm.
"""
import asyncio
import logging
import math
import random
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.services import korea_hex_grid, static_hazards, land_filter

logger = logging.getLogger(__name__)
router = APIRouter(tags=["hazard"])

# Synth data is deterministic — compute_cells output never changes once the
# land_filter has finished loading. Cache the response so repeated drags
# (which fetch /hazard/korea each time) don't re-run the spatial pipeline.
_CACHED_CELLS: list[dict] | None = None
_CACHED_WITH_LAND: bool = False


# (lat, lng) — coastal demo hot-spots picked to roughly match accident.png layout.
_HOT_SPOTS = [
    (35.05, 129.05),  # 부산 항만 입구
    (34.45, 127.75),  # 여수 / 한려수도
    (34.55, 125.95),  # 신안 외해 (목포 서측)
    (36.65, 126.35),  # 보령 / 천수만
    (33.85, 126.55),  # 제주 해협 (제주 북측)
    (37.55, 131.10),  # 독도 북동 해상
]
_HOTSPOT_RADIUS_DEG = 0.9   # falloff radius — beyond this no boost is applied
_VESSELS_PER_HOTSPOT = 22   # fake vessel cluster density


def _hotspot_boost(lat: float, lng: float) -> float:
    """0~1 falloff intensity from the nearest hot-spot."""
    nearest = 0.0
    for hs_lat, hs_lng in _HOT_SPOTS:
        d = math.hypot(lat - hs_lat, lng - hs_lng)
        if d < _HOTSPOT_RADIUS_DEG:
            nearest = max(nearest, (_HOTSPOT_RADIUS_DEG - d) / _HOTSPOT_RADIUS_DEG)
    return nearest


def _synth_weather() -> dict:
    """Synthetic weather aligned to korea_hex_grid cells with hot-spot peaks."""
    rng = random.Random(20260519)
    cells = []
    for lat, lng in korea_hex_grid.korea_cells():
        boost = _hotspot_boost(lat, lng)
        jitter = rng.uniform(-0.15, 0.15)
        wave = 0.4 + 6.5 * boost + jitter * boost
        wind = 7.0 + 50.0 * boost + jitter * 5
        vis = 20000 - 19000 * boost - jitter * 800
        cells.append({
            "lat": lat,
            "lng": lng,
            "wave_height": round(max(0.0, wave), 2),
            "wave_direction": 180,
            "wave_period": 5.0 + 2.0 * boost,
            "wind_speed": round(max(0.0, wind), 1),
            "wind_direction": 180,
            "visibility": round(max(500.0, vis), 0),
        })
    return {"cells": cells, "timestamp": int(time.time())}


def _synth_vessels() -> list[dict]:
    """Fake vessel positions clustered around hot-spots (traffic component)."""
    rng = random.Random(20260520)
    out: list[dict] = []
    for hs_lat, hs_lng in _HOT_SPOTS:
        for _ in range(_VESSELS_PER_HOTSPOT):
            r = rng.uniform(0.05, 0.45)
            theta = rng.uniform(0.0, 2 * math.pi)
            out.append({
                "lat": hs_lat + r * math.cos(theta),
                "lng": hs_lng + r * math.sin(theta),
            })
    return out


def _compute_cells_sync() -> list[dict]:
    """Synchronous compute used by both the warm-up task and cache-miss path."""
    weather = _synth_weather()
    vessels = _synth_vessels()
    features = static_hazards.load()
    return korea_hex_grid.compute_cells(weather, vessels, features)


async def warm_cache() -> None:
    """Pre-populate the response cache once the land filter has finished loading.

    Called from main.py's lifespan as a background task. Polls for the land
    filter to finish loading (it runs in a thread), then runs the heavy
    compute off the event loop so the first /hazard/korea request is instant.
    """
    global _CACHED_CELLS, _CACHED_WITH_LAND
    for _ in range(60):  # up to ~60s of polling
        if land_filter.is_loaded():
            break
        await asyncio.sleep(1)
    _CACHED_CELLS = await asyncio.to_thread(_compute_cells_sync)
    _CACHED_WITH_LAND = land_filter.is_loaded()
    logger.info("hazard cache warmed: %d cells", len(_CACHED_CELLS))


@router.get("/hazard/korea")
async def get_korea_hazard():
    """Demo hazard cells over Korean coastal waters.

    Uses synthetic weather + vessel density around fixed hot-spots so the
    frontend 사고 mode reliably renders a colored hex grid even when real
    feed data is calm or sparse. Computation goes through the standard
    compute_cells path so the scoring algorithm stays unified.

    The synth payload is deterministic, so the response carries a 60s
    Cache-Control directive — repeated drags within that window are served
    from the browser cache and never touch the event loop.
    """
    global _CACHED_CELLS, _CACHED_WITH_LAND
    land_ready = land_filter.is_loaded()
    if _CACHED_CELLS is None or (land_ready and not _CACHED_WITH_LAND):
        _CACHED_CELLS = await asyncio.to_thread(_compute_cells_sync)
        _CACHED_WITH_LAND = land_ready
    return JSONResponse(
        content={
            "cells": _CACHED_CELLS,
            "timestamp": int(time.time()),
        },
        headers={"Cache-Control": "public, max-age=60"},
    )
