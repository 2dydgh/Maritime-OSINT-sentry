"""Hazard endpoints — per-cell area risk for Korean coastal waters."""
import time

from fastapi import APIRouter

from backend.services import korea_hex_grid, static_hazards, ais_stream, mock_vessel_service
from backend.routers.weather import get_korea_grid_weather

router = APIRouter(tags=["hazard"])


@router.get("/hazard/korea")
async def get_korea_hazard():
    """Korean coastal hex cells with score, cause, and subscores.

    Returns empty cells if demo mode (korea_hex_grid) is not active.
    Also returns mock_vessels so the frontend can render them only inside
    the drag-selected bounds (not on the persistent map layer).
    """
    if not korea_hex_grid.is_active():
        return {
            "cells": [], "mock_vessels": [],
            "active": False, "timestamp": int(time.time()),
        }

    weather = await get_korea_grid_weather()
    real_vessels = ais_stream.get_ais_vessels()
    mock_vessels = mock_vessel_service.snapshot()
    # Combine for traffic density scoring; real and mock are interchangeable here.
    all_vessels = real_vessels + mock_vessels
    features = static_hazards.load()
    cells = korea_hex_grid.compute_cells(weather, all_vessels, features)
    return {
        "cells": cells,
        "mock_vessels": mock_vessels,
        "active": True,
        "timestamp": int(time.time()),
    }
