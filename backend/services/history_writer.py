"""
History Writer: 비동기 배치 writer for AIS trajectory data.
AIS 위치 데이터를 메모리 버퍼에 쌓다가 일정 개수/시간마다 PostgreSQL에 bulk insert.
선박당 30초 간격으로 샘플링하여 DB 부하 최소화.
"""

import asyncio
import logging
import time
import threading
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Configuration
BATCH_SIZE = 100  # 이 개수만큼 쌓이면 flush
FLUSH_INTERVAL_SEC = 30  # 이 시간마다 강제 flush
SAMPLE_INTERVAL_SEC = 30  # 선박당 위치 기록 최소 간격 (초)

# Internal state
_buffer: list[dict] = []
_buffer_lock = threading.Lock()  # 스레드 간 안전을 위해 threading.Lock 사용
_last_record_time: dict[str, float] = {}  # mmsi → 마지막 기록 시간
_flush_task: Optional[asyncio.Task] = None
_running = False
_db_pool = None
_main_loop: Optional[asyncio.AbstractEventLoop] = None  # 메인 이벤트 루프 저장


async def init_history_writer(db_pool) -> None:
    """Initialize the history writer with database pool."""
    global _db_pool, _running, _flush_task, _main_loop
    _db_pool = db_pool
    _running = True
    _main_loop = asyncio.get_running_loop()  # 메인 루프 저장

    # Start periodic flush task
    _flush_task = asyncio.create_task(_periodic_flush())
    logger.info("History writer initialized")


async def stop_history_writer() -> None:
    """Stop the history writer and flush remaining buffer."""
    global _running, _flush_task
    _running = False

    if _flush_task:
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass

    # Final flush
    await _flush_buffer()
    logger.info("History writer stopped")


async def _periodic_flush() -> None:
    """Periodically flush the buffer to database."""
    while _running:
        try:
            await asyncio.sleep(FLUSH_INTERVAL_SEC)
            await _flush_buffer()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in periodic flush: {e}")


async def _flush_buffer() -> None:
    """Flush buffered records to database."""
    global _buffer

    # threading.Lock은 동기식으로 사용
    with _buffer_lock:
        if not _buffer:
            return

        records_to_insert = _buffer.copy()
        _buffer = []

    if not _db_pool:
        logger.warning("DB pool not available, discarding records")
        return

    try:
        async with _db_pool.acquire() as conn:
            # Bulk insert with ON CONFLICT DO UPDATE
            await conn.executemany(
                """
                INSERT INTO trajectories (object_id, object_type, record_time, geom, altitude, velocity, heading, ship_type)
                VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5, $6), 4326), $7, $8, $9, $10)
                ON CONFLICT (object_id, record_time)
                DO UPDATE SET
                    geom = EXCLUDED.geom,
                    altitude = EXCLUDED.altitude,
                    velocity = EXCLUDED.velocity,
                    heading = EXCLUDED.heading,
                    ship_type = EXCLUDED.ship_type
                """,
                [
                    (
                        r["object_id"],
                        r["object_type"],
                        r["record_time"],
                        r["lng"],       # X (경도)
                        r["lat"],       # Y (위도)
                        r["altitude"],  # Z (고도)
                        r["altitude"],
                        r["velocity"],
                        r["heading"],
                        r["ship_type"],
                    )
                    for r in records_to_insert
                ]
            )
        logger.info(f"History writer: flushed {len(records_to_insert)} records to DB")
    except Exception as e:
        logger.error(f"History writer DB error: {e}")
        # 실패해도 실시간 기능은 계속 동작해야 하므로 재시도 없이 로그만 남김


def record_position(
    mmsi: int,
    lat: float,
    lng: float,
    sog: float,
    heading: float,
    ship_type: str = "unknown",
    ship_name: str = "UNKNOWN",
    timestamp: Optional[datetime] = None
) -> None:
    """
    Record a vessel position for later batch insertion.
    Thread-safe: 다른 스레드에서 호출 가능.
    선박당 SAMPLE_INTERVAL_SEC 간격으로 샘플링.
    """
    now = time.time()
    mmsi_str = str(mmsi)

    with _buffer_lock:
        # Sampling: 마지막 기록 후 30초 이내면 스킵
        last_time = _last_record_time.get(mmsi_str, 0)
        if now - last_time < SAMPLE_INTERVAL_SEC:
            return

        _last_record_time[mmsi_str] = now

        record = {
            "object_id": mmsi_str,
            "object_type": "ship",
            "record_time": timestamp or datetime.now(timezone.utc),
            "lat": lat,
            "lng": lng,
            "altitude": 0.0,
            "velocity": sog,
            "heading": heading,
            "ship_type": ship_type or "unknown",
            "ship_name": ship_name or "UNKNOWN",
        }

        _buffer.append(record)
        buffer_size = len(_buffer)

    # 배치 사이즈 도달 시 메인 루프에서 flush 스케줄링
    if buffer_size >= BATCH_SIZE and _main_loop and _running:
        try:
            _main_loop.call_soon_threadsafe(
                lambda: asyncio.create_task(_flush_buffer())
            )
        except RuntimeError:
            pass


