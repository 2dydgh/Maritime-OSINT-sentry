import asyncio
import logging

from fastapi import APIRouter, HTTPException

from ..services.ais_stream import get_ais_vessels, get_dark_vessels

router = APIRouter(tags=["ships"])
logger = logging.getLogger(__name__)

@router.get("/ships")
async def get_ships():
    try:
        # Off-loop: the global snapshot iterates ~30k vessels under a lock
        ships = await asyncio.to_thread(get_ais_vessels)
        return {
            "ships": ships,
            "total_tracked": len(ships)
        }
    except Exception as e:
        logger.error(f"Error serving ships API: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ships/dark")
async def get_dark_ships():
    try:
        dark_ships = get_dark_vessels()
        return {"dark_ships": dark_ships, "total": len(dark_ships)}
    except Exception as e:
        logger.error(f"Error serving dark ships API: {e}")
        raise HTTPException(status_code=500, detail=str(e))
