import math
from fastapi import APIRouter, HTTPException, Query
import logging
from ..services.sentinel_search import search_sentinel2_scene

router = APIRouter(tags=["sentinel"])
logger = logging.getLogger(__name__)

@router.get("/sentinel")
def search_imagery(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lng: float = Query(..., ge=-180.0, le=180.0)
):
    """Search for Sentinel-2 imagery near the given coordinates."""
    if not (math.isfinite(lat) and math.isfinite(lng)):
        raise HTTPException(status_code=422, detail="lat/lng must be finite numbers")
    try:
        results = search_sentinel2_scene(lat, lng)
        return results
    except Exception:
        logger.exception("Error searching Sentinel imagery at lat=%s lng=%s", lat, lng)
        raise HTTPException(status_code=502, detail="Sentinel imagery search failed")
