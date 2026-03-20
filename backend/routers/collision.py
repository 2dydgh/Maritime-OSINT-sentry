from fastapi import APIRouter
from ..services.collision_analyzer import get_collision_risks

router = APIRouter(tags=["collision"])


@router.get("/collision/risks")
async def get_risks():
    """현재 충돌 위험 선박 쌍 목록 반환."""
    risks = get_collision_risks()
    return {
        "risks": risks,
        "total": len(risks),
    }
