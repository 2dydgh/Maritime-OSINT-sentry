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


def _fake_weather(cells_with_values):
    return {
        "cells": [
            {"lat": lat, "lng": lng, **vals}
            for (lat, lng), vals in cells_with_values.items()
        ]
    }


def test_compute_cells_returns_only_cells_above_threshold():
    """raw < 0.30 인 셀은 응답에서 제외."""
    cells = korea_hex_grid.korea_cells()
    weather = _fake_weather({
        (lat, lng): {"wave_height": 0, "wind_speed": 0,
                     "visibility": 20000, "wind_direction": 0, "wave_period": 0}
        for (lat, lng) in cells
    })
    result = korea_hex_grid.compute_cells(weather, vessels=[], features=[])
    assert result == []


def test_compute_cells_high_wave_produces_cell():
    """파고 5m → wave subscore 1.0 → raw=0.30 → 셀 포함 + 빨강 점수."""
    cells = korea_hex_grid.korea_cells()
    target = cells[0]
    weather = _fake_weather({
        target: {"wave_height": 5.0, "wind_speed": 5,
                 "visibility": 20000, "wind_direction": 0, "wave_period": 7}
    })
    result = korea_hex_grid.compute_cells(weather, vessels=[], features=[])
    matched = [c for c in result if c["lat"] == target[0] and c["lng"] == target[1]]
    assert len(matched) == 1
    cell = matched[0]
    assert cell["score"] >= 70
    assert cell["cause"].startswith("파고")
    assert "subscores" in cell


def test_top_cause_picks_dominant_factor():
    """가중 기여 가장 큰 요소가 라벨로 선택됨."""
    subscores = {"wave": 0.1, "wind": 1.0, "vis": 0.2, "traffic": 0.0, "static": 0.0}
    raw_values = {"wave_raw": 1.4, "wind_raw": 50.0, "vis_raw": 8.0,
                  "traffic_n": 0, "static_names": []}
    cause = korea_hex_grid._top_cause(subscores, raw_values)
    assert cause == "강풍 50kt"


def test_top_cause_static_takes_name():
    subscores = {"wave": 0.0, "wind": 0.0, "vis": 0.0, "traffic": 0.0, "static": 1.0}
    raw_values = {"wave_raw": 0, "wind_raw": 0, "vis_raw": 10, "traffic_n": 0,
                  "static_names": ["울돌목 협수로"]}
    assert korea_hex_grid._top_cause(subscores, raw_values) == "울돌목 협수로"


def test_active_state_starts_false():
    korea_hex_grid.deactivate()
    assert korea_hex_grid.is_active() is False


def test_activate_then_deactivate():
    korea_hex_grid.activate()
    assert korea_hex_grid.is_active() is True
    korea_hex_grid.deactivate()
    assert korea_hex_grid.is_active() is False
