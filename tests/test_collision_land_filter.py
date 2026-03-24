# tests/test_collision_land_filter.py
"""collision_analyzer의 육지 필터 통합 테스트."""
import pytest
from unittest.mock import patch

from backend.services import land_filter, collision_analyzer


def _make_vessel(mmsi, lat, lng, sog=10.0, cog=90.0):
    return {
        "mmsi": mmsi, "lat": lat, "lng": lng,
        "sog": sog, "cog": cog,
        "name": f"SHIP-{mmsi}", "type": "cargo", "country": "KR",
    }


@pytest.fixture
def land_blocks():
    """is_land_between이 항상 True를 반환하도록 패치."""
    with patch.object(land_filter, "is_land_between", return_value=True):
        yield


@pytest.fixture
def land_clear():
    """is_land_between이 항상 False를 반환하도록 패치."""
    with patch.object(land_filter, "is_land_between", return_value=False):
        yield


def test_land_between_filters_pair(land_blocks):
    """육지가 가로막으면 근접 쌍에서 제외."""
    vessels = [
        _make_vessel(1001, 33.5, 125.0, sog=10, cog=90),
        _make_vessel(1002, 33.5, 125.03, sog=10, cog=270),
    ]
    pairs = collision_analyzer._build_proximity_pairs(vessels)
    assert len(pairs) == 0


def test_no_land_keeps_pair(land_clear):
    """육지가 없으면 근접 쌍 유지."""
    vessels = [
        _make_vessel(1001, 33.5, 125.0, sog=10, cog=90),
        _make_vessel(1002, 33.5, 125.03, sog=10, cog=270),
    ]
    pairs = collision_analyzer._build_proximity_pairs(vessels)
    assert len(pairs) >= 1
