import asyncio
from fastapi import APIRouter, HTTPException
import logging
import json
from ..database import get_db_pool

router = APIRouter(tags=["events"])
logger = logging.getLogger(__name__)

_DB_ACQUIRE_TIMEOUT = 5.0  # seconds


@router.get("/events")
async def get_military_events():
    db_pool = get_db_pool()
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not initialized")

    try:
        async with asyncio.timeout(_DB_ACQUIRE_TIMEOUT):
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
    except (asyncio.TimeoutError, TimeoutError):
        logger.error("Timeout acquiring DB connection for events")
        raise HTTPException(status_code=503, detail="Database temporarily unavailable")
    except Exception:
        logger.exception("Error fetching events")
        raise HTTPException(status_code=503, detail="Failed to fetch events")


@router.get("/restricted-areas")
async def get_restricted_areas():
    db_pool = get_db_pool()
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not initialized")

    try:
        async with asyncio.timeout(_DB_ACQUIRE_TIMEOUT):
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
    except (asyncio.TimeoutError, TimeoutError):
        logger.error("Timeout acquiring DB connection for restricted areas")
        raise HTTPException(status_code=503, detail="Database temporarily unavailable")
    except Exception:
        logger.exception("Error fetching restricted areas")
        raise HTTPException(status_code=503, detail="Failed to fetch restricted areas")
