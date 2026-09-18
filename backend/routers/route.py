"""
Route API — searoute-based shipping route calculation and port search.
"""

import logging

import searoute as sr
from cachetools import TTLCache
from fastapi import APIRouter, HTTPException, Query

from ..services.port_search import search_ports

logger = logging.getLogger(__name__)

router = APIRouter(tags=["route"])

# Cache routes for 1 hour — key is rounded coordinates
_route_cache = TTLCache(maxsize=100, ttl=3600)


@router.get("/route")
def get_route(
    from_lat: float = Query(..., ge=-90.0, le=90.0),
    from_lng: float = Query(..., ge=-180.0, le=180.0),
    to_lat: float = Query(..., ge=-90.0, le=90.0),
    to_lng: float = Query(..., ge=-180.0, le=180.0),
):
    """Calculate shipping route between two coordinates."""
    # Round for cache key
    cache_key = (
        round(from_lat, 2),
        round(from_lng, 2),
        round(to_lat, 2),
        round(to_lng, 2),
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

    # searoute 의 꼭짓점(항로가 꺾이는 지점)만 그대로 돌려준다. 촘촘하게 만드는 일은
    # 프론트 route-viewer.js 의 smoothRouteCoords() 가 구면 Catmull-Rom 스플라인으로
    # 한다 — 스플라인은 제어점이 희소해야 모서리를 둥글게 돈다. 여기서 20km 간격으로
    # 미리 채우면 곡선이 날카로운 꺾임을 그대로 따라가므로 서버 보간을 다시 넣지 말 것.
    # (2026-04 72eaaaf 에서 의도적으로 제거. 화면 최대 간격은 약 33km.)
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
