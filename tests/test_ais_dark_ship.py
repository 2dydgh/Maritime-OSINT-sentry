import time
import pytest
from backend.services import ais_stream


def _set_vessel(mmsi, lat, lng, v_type, updated):
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": lat, "lng": lng, "name": f"TEST-{mmsi}",
            "type": v_type, "_updated": updated,
        }


def _cleanup(mmsi):
    with ais_stream._vessels_lock:
        ais_stream._vessels.pop(mmsi, None)
        ais_stream._dark_vessels.pop(mmsi, None)
    ais_stream._alert_cooldown.clear()


def test_signal_loss_registers_dark_vessel():
    mmsi = 999100001
    now = time.time()
    _set_vessel(mmsi, 34.5, 129.1, "cargo", now - 1900)  # 31.6분 전
    try:
        ais_stream.check_signal_loss()
        dark = {d["mmsi"]: d for d in ais_stream.get_dark_vessels()}
        assert mmsi in dark
        assert dark[mmsi]["lat"] == 34.5
        assert dark[mmsi]["lng"] == 129.1
        assert dark[mmsi]["vessel_type"] == "cargo"
        assert dark[mmsi]["minutes_dark"] >= 31
    finally:
        _cleanup(mmsi)


def test_signal_resume_clears_dark_vessel():
    mmsi = 999100002
    now = time.time()
    _set_vessel(mmsi, 34.5, 129.1, "cargo", now - 1900)
    try:
        ais_stream.check_signal_loss()
        assert mmsi in {d["mmsi"] for d in ais_stream.get_dark_vessels()}
        _set_vessel(mmsi, 34.6, 129.2, "cargo", now)  # 신호 복귀
        ais_stream.check_signal_loss()
        assert mmsi not in {d["mmsi"] for d in ais_stream.get_dark_vessels()}
    finally:
        _cleanup(mmsi)


def test_dark_vessel_expires_after_max_age():
    mmsi = 999100003
    now = time.time()
    stale = now - ais_stream._DARK_MAX_AGE_S - 60
    _set_vessel(mmsi, 1.0, 1.0, "cargo", stale)
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels[mmsi] = {
            "mmsi": mmsi, "name": "TEST", "lat": 1.0, "lng": 1.0,
            "vessel_type": "cargo", "lost_at": stale,
        }
    try:
        ais_stream.check_signal_loss()
        assert mmsi not in {d["mmsi"] for d in ais_stream.get_dark_vessels()}
        assert mmsi not in ais_stream._dark_vessels
    finally:
        _cleanup(mmsi)


def test_radius_excludes_vessel_beyond_max_radius():
    mmsi = 999100004
    now = time.time()
    # cargo 상한 24kn → 50nm 도달까지 50/24 ≈ 2.08h. 2.5h 지나면 초과.
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels[mmsi] = {
            "mmsi": mmsi, "name": "TEST", "lat": 1.0, "lng": 1.0,
            "vessel_type": "cargo", "lost_at": now - 2.5 * 3600,
        }
    try:
        assert mmsi not in {d["mmsi"] for d in ais_stream.get_dark_vessels()}
    finally:
        _cleanup(mmsi)


def test_radius_calculation_uses_type_speed_ceiling():
    mmsi = 999100005
    now = time.time()
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels[mmsi] = {
            "mmsi": mmsi, "name": "TEST", "lat": 1.0, "lng": 1.0,
            "vessel_type": "cargo", "lost_at": now - 3600,  # 정확히 1시간 전
        }
    try:
        dark = {d["mmsi"]: d for d in ais_stream.get_dark_vessels()}
        assert dark[mmsi]["radius_nm"] == pytest.approx(24.0, abs=0.1)
    finally:
        _cleanup(mmsi)


def test_non_target_type_not_registered_as_dark():
    mmsi = 999100006
    now = time.time()
    _set_vessel(mmsi, 1.0, 1.0, "fishing", now - 1900)
    try:
        ais_stream.check_signal_loss()
        assert mmsi not in {d["mmsi"] for d in ais_stream.get_dark_vessels()}
    finally:
        _cleanup(mmsi)
