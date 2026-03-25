"""Prometheus metrics endpoint."""

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter()

try:
    from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
    _HAS_PROMETHEUS = True
except ImportError:
    _HAS_PROMETHEUS = False


@router.get("/metrics", response_class=PlainTextResponse)
async def prometheus_metrics():
    if not _HAS_PROMETHEUS:
        return PlainTextResponse(content="# prometheus_client not installed\n", media_type="text/plain")
    return PlainTextResponse(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )
