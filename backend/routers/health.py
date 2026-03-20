"""Health check endpoint for load balancers and monitoring."""

import time
from fastapi import APIRouter

router = APIRouter()

_start_time = time.time()


@router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "uptime": round(time.time() - _start_time, 1),
    }
