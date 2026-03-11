from fastapi import APIRouter, HTTPException
import logging
import json
from ..database import get_db_pool

router = APIRouter(tags=["events"])
logger = logging.getLogger(__name__)

@router.get("/events")
async def get_military_events():
    db_pool = get_db_pool()
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not initialized")
    
    try:
        async with db_pool.acquire() as conn:
            query = """
                SELECT json_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(json_agg(ST_AsGeoJSON(t.*)::json), '[]'::json)
                ) AS geojson
                FROM (
                    SELECT id, event_type, event_time, confidence, geom 
                    FROM military_events
                    ORDER BY event_time DESC
                ) AS t;
            """
            result = await conn.fetchval(query)
            if isinstance(result, str):
                return json.loads(result)
            return result
    except Exception as e:
        logger.error(f"Error fetching events: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/restricted-areas")
async def get_restricted_areas():
    db_pool = get_db_pool()
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not initialized")
        
    try:
        async with db_pool.acquire() as conn:
            query = """
                SELECT json_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(json_agg(ST_AsGeoJSON(t.*)::json), '[]'::json)
                ) AS geojson
                FROM (
                    SELECT id, area_type, start_time, end_time, source_agency, geom 
                    FROM restricted_areas
                    WHERE is_active = TRUE
                ) AS t;
            """
            result = await conn.fetchval(query)
            if isinstance(result, str):
                return json.loads(result)
            return result
    except Exception as e:
        logger.error(f"Error fetching restricted areas: {e}")
        raise HTTPException(status_code=500, detail=str(e))
