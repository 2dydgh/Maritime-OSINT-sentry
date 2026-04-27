"""
Route API — searoute-based shipping route calculation and port search.
"""

import math
import logging
from fastapi import APIRouter, Query, HTTPException
from cachetools import TTLCache
import searoute as sr
from ..services.port_search import search_ports

logger = logging.getLogger(__name__)

router = APIRouter(tags=["route"])

# Cache routes for 1 hour — key is rounded coordinates
_route_cache = TTLCache(maxsize=100, ttl=3600)


def _interpolate_great_circle(p1: list, p2: list, max_gap_km: float = 20.0) -> list[list]:
    """Insert intermediate points along the great circle between p1 and p2.
    Each point is [lng, lat]. Returns list including p1 but NOT p2."""
    lng1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lng2, lat2 = math.radians(p2[0]), math.radians(p2[1])

    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    dist_km = 2 * 6371 * math.asin(math.sqrt(min(a, 1.0)))

    if dist_km <= max_gap_km:
        return [p1]

    n_segments = max(2, int(math.ceil(dist_km / max_gap_km)))
    points = []
    for i in range(n_segments):
        f = i / n_segments
        # Spherical linear interpolation
        d = 2 * math.asin(math.sqrt(min(a, 1.0)))
        if d < 1e-10:
            points.append(p1)
            continue
        A = math.sin((1 - f) * d) / math.sin(d)
        B = math.sin(f * d) / math.sin(d)
        x = A * math.cos(lat1) * math.cos(lng1) + B * math.cos(lat2) * math.cos(lng2)
        y = A * math.cos(lat1) * math.sin(lng1) + B * math.cos(lat2) * math.sin(lng2)
        z = A * math.sin(lat1) + B * math.sin(lat2)
        lat = math.degrees(math.atan2(z, math.sqrt(x * x + y * y)))
        lng = math.degrees(math.atan2(y, x))
        points.append([round(lng, 6), round(lat, 6)])

    return points


def _interpolate_route(coords: list[list], max_gap_km: float = 20.0) -> list[list]:
    """Interpolate an entire route so no gap exceeds max_gap_km."""
    if len(coords) < 2:
        return coords
    result = []
    for i in range(len(coords) - 1):
        result.extend(_interpolate_great_circle(coords[i], coords[i + 1], max_gap_km))
    result.append(coords[-1])
    return result


@router.get("/route")
def get_route(
    from_lat: float = Query(...),
    from_lng: float = Query(...),
    to_lat: float = Query(...),
    to_lng: float = Query(...),
):
    """Calculate shipping route between two coordinates."""
    # Round for cache key
    cache_key = (
        round(from_lat, 2), round(from_lng, 2),
        round(to_lat, 2), round(to_lng, 2),
    )
    if cache_key in _route_cache:
        return _route_cache[cache_key]

    try:
        route = sr.searoute(
            [from_lng, from_lat],
            [to_lng, to_lat],
        )
    except Exception as e:
        logger.error(f"searoute failed: {e}")
        raise HTTPException(status_code=400, detail="경로를 찾을 수 없습니다")

    raw_coords = route["geometry"]["coordinates"]
    distance_km = route["properties"].get("length", 0)

    result = {
        "coordinates": raw_coords,
        "distance_km": round(distance_km, 1),
        "point_count": len(raw_coords),
    }
    _route_cache[cache_key] = result
    return result


@router.get("/ports/search")
def search_ports_api(q: str = Query(..., min_length=1)):
    """Search ports by name (Korean or English)."""
    return search_ports(q)


@router.get("/ports/all")
def get_all_ports():
    """Return all ports for client-side search cache."""
    return search_ports("", max_results=9999)
