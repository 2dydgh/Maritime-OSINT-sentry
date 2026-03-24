from fastapi import APIRouter, Query
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
    lat1: float = Query(...), lon1: float = Query(...),
    lat2: float = Query(...), lon2: float = Query(...),
):
    """두 좌표 사이에 육지가 있는지 검사."""
    return {"land_between": land_filter.is_land_between(lat1, lon1, lat2, lon2)}


@router.post("/collision/land-check-batch")
async def land_check_batch(pairs: list[dict]):
    """여러 좌표 쌍을 한 번에 검사. 각 항목: {lat1, lon1, lat2, lon2}"""
    results = []
    for p in pairs:
        blocked = land_filter.is_land_between(
            p["lat1"], p["lon1"], p["lat2"], p["lon2"]
        )
        results.append(blocked)
    return {"results": results}
