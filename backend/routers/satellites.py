from fastapi import APIRouter
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
    except Exception as e:
        logger.error(f"Error fetching satellites: {e}")
        return []
