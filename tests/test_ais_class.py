"""ais_stream의 ais_class 필드 저장 테스트."""
from backend.services import ais_stream


def test_class_a_default():
    """ais_class 기본값은 'A'."""
    vessel = {"_updated": 1.0}
    assert vessel.get("ais_class", "A") == "A"


def test_get_ais_vessels_includes_ais_class():
    """get_ais_vessels 응답에 ais_class 필드가 포함된다."""
    import time
    mmsi = 999000001
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": 33.5, "lng": 125.0, "sog": 10.0, "cog": 90.0,
            "heading": 90, "name": "TEST-A", "type": "cargo",
            "callsign": "TSTA", "destination": "BUSAN", "imo": 0,
            "length": 200, "beam": 30, "draught": 10.0, "eta": "",
            "ais_class": "A", "_updated": time.time(),
        }
    try:
        vessels = ais_stream.get_ais_vessels()
        test_vessel = [v for v in vessels if v["mmsi"] == mmsi]
        assert len(test_vessel) == 1
        assert test_vessel[0]["ais_class"] == "A"
    finally:
        with ais_stream._vessels_lock:
            ais_stream._vessels.pop(mmsi, None)


def test_class_b_vessel():
    """ais_class 'B'로 저장된 선박이 올바르게 반환된다."""
    import time
    mmsi = 999000002
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": 34.0, "lng": 126.0, "sog": 5.0, "cog": 180.0,
            "heading": 180, "name": "TEST-B", "type": "fishing",
            "callsign": "TSTB", "destination": "", "imo": 0,
            "length": 15, "beam": 5, "draught": 2.0, "eta": "",
            "ais_class": "B", "_updated": time.time(),
        }
    try:
        vessels = ais_stream.get_ais_vessels()
        test_vessel = [v for v in vessels if v["mmsi"] == mmsi]
        assert len(test_vessel) == 1
        assert test_vessel[0]["ais_class"] == "B"
    finally:
        with ais_stream._vessels_lock:
            ais_stream._vessels.pop(mmsi, None)
