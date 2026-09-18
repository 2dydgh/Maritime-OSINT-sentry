import time

import pytest

from backend.services import ais_stream


def _set_vessel(mmsi, lat, lng, v_type, updated):
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": lat,
            "lng": lng,
            "name": f"TEST-{mmsi}",
            "type": v_type,
            "_updated": updated,
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
            "mmsi": mmsi,
            "name": "TEST",
            "lat": 1.0,
            "lng": 1.0,
            "vessel_type": "cargo",
            "lost_at": stale,
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
            "mmsi": mmsi,
            "name": "TEST",
            "lat": 1.0,
            "lng": 1.0,
            "vessel_type": "cargo",
            "lost_at": now - 2.5 * 3600,
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
            "mmsi": mmsi,
            "name": "TEST",
            "lat": 1.0,
            "lng": 1.0,
            "vessel_type": "cargo",
            "lost_at": now - 3600,  # 정확히 1시간 전
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


def _simulate_ingest_prune():
    """Simulates the ingest loop's periodic prune block (ais_stream.py, inside the
    main message-processing loop): vessels stale beyond 900s (15 min) are handed off
    to _dark_vessels (if eligible) before being deleted from _vessels. This is the
    integration path that was broken — check_signal_loss()'s 30-min threshold never
    got a chance to see vessels because the ingest loop pruned them at 15 min first."""
    with ais_stream._vessels_lock:
        prune_cutoff = time.time() - 900
        stale = [k for k, v in ais_stream._vessels.items() if v.get("_updated", 0) < prune_cutoff]
        for k in stale:
            v = ais_stream._vessels[k]
            v_type = v.get("type", "unknown")
            lat = v.get("lat")
            lng = v.get("lng")
            if (
                v_type in ais_stream._DARK_ELIGIBLE_TYPES
                and k not in ais_stream._dark_vessels
                and lat is not None
                and lng is not None
            ):
                ais_stream._dark_vessels[k] = {
                    "mmsi": k,
                    "name": v.get("name", "UNKNOWN"),
                    "lat": lat,
                    "lng": lng,
                    "vessel_type": v_type,
                    "lost_at": v.get("_updated", prune_cutoff),
                }
            del ais_stream._vessels[k]


def test_prune_seeds_dark_vessel_before_30min_check_would_see_it():
    mmsi = 999100007
    now = time.time()
    # Past the 900s (15 min) prune cutoff but well under the 1800s (30 min) dark-entry
    # threshold — this is exactly the window where the vessel used to fall through the
    # cracks: pruned out of _vessels before check_signal_loss() could ever observe it.
    lost_at = now - 1000
    _set_vessel(mmsi, 34.5, 129.1, "cargo", lost_at)
    try:
        _simulate_ingest_prune()

        # Vessel is gone from _vessels (pruned) but seeded into _dark_vessels with the
        # real last-transmission time, not the prune cutoff.
        with ais_stream._vessels_lock:
            assert mmsi not in ais_stream._vessels
            assert mmsi in ais_stream._dark_vessels
            assert ais_stream._dark_vessels[mmsi]["lost_at"] == lost_at

        # Not yet surfaced by the API — only 1000s elapsed, below the 1800s dark-entry gate.
        assert mmsi not in {d["mmsi"] for d in ais_stream.get_dark_vessels()}

        # Advance the clock past the 30-min threshold: now it should surface.
        with ais_stream._vessels_lock:
            ais_stream._dark_vessels[mmsi]["lost_at"] = now - ais_stream._DARK_ENTER_S - 60
        dark = {d["mmsi"]: d for d in ais_stream.get_dark_vessels()}
        assert mmsi in dark
    finally:
        _cleanup(mmsi)


def test_prune_does_not_overwrite_existing_dark_entry():
    mmsi = 999100008
    now = time.time()
    original_lost_at = now - 5000
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels[mmsi] = {
            "mmsi": mmsi,
            "name": "ORIGINAL",
            "lat": 1.0,
            "lng": 1.0,
            "vessel_type": "cargo",
            "lost_at": original_lost_at,
        }
    # Vessel reappears in _vessels stale (e.g. a late/duplicate message) — prune should
    # not reset lost_at for an mmsi that's already tracked as dark.
    _set_vessel(mmsi, 2.0, 2.0, "cargo", now - 1000)
    try:
        _simulate_ingest_prune()
        with ais_stream._vessels_lock:
            assert ais_stream._dark_vessels[mmsi]["lost_at"] == original_lost_at
            assert ais_stream._dark_vessels[mmsi]["name"] == "ORIGINAL"
    finally:
        _cleanup(mmsi)
