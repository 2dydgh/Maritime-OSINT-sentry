"""Read-only inspection of the first local data platform datasets."""
from fastapi import APIRouter, HTTPException, Query
from backend import config
from backend.data_platform.capture import get_journal

router = APIRouter(prefix='/datasets', tags=['datasets'])


def require_journal():
    if not config.DATA_PLATFORM_ENABLED:
        raise HTTPException(status_code=503, detail='Data platform capture is disabled')
    return get_journal()


@router.get('/status')
def status():
    if not config.DATA_PLATFORM_ENABLED:
        return {'enabled': False}
    return {'enabled': True, **require_journal().status()}


@router.get('/positions/{mmsi}')
def positions(mmsi: str, limit: int = Query(100, ge=1, le=1000)):
    if len(mmsi) != 9 or not mmsi.isascii() or not mmsi.isdigit():
        raise HTTPException(status_code=422, detail='MMSI must contain nine digits')
    return {'positions': require_journal().positions(mmsi, limit)}
