"""
History Router - Time-based data retrieval API for time travel functionality

Provides endpoints for:
- Retrieving ship positions at specific points in time
- Fetching ship trajectory data within time ranges
- Getting available data time range for UI initialization
"""

from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
import logging

from ..database import get_db_pool
from ..services.ais_stream import get_all_vessel_metadata, get_country_from_mmsi

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/history", tags=["history"])


class ShipPosition(BaseModel):
    mmsi: str
    name: str = "UNKNOWN"
    type: str = "other"
    lat: float
    lng: float
    sog: Optional[float] = None
    heading: Optional[float] = None
    country: str = "UNKNOWN"
    record_time: datetime


class TrajectoryPoint(BaseModel):
    lat: float
    lng: float
    sog: Optional[float] = None
    heading: Optional[float] = None
    record_time: datetime


class TimeRange(BaseModel):
    min_time: Optional[datetime] = None
    max_time: Optional[datetime] = None
    total_records: int


@router.get("/ships", response_model=List[ShipPosition])
async def get_ships_at_time(
    time: datetime = Query(..., description="ISO 8601 timestamp (e.g., 2025-03-13T14:30:00Z)")
):
    """
    Retrieve all ship positions at a specific point in time.

    Searches for records within +/- 60 seconds of the specified time
    and returns the closest record for each ship.
    Enriches with vessel metadata (name, type, country) from current AIS cache.
    """
    pool = get_db_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="Database not available")

    query = """
        SELECT DISTINCT ON (object_id)
            object_id as mmsi,
            ST_Y(geom::geometry) as lat,
            ST_X(geom::geometry) as lng,
            velocity as sog,
            heading,
            record_time,
            ship_type
        FROM trajectories
        WHERE object_type = 'ship'
          AND record_time BETWEEN ($1::timestamptz - INTERVAL '60 seconds') AND ($1::timestamptz + INTERVAL '60 seconds')
        ORDER BY object_id, ABS(EXTRACT(EPOCH FROM (record_time - $1::timestamptz)))
    """

    try:
        # Get current vessel metadata for enrichment
        vessel_metadata = get_all_vessel_metadata()

        async with pool.acquire() as conn:
            rows = await conn.fetch(query, time)

            ships = []
            for row in rows:
                mmsi_str = row["mmsi"]
                mmsi_int = int(mmsi_str) if mmsi_str.isdigit() else 0

                # Look up metadata from current AIS cache (fallback)
                meta = vessel_metadata.get(mmsi_int, {})

                # DB의 ship_type 우선 사용, 없으면 현재 캐시, 그래도 없으면 "unknown"
                db_ship_type = row.get("ship_type") or ""
                ship_type = db_ship_type if db_ship_type and db_ship_type != "unknown" else meta.get("type", "unknown")

                ships.append(ShipPosition(
                    mmsi=mmsi_str,
                    name=meta.get("name", "UNKNOWN"),
                    type=ship_type or "unknown",
                    lat=row["lat"],
                    lng=row["lng"],
                    sog=float(row["sog"]) if row["sog"] is not None else None,
                    heading=float(row["heading"]) if row["heading"] is not None else None,
                    country=meta.get("country") or get_country_from_mmsi(mmsi_int),
                    record_time=row["record_time"]
                ))

            logger.info(f"History: Retrieved {len(ships)} ships at time {time}")
            return ships

    except Exception as e:
        logger.error(f"Error fetching ships at time {time}: {e}")
        return []


@router.get("/ships/{mmsi}", response_model=List[TrajectoryPoint])
async def get_ship_trajectory(
    mmsi: str,
    start: datetime = Query(..., description="Start time (ISO 8601)"),
    end: datetime = Query(..., description="End time (ISO 8601)")
):
    """
    Retrieve trajectory (position history) for a specific ship.

    Returns all recorded positions within the specified time range,
    ordered chronologically for trajectory visualization.
    """
    if not mmsi.isdigit():
        raise HTTPException(status_code=400, detail="MMSI must be numeric")

    pool = get_db_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="Database not available")

    # Validate time range
    if start >= end:
        raise HTTPException(
            status_code=400,
            detail="Start time must be before end time"
        )

    query = """
        SELECT
            ST_Y(geom::geometry) as lat,
            ST_X(geom::geometry) as lng,
            velocity as sog,
            heading,
            record_time
        FROM trajectories
        WHERE object_type = 'ship'
          AND object_id = $1
          AND record_time BETWEEN $2 AND $3
        ORDER BY record_time ASC
    """

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, mmsi, start, end)

            trajectory = []
            for row in rows:
                trajectory.append(TrajectoryPoint(
                    lat=row["lat"],
                    lng=row["lng"],
                    sog=float(row["sog"]) if row["sog"] is not None else None,
                    heading=float(row["heading"]) if row["heading"] is not None else None,
                    record_time=row["record_time"]
                ))

            logger.info(f"History: Retrieved {len(trajectory)} trajectory points for MMSI {mmsi}")
            return trajectory

    except Exception as e:
        logger.error(f"Error fetching trajectory for MMSI {mmsi}: {e}")
        return []


