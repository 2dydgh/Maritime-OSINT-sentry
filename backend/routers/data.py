from fastapi import APIRouter
from .. import config

router = APIRouter(tags=["data"])

@router.get("/config")
async def get_config():
    """Return public configuration for the frontend."""
    return {
        "ais_api_key": config.AIS_API_KEY
    }
