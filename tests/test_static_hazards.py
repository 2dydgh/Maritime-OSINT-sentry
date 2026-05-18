"""정적 위험구역 GeoJSON 로딩 및 셀 교차 판정 테스트."""
import os
from shapely.geometry import box

from backend.services import static_hazards


def test_load_returns_five_features():
    feats = static_hazards.load()
    assert len(feats) == 5
    ids = {f["properties"]["id"] for f in feats}
    assert ids == {"uldolmok", "jeju_strait", "busan_approach",
                   "incheon_approach", "mokpo_approach"}


def test_intersecting_returns_uldolmok_for_jindo_cell():
    """진도 부근 셀(34.56, 126.29)은 울돌목과 교차."""
    cell = box(126.29 - 0.6, 34.56 - 0.6, 126.29 + 0.6, 34.56 + 0.6)
    hits = static_hazards.intersecting(cell)
    ids = [f["properties"]["id"] for f in hits]
    assert "uldolmok" in ids


def test_intersecting_empty_for_open_pacific():
    """동해 한복판(38.0, 131.5) 셀은 어떤 feature와도 안 겹침."""
    cell = box(131.5 - 0.6, 38.0 - 0.6, 131.5 + 0.6, 38.0 + 0.6)
    hits = static_hazards.intersecting(cell)
    assert hits == []
