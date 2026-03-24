# tests/test_land_filter.py
"""육지 차폐 필터 테스트.

실제 shapefile 없이도 동작하는 단위 테스트:
- Mock 폴리곤으로 교차 로직 검증
- 실제 shapefile이 있으면 통합 테스트도 실행
"""
import pytest
from unittest.mock import patch
from shapely.geometry import Polygon
from shapely import STRtree

from backend.services import land_filter


# --- 단위 테스트: Mock 폴리곤으로 교차 로직 검증 ---

@pytest.fixture
def mock_land():
    """제주도 크기의 가짜 육지 폴리곤을 주입."""
    fake_land = Polygon([
        (126.0, 33.0), (127.0, 33.0),
        (127.0, 34.0), (126.0, 34.0),
        (126.0, 33.0),
    ])
    fake_tree = STRtree([fake_land])
    with patch.object(land_filter, '_land_geom', [fake_land]), \
         patch.object(land_filter, '_land_tree', fake_tree), \
         patch.object(land_filter, '_loaded', True):
        yield


def test_line_crossing_land_returns_true(mock_land):
    """직선이 육지를 관통하면 True."""
    # 육지 서쪽(125, 33.5) → 동쪽(128, 33.5): 폴리곤 관통
    assert land_filter.is_land_between(33.5, 125.0, 33.5, 128.0) is True


def test_line_not_crossing_land_returns_false(mock_land):
    """직선이 육지를 관통하지 않으면 False."""
    # 육지 남쪽 바다에서만 이동 (위도 32)
    assert land_filter.is_land_between(32.0, 125.0, 32.0, 128.0) is False


def test_unloaded_returns_false():
    """데이터 미로드 시 안전하게 False 반환 (필터링 안 함)."""
    assert land_filter.is_loaded() is False
    assert land_filter.is_land_between(33.5, 125.0, 33.5, 128.0) is False


# --- 통합 테스트: 실제 shapefile이 있을 때만 실행 ---

SHAPEFILE_PATH = "backend/data/land/GSHHS_i_L1.shp"


@pytest.fixture
def real_land():
    """실제 shapefile이 존재하면 로드."""
    import os
    if not os.path.exists(SHAPEFILE_PATH):
        pytest.skip("shapefile not found — skipping integration test")
    land_filter.load_land_index(SHAPEFILE_PATH)
    yield
    # 테스트 후 상태 초기화
    land_filter._land_geom = None
    land_filter._land_tree = None
    land_filter._loaded = False


def test_real_korea_peninsula_blocks(real_land):
    """서해 ↔ 동해 직선은 한반도를 관통해야 함."""
    assert land_filter.is_land_between(36.0, 125.5, 36.0, 130.0) is True


def test_real_open_sea_clear(real_land):
    """남해 열린 바다 직선은 육지를 관통하지 않아야 함."""
    assert land_filter.is_land_between(31.0, 127.0, 31.0, 129.0) is False
