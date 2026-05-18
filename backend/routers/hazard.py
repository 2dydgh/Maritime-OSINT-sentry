"""Hazard endpoints — per-cell area risk for Korean coastal waters."""
import time

from fastapi import APIRouter

from backend.services import korea_hex_grid, static_hazards, ais_stream
from backend.routers.weather import get_korea_grid_weather

router = APIRouter(tags=["hazard"])


@router.get("/hazard/korea")
async def get_korea_hazard():
    """Korean coastal hex cells with score, cause, and subscores.

    Returns empty cells if demo mode (korea_hex_grid) is not active.
    """
    if not korea_hex_grid.is_active():
        return {"cells": [], "active": False, "timestamp": int(time.time())}

    weather = await get_korea_grid_weather()
    vessels = ais_stream.get_ais_vessels()
    features = static_hazards.load()
    cells = korea_hex_grid.compute_cells(weather, vessels, features)
    return {
        "cells": cells,
        "active": True,
        "timestamp": int(time.time()),
    }
