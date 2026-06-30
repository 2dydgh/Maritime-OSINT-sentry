from fastapi import APIRouter, HTTPException
import logging
from ..services.ais_stream import get_alerts

logger = logging.getLogger(__name__)
router = APIRouter(tags=["alerts"])


@router.get("/alerts")
async def get_live_alerts(limit: int = 50):
    """Return the most recent AIS anomaly alerts for the Live Feed."""
    try:
        return get_alerts(max_count=limit)
    except Exception:
        logger.exception("Error fetching AIS alerts")
        raise HTTPException(status_code=500, detail="Failed to fetch alerts")
