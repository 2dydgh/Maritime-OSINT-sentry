import time
import httpx
from fastapi import APIRouter

router = APIRouter(tags=["weather"])

_cache = {"data": None, "ts": 0}
_wind_cache = {"data": None, "ts": 0}
_TTL = 600  # 10분

# 전 세계 주요 해역 그리드 (위도/경도, 15도 간격)
_GRID_LATS = [-60, -45, -30, -15, 0, 15, 30, 45, 60]
_GRID_LONS = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]


# Open-Meteo maps lat[i]+lon[i] as pairs, not cartesian product.
# Build explicit coordinate pairs for the full grid.
_GRID_PAIRS = [(lat, lon) for lat in _GRID_LATS for lon in _GRID_LONS]


@router.get("/weather/marine")
async def get_marine_weather():
    now = time.time()
    if _cache["data"] and now - _cache["ts"] < _TTL:
        return _cache["data"]

    lats = ",".join(str(p[0]) for p in _GRID_PAIRS)
    lons = ",".join(str(p[1]) for p in _GRID_PAIRS)

    url = (
        "https://marine-api.open-meteo.com/v1/marine?"
        f"latitude={lats}&longitude={lons}"
        "&current=wave_height,wave_direction,wave_period"
        "&forecast_days=1&timeformat=unixtime"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url)
        raw = resp.json()

    entries = raw if isinstance(raw, list) else [raw]
    points = []
    for i, entry in enumerate(entries):
        current = entry.get("current", {})
        points.append({
            "lat": _GRID_PAIRS[i][0],
            "lon": _GRID_PAIRS[i][1],
            "wave_height": current.get("wave_height", 0),
            "wave_direction": current.get("wave_direction", 0),
            "wave_period": current.get("wave_period", 0),
        })

    result = {"points": points, "timestamp": now}
    _cache["data"] = result
    _cache["ts"] = now
    return result


@router.get("/weather/wind")
async def get_wind_data():
    now = time.time()
    if _wind_cache.get("data") and now - _wind_cache.get("ts", 0) < _TTL:
        return _wind_cache["data"]

    lats = ",".join(str(p[0]) for p in _GRID_PAIRS)
    lons = ",".join(str(p[1]) for p in _GRID_PAIRS)

    url = (
        "https://api.open-meteo.com/v1/forecast?"
        f"latitude={lats}&longitude={lons}"
        "&current=wind_speed_10m,wind_direction_10m,precipitation"
        "&timeformat=unixtime"
    )

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url)
        raw = resp.json()

    entries = raw if isinstance(raw, list) else [raw]
    points = []
    for i, entry in enumerate(entries):
        current = entry.get("current", {})
        points.append({
            "lat": _GRID_PAIRS[i][0],
            "lon": _GRID_PAIRS[i][1],
            "wind_speed": current.get("wind_speed_10m", 0),
            "wind_direction": current.get("wind_direction_10m", 0),
            "precipitation": current.get("precipitation", 0),
        })

    result = {"points": points, "timestamp": now}
    _wind_cache["data"] = result
    _wind_cache["ts"] = now
    return result
