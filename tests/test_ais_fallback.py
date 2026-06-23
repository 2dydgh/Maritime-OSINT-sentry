import json
import pytest
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone

from backend.services import ais_fallback


# ── Task 1: select_feed_status ──

def test_live_when_count_above_threshold():
    status, streak = ais_fallback.select_feed_status(500, 0, "live", 0)
    assert status == "live"
    assert streak == 0


def test_hard_zero_switches_to_fallback_immediately():
    # live_count == 0 (하드 끊김) → 디바운스 없이 첫 틱부터 fallback (cold start 빈 글로브 틈 제거)
    status, streak = ais_fallback.select_feed_status(0, 1234, "live", 0)
    assert status == "fallback"
    assert streak == 1


def test_partial_dip_holds_live_one_tick():
    # 1~임계치 미만의 "부분 딥"은 한 틱 더 live 유지 (플래핑 방지)
    status, streak = ais_fallback.select_feed_status(50, 1234, "live", 0)
    assert status == "live"
    assert streak == 1


def test_partial_dip_sustained_switches_to_fallback():
    # 부분 딥이 디바운스 틱 채우면 fallback
    status, streak = ais_fallback.select_feed_status(50, 1234, "live", 1)
    assert status == "fallback"
    assert streak == 2


def test_sustained_low_switches_to_fallback():
    # 디바운스 충족 + 스냅샷 존재 → fallback
    status, streak = ais_fallback.select_feed_status(0, 1234, "live", 1)
    assert status == "fallback"
    assert streak == 2


def test_sustained_low_no_snapshot_is_down():
    status, streak = ais_fallback.select_feed_status(0, 0, "live", 1)
    assert status == "down"


def test_stays_fallback_while_low():
    status, _ = ais_fallback.select_feed_status(3, 5000, "fallback", 2)
    assert status == "fallback"


def test_recovers_to_live_immediately():
    status, streak = ais_fallback.select_feed_status(800, 5000, "fallback", 2)
    assert status == "live"
    assert streak == 0


# ── Task 2: get_fallback_snapshot + cache ──

def _mock_pool(rows):
    """asyncpg 풀 모킹: pool.acquire() async context → conn.fetch(...) → rows."""
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=rows)
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


@pytest.mark.asyncio
async def test_snapshot_maps_rows_to_live_shape():
    ais_fallback._reset_cache_for_test()
    rt = datetime(2026, 6, 22, 1, 0, 0, tzinfo=timezone.utc)
    rows = [{
        "object_id": "440123456", "lng": 129.04, "lat": 35.11,
        "velocity": 12.4, "heading": 180.0, "ship_type": "cargo",
        "record_time": rt,
    }]
    ships = await ais_fallback.get_fallback_snapshot(pool=_mock_pool(rows))
    assert len(ships) == 1
    s = ships[0]
    assert s["mmsi"] == 440123456
    assert s["type"] == "cargo"
    assert s["sog"] == 12.4
    assert s["lat"] == 35.11 and s["lng"] == 129.04
    assert s["country"] == "South Korea"  # MID 440
    assert s["ais_class"] == "A"
    assert ais_fallback.get_snapshot_time_ms() == int(rt.timestamp() * 1000)


@pytest.mark.asyncio
async def test_snapshot_decimal_columns_are_json_serializable():
    # PostGIS numeric 컬럼은 Decimal 로 온다 → float 로 변환돼 json.dumps 가능해야 함.
    from decimal import Decimal
    ais_fallback._reset_cache_for_test()
    rt = datetime(2026, 6, 22, 1, 0, 0, tzinfo=timezone.utc)
    rows = [{
        "object_id": "440123456", "lng": Decimal("129.04"), "lat": Decimal("35.11"),
        "velocity": Decimal("12.4"), "heading": Decimal("180"), "ship_type": "cargo",
        "record_time": rt,
    }]
    ships = await ais_fallback.get_fallback_snapshot(pool=_mock_pool(rows))
    text = ais_fallback.build_feed_payload(ships, "fallback", now_ms=1750000005000)
    d = json.loads(text)  # Decimal 이 남아있으면 build_feed_payload 에서 터진다
    assert isinstance(d["ships"][0]["sog"], float)
    assert d["ships"][0]["lat"] == 35.11


@pytest.mark.asyncio
async def test_snapshot_empty_when_no_pool():
    ais_fallback._reset_cache_for_test()
    ships = await ais_fallback.get_fallback_snapshot(pool=None)
    assert ships == []
    assert ais_fallback.get_snapshot_time_ms() is None


@pytest.mark.asyncio
async def test_snapshot_uses_cache_within_ttl():
    ais_fallback._reset_cache_for_test()
    rt = datetime(2026, 6, 22, 1, 0, 0, tzinfo=timezone.utc)
    rows = [{"object_id": "1", "lng": 0.0, "lat": 0.0, "velocity": 0.0,
             "heading": 0.0, "ship_type": "unknown", "record_time": rt}]
    pool = _mock_pool(rows)
    await ais_fallback.get_fallback_snapshot(pool=pool)
    await ais_fallback.get_fallback_snapshot(pool=pool)
    # 캐시 적중 → DB는 한 번만 조회
    assert pool.acquire.call_count == 1


# ── Task 3: build_feed_payload ──

def test_payload_includes_feed_status_and_ships():
    text = ais_fallback.build_feed_payload(
        [{"mmsi": 1, "lat": 1.0, "lng": 2.0}], "fallback",
        snapshot_time_ms=1750000000000, now_ms=1750000005000)
    d = json.loads(text)
    assert d["type"] == "ships_update"
    assert d["feed_status"] == "fallback"
    assert d["total_tracked"] == 1
    assert d["snapshot_time_ms"] == 1750000000000
    assert d["server_time_ms"] == 1750000005000


def test_payload_empty_is_still_valid_heartbeat():
    text = ais_fallback.build_feed_payload([], "down", now_ms=1750000005000)
    d = json.loads(text)
    assert d["feed_status"] == "down"
    assert d["ships"] == []
    assert "snapshot_time_ms" not in d  # None 이면 생략


# ── Regression: 스냅샷 창은 데이터 최신 시각 기준 (now() 아님) ──

def test_snapshot_query_anchors_to_latest_record_not_wallclock():
    """라이브 끊김 시 history_writer 도 안 쓰므로 now()-30분 창은 0행이 된다.
    창은 반드시 DB 최신 record_time 기준이어야 한다."""
    q = ais_fallback._SNAPSHOT_QUERY.lower()
    assert "max(record_time)" in q, "창이 데이터 최신 시각에 앵커되지 않음"
    assert "now()" not in q, "now() 기준 창은 끊김 시 항상 비어 버그 재발"
