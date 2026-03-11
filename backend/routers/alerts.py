from fastapi import APIRouter
from ..services.ais_stream import get_alerts

router = APIRouter(tags=["alerts"])


@router.get("/alerts")
async def get_live_alerts(limit: int = 50):
    """Return the most recent AIS anomaly alerts for the Live Feed."""
    return get_alerts(max_count=limit)
