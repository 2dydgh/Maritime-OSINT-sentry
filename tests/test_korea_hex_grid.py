"""한국 해역 헥스 그리드 — 셀 좌표 계산 테스트."""
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
