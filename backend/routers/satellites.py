from fastapi import APIRouter, HTTPException
from ..services.satellite_tracker import fetch_intel_satellites
import logging

logger = logging.getLogger(__name__)
router = APIRouter(tags=["satellites"])

@router.get("/satellites")
async def get_satellites():
    """Fetch real-time TLE orbits for intelligent satellites."""
    try:
        sats = fetch_intel_satellites()
        return sats
    except Exception:
        logger.exception("Error fetching satellites")
        raise HTTPException(status_code=502, detail="Failed to fetch satellite orbits")
