"""collision_analyzer의 Class A/B 차등 임계값 테스트."""
from unittest.mock import patch

from backend.services import collision_analyzer
from backend.services import land_filter


def test_get_pair_class_aa():
    """Class A + A → 'AA' 키."""
    ship_a = {"ais_class": "A"}
    ship_b = {"ais_class": "A"}
    assert collision_analyzer._get_pair_class(ship_a, ship_b) == "AA"


def test_get_pair_class_ab():
    """Class A + B → 'AB' 키 (순서 무관)."""
    assert collision_analyzer._get_pair_class({"ais_class": "A"}, {"ais_class": "B"}) == "AB"
    assert collision_analyzer._get_pair_class({"ais_class": "B"}, {"ais_class": "A"}) == "AB"


def test_get_pair_class_bb():
    """Class B + B → 'BB' 키."""
    assert collision_analyzer._get_pair_class({"ais_class": "B"}, {"ais_class": "B"}) == "BB"


def test_get_pair_class_default():
    """ais_class 없으면 'A' 기본값 → 'AA'."""
    assert collision_analyzer._get_pair_class({}, {}) == "AA"


def test_thresholds_aa_stricter_than_bb():
    """A-A 임계값이 B-B보다 크다 (더 넓은 범위에서 경고)."""
    aa = collision_analyzer.CLASS_THRESHOLDS["AA"]
    bb = collision_analyzer.CLASS_THRESHOLDS["BB"]
    assert aa["dcpa_danger"] > bb["dcpa_danger"]
    assert aa["dcpa_warning"] > bb["dcpa_warning"]
    assert aa["tcpa_max"] > bb["tcpa_max"]


# --- Task 3: Class 기반 TCPA 필터 테스트 ---

def _make_vessel(mmsi, lat, lng, sog=10.0, cog=90.0, ais_class="A"):
    return {
        "mmsi": mmsi, "lat": lat, "lng": lng,
        "sog": sog, "cog": cog, "ais_class": ais_class,
        "name": f"SHIP-{mmsi}", "type": "cargo", "country": "KR",
    }


def test_bb_pair_filtered_by_shorter_tcpa_max():
    """B-B 쌍은 TCPA 10분 초과 시 필터링된다."""
    with patch.object(land_filter, "is_land_between", return_value=False):
        vessels_bb = [
            _make_vessel(2001, 33.5, 125.0, sog=5.0, cog=90, ais_class="B"),
            _make_vessel(2002, 33.5, 125.04, sog=5.0, cog=270, ais_class="B"),
        ]
        pairs_bb = collision_analyzer._build_proximity_pairs(vessels_bb)

        vessels_aa = [
            _make_vessel(3001, 33.5, 125.0, sog=5.0, cog=90, ais_class="A"),
            _make_vessel(3002, 33.5, 125.04, sog=5.0, cog=270, ais_class="A"),
        ]
        pairs_aa = collision_analyzer._build_proximity_pairs(vessels_aa)

    # B-B: TCPA ~12분 > tcpa_max 10분 → 필터링
    assert len(pairs_bb) == 0
    # A-A: TCPA ~12분 < tcpa_max 20분 → 유지
    assert len(pairs_aa) >= 1
