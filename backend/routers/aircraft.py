from fastapi import APIRouter, HTTPException
import logging
from ..services.aircraft_tracker import get_aircraft

router = APIRouter(tags=["aircraft"])
logger = logging.getLogger(__name__)


@router.get("/aircraft")
async def get_aircraft_list():
    try:
        aircraft = get_aircraft()
        return {
            "aircraft": aircraft,
            "total_tracked": len(aircraft),
        }
    except Exception as e:
        logger.error(f"Error serving aircraft API: {e}")
        raise HTTPException(status_code=500, detail=str(e))
