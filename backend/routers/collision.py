import math
from fastapi import APIRouter, HTTPException, Query
from ..services.collision_analyzer import get_distance_risks, get_ml_risks
from ..services import land_filter

router = APIRouter(tags=["collision"])


@router.get("/collision/risks")
async def get_risks():
    """현재 충돌 위험 선박 쌍 목록 반환 (거리 기반 + ML 모델)."""
    distance_risks = get_distance_risks()
    ml_risks = get_ml_risks()
    return {
        "distance": {"risks": distance_risks, "total": len(distance_risks)},
        "ml": {"risks": ml_risks, "total": len(ml_risks)},
    }


@router.get("/collision/land-check")
async def land_check(
    lat1: float = Query(..., ge=-90.0, le=90.0),
    lon1: float = Query(..., ge=-180.0, le=180.0),
    lat2: float = Query(..., ge=-90.0, le=90.0),
    lon2: float = Query(..., ge=-180.0, le=180.0),
):
    """두 좌표 사이에 육지가 있는지 검사."""
    return {"land_between": land_filter.is_land_between(lat1, lon1, lat2, lon2)}


def _valid_coord(lat, lon) -> bool:
    """True if lat/lon are finite numbers within geographic bounds."""
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return False
    return (
        math.isfinite(lat) and math.isfinite(lon)
        and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0
    )


@router.post("/collision/land-check-batch")
async def land_check_batch(pairs: list[dict]):
    """여러 좌표 쌍을 한 번에 검사. 각 항목: {lat1, lon1, lat2, lon2}"""
    results = []
    for i, p in enumerate(pairs):
        try:
            lat1, lon1, lat2, lon2 = p["lat1"], p["lon1"], p["lat2"], p["lon2"]
        except (KeyError, TypeError):
            raise HTTPException(
                status_code=422,
                detail=f"pair[{i}] must contain lat1, lon1, lat2, lon2",
            )
        if not (_valid_coord(lat1, lon1) and _valid_coord(lat2, lon2)):
            raise HTTPException(
                status_code=422,
                detail=f"pair[{i}] has out-of-range or non-finite coordinates",
            )
        results.append(land_filter.is_land_between(lat1, lon1, lat2, lon2))
    return {"results": results}
