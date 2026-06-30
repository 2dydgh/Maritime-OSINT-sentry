from fastapi import APIRouter
from .. import config

router = APIRouter(tags=["data"])

@router.get("/config")
async def get_config():
    """Return public configuration for the frontend.

    NEVER include secrets (API keys, DB credentials) here — this endpoint is
    reachable by any client. Expose only non-sensitive feature flags. We surface
    whether the server-side AIS key is configured (a boolean), not the key itself.
    """
    return {
        "ais_configured": bool(config.AIS_API_KEY),
    }
