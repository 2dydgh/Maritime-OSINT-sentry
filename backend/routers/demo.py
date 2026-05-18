"""Demo mode toggle — turns on mock vessels + Korean hex hazard grid."""
from fastapi import APIRouter
from pydantic import BaseModel

from backend.services import korea_hex_grid, mock_vessel_service

router = APIRouter(tags=["demo"])


class ToggleBody(BaseModel):
    active: bool


@router.post("/demo/toggle")
async def toggle_demo(body: ToggleBody):
    if body.active:
        mock_vessel_service.start()
        korea_hex_grid.activate()
    else:
        mock_vessel_service.stop()
        korea_hex_grid.deactivate()
    return _status()


@router.get("/demo/status")
async def demo_status():
    return _status()


def _status() -> dict:
    snap = mock_vessel_service.snapshot()
    return {
        "active": korea_hex_grid.is_active(),
        "mock_vessels": len(snap),
        "korea_cells": len(korea_hex_grid.korea_cells())
                       if korea_hex_grid.is_active() else 0,
    }