@router.get("/trajectories")
async def get_bulk_trajectories(
    start: datetime = Query(..., description="Start time (ISO 8601)"),
    end: datetime = Query(..., description="End time (ISO 8601)"),
    limit_per_ship: int = Query(default=60, description="Max points per ship"),
    max_ships: int = Query(default=500, ge=1, le=2000, description="Max number of ships to return")
):
    """
    Retrieve trajectory data for ALL ships within a time range.
    Used for smooth interpolation/animation in HISTORY mode.
    Returns data grouped by MMSI with multiple time samples per ship.
    """
    pool = get_db_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="Database not available")

    if start >= end:
        raise HTTPException(status_code=400, detail="Start time must be before end time")

    # Get vessel metadata for enrichment
    vessel_metadata = get_all_vessel_metadata()

    # Query: get trajectory points for all ships, limited samples per ship
    query = """
        WITH ship_activity AS (
            SELECT object_id, COUNT(*) as point_count
            FROM trajectories
            WHERE object_type = 'ship'
              AND record_time BETWEEN $1 AND $2
            GROUP BY object_id
            HAVING COUNT(*) >= 2
            ORDER BY point_count DESC
            LIMIT $4
        ),
        ranked AS (
            SELECT
                t.object_id as mmsi,
                ST_Y(t.geom::geometry) as lat,
                ST_X(t.geom::geometry) as lng,
                t.velocity as sog,
                t.heading,
                t.record_time,
                t.ship_type,
                ROW_NUMBER() OVER (PARTITION BY t.object_id ORDER BY t.record_time ASC) as rn,
                COUNT(*) OVER (PARTITION BY t.object_id) as total_points
            FROM trajectories t
            INNER JOIN ship_activity s ON t.object_id = s.object_id
            WHERE t.object_type = 'ship'
              AND t.record_time BETWEEN $1 AND $2
        )
        SELECT mmsi, lat, lng, sog, heading, record_time, ship_type
        FROM ranked
        WHERE rn <= $3 OR rn % GREATEST(1, total_points / $3) = 0
        ORDER BY mmsi, record_time ASC
    """

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, start, end, limit_per_ship, max_ships)

            # Group by mmsi
            ships = {}
            for row in rows:
                mmsi = row["mmsi"]
                if mmsi not in ships:
                    meta = vessel_metadata.get(int(mmsi) if mmsi.isdigit() else 0, {})
                    ships[mmsi] = {
                        "name": meta.get("name", "UNKNOWN"),
                        "type": row["ship_type"] or meta.get("type", "unknown"),
                        "country": meta.get("country", "UNKNOWN"),
                        "points": []
                    }

                ships[mmsi]["points"].append({
                    "time": row["record_time"].isoformat(),
                    "lat": row["lat"],
                    "lng": row["lng"],
                    "sog": float(row["sog"]) if row["sog"] is not None else None,
                    "heading": float(row["heading"]) if row["heading"] is not None else None
                })

            logger.info(f"History: Retrieved trajectories for {len(ships)} ships ({len(rows)} total points)")
            return {"ships": ships}

    except Exception as e:
        logger.error(f"Error fetching bulk trajectories: {e}")
        return {"ships": {}}


@router.get("/range", response_model=TimeRange)
async def get_data_time_range():
    """
    Get the time range of available ship data.

    Returns the earliest and latest record times along with total record count.
    Used to initialize timeline UI components.
    """
    pool = get_db_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="Database not available")

    query = """
        SELECT
            MIN(record_time) as min_time,
            MAX(record_time) as max_time,
            COUNT(*) as total_records
        FROM trajectories
        WHERE object_type = 'ship'
    """

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query)

            result = TimeRange(
                min_time=row["min_time"],
                max_time=row["max_time"],
                total_records=row["total_records"] or 0
            )

            logger.info(f"History: Data range from {result.min_time} to {result.max_time}, {result.total_records} records")
            return result

    except Exception as e:
        logger.error(f"Error fetching data time range: {e}")
        return TimeRange(min_time=None, max_time=None, total_records=0)
