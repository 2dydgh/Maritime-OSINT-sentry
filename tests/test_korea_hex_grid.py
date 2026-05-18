"""한국 해역 헥스 그리드 — 셀 좌표 계산 테스트."""
import pytest

from backend.services import korea_hex_grid


def test_korea_cells_within_bbox():
    cells = korea_hex_grid.korea_cells()
    assert len(cells) > 0
    for lat, lng in cells:
        assert 33.0 <= lat <= 39.5
        assert 124.0 <= lng <= 132.0


def test_korea_cells_grid_spacing():
    """모든 인접 위도 차이는 CELL_DEG 정수배."""
    cells = korea_hex_grid.korea_cells()
    lats = sorted({lat for lat, _ in cells})
    if len(lats) >= 2:
        for i in range(len(lats) - 1):
            d = round(lats[i+1] - lats[i], 2)
            ratio = d / korea_hex_grid.CELL_DEG
            assert abs(ratio - round(ratio)) < 0.01


@pytest.mark.parametrize("wave_m,expected", [
    (0.0, 0.0), (1.0, 0.0), (3.0, 0.5), (5.0, 1.0), (10.0, 1.0),
])
def test_normalize_wave(wave_m, expected):
    assert korea_hex_grid._normalize_wave(wave_m) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize("wind_kts,expected", [
    (0.0, 0.0), (10.0, 0.0), (30.0, 0.5), (50.0, 1.0), (80.0, 1.0),
])
def test_normalize_wind(wind_kts, expected):
    assert korea_hex_grid._normalize_wind(wind_kts) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize("vis_m,expected", [
    (0.0, 1.0), (1000.0, 1.0), (5500.0, 0.5), (10000.0, 0.0), (20000.0, 0.0),
])
def test_normalize_visibility(vis_m, expected):
    assert korea_hex_grid._normalize_visibility(vis_m) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize("n_ships,expected", [
    (0, 0.0), (7, 0.467), (15, 1.0), (30, 1.0),
])
def test_normalize_traffic(n_ships, expected):
    assert korea_hex_grid._normalize_traffic(n_ships) == pytest.approx(expected, abs=0.01)
