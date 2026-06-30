"""라이브 AIS 끊김 시 DB 최근 위치 스냅샷으로 degrade 하는 피드 상태 모듈.

DB(trajectories)는 읽기 전용으로만 접근하며, 라이브 _vessels 저장소나
history_writer 에는 절대 쓰지 않는다.
"""

import json
import logging
import time

from backend import database
from backend.services import ais_stream

logger = logging.getLogger(__name__)

# 라이브로 간주할 최소 선박 수. 이 미만이면 끊김 의심.
FALLBACK_THRESHOLD = 100
# 라이브→fallback 전환 전 연속으로 임계치 미달이어야 하는 틱 수 (플래핑 방지).
FALLBACK_LOW_STREAK_TICKS = 2

_SNAPSHOT_WINDOW = "30 minutes"
_CACHE_TTL_S = 60
# 최악의 경우 풀스캔을 막기 위한 스냅샷 상한 (선박 수 기준).
_SNAPSHOT_LIMIT = 50000
# 창은 wall-clock now() 가 아니라 "DB 에 기록된 최신 시각" 기준으로 잡는다.
# 라이브가 끊기면 history_writer 도 새 행을 안 쓰므로, now()-30분 창은 항상
# 비어 있게 된다(= fallback 이 필요한 바로 그 순간에 0척). 데이터 최신 시각을
# 기준으로 거꾸로 30분을 보면, 피드가 마지막으로 살아 있던 구간의 스냅샷이 잡힌다.
_SNAPSHOT_QUERY = f"""
SELECT DISTINCT ON (object_id)
       object_id, ST_X(geom) AS lng, ST_Y(geom) AS lat,
       velocity, heading, ship_type, record_time
FROM trajectories
WHERE object_type = 'ship'
  AND record_time > (
        SELECT max(record_time) FROM trajectories WHERE object_type = 'ship'
      ) - interval '{_SNAPSHOT_WINDOW}'
ORDER BY object_id, record_time DESC
LIMIT {_SNAPSHOT_LIMIT}
"""

_cache: list[dict] = []
_cache_ts: float = 0.0
_snapshot_time_ms: int | None = None


def select_feed_status(
    live_count: int, fallback_count: int, prev_status: str, low_streak: int
) -> tuple[str, int]:
    """다음 feed_status 와 갱신된 low_streak 를 결정한다 (순수 함수).

    - live_count 가 임계치 이상이면 즉시 live, streak 리셋.
    - 임계치 미달이면 streak 증가. 단 live_count 가 0 인 "하드 끊김"은
      디바운스 없이 즉시 전환한다(완전 0은 깜빡임이 아니라 진짜 끊김이고,
      cold start 에서 첫 틱부터 fallback 을 띄워야 빈 글로브 틈이 없다).
    - live_count 가 1~임계치 미만인 "부분 딥"만 한 틱 더 live 유지(플래핑 방지).
    - 디바운스 충족(또는 즉시 전환) 시 스냅샷이 있으면 fallback, 없으면 down.
    """
    if live_count >= FALLBACK_THRESHOLD:
        return ("live", 0)

    low_streak += 1
    if live_count > 0 and low_streak < FALLBACK_LOW_STREAK_TICKS and prev_status == "live":
        return ("live", low_streak)

    if fallback_count > 0:
        return ("fallback", low_streak)
    return ("down", low_streak)


def _reset_cache_for_test() -> None:
    global _cache, _cache_ts, _snapshot_time_ms
    _cache, _cache_ts, _snapshot_time_ms = [], 0.0, None


def get_snapshot_time_ms() -> int | None:
    return _snapshot_time_ms


async def get_fallback_snapshot(pool=None) -> list[dict]:
    """DB trajectories 최근 30분에서 선박별 최신 위치를 라이브형 dict 로 반환."""
    global _cache, _cache_ts, _snapshot_time_ms
    now = time.time()
    if _cache and now - _cache_ts < _CACHE_TTL_S:
        return _cache

    if pool is None:
        pool = database.get_db_pool()
    if pool is None:
        _cache, _cache_ts, _snapshot_time_ms = [], now, None
        return _cache

    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(_SNAPSHOT_QUERY)

        meta = ais_stream.get_all_vessel_metadata()  # 이름 보강 (대개 비어 있음)
        ships: list[dict] = []
        max_ts = None
        for r in rows:
            mmsi = int(r["object_id"])
            rt = r["record_time"]
            if max_ts is None or rt > max_ts:
                max_ts = rt
            ships.append({
                "mmsi": mmsi,
                "name": (meta.get(mmsi, {}).get("name") or "UNKNOWN"),
                "type": r["ship_type"] or "unknown",
                # PostGIS numeric 컬럼은 Decimal 로 와서 json.dumps 가 깨진다 → float 강제.
                "lat": round(float(r["lat"]), 5),
                "lng": round(float(r["lng"]), 5),
                "heading": float(r["heading"] or 0),
                "sog": round(float(r["velocity"] or 0), 1),
                "cog": 0,  # trajectories 테이블에 COG 컬럼 없음
                "callsign": "",
                "destination": "UNKNOWN",
                "imo": 0,
                "country": ais_stream.get_country_from_mmsi(mmsi),
                "length": 0,
                "beam": 0,
                "draught": 0,
                "eta": "",
                "ais_class": "A",
                "status": "",
            })

        _cache = ships
        _cache_ts = now
        _snapshot_time_ms = int(max_ts.timestamp() * 1000) if max_ts else None
        return ships
    except Exception as e:
        logger.warning(f"Fallback snapshot failed: {e}")
        return _cache  # 있으면 직전 캐시, 없으면 빈 리스트


def build_feed_payload(
    ships: list[dict],
    feed_status: str,
    snapshot_time_ms: int | None = None,
    now_ms: int | None = None,
) -> str:
    """ships_update JSON 직렬화. 항상 문자열을 반환해 heartbeat 가 끊기지 않게 한다."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    payload = {
        "type": "ships_update",
        "ships": ships,
        "total_tracked": len(ships),
        "timestamp": now_ms,
        "server_time_ms": now_ms,
        "feed_status": feed_status,
    }
    if snapshot_time_ms is not None:
        payload["snapshot_time_ms"] = snapshot_time_ms
    return json.dumps(payload)
