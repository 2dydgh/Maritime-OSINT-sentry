from fastapi import APIRouter, HTTPException, Query
import logging
from ..services.sentinel_search import search_sentinel2_scene

router = APIRouter(tags=["sentinel"])
logger = logging.getLogger(__name__)

@router.get("/sentinel")
def search_imagery(
    lat: float = Query(...),
    lng: float = Query(...)
):
    """Search for Sentinel-2 imagery near the given coordinates."""
    try:
        results = search_sentinel2_scene(lat, lng)
        return results
    except Exception as e:
        logger.error(f"Error searching Sentinel imagery: {e}")
        raise HTTPException(status_code=500, detail=str(e))
