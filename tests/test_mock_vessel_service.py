"""Mock vessel service — lifecycle and snapshot tests."""
from backend.services import mock_vessel_service as mvs


def setup_function():
    mvs.stop()


def teardown_function():
    mvs.stop()


def test_initial_state_inactive():
    assert mvs.is_active() is False
    assert mvs.snapshot() == []


def test_start_spawns_vessels():
    mvs.start()
    assert mvs.is_active() is True
    snap = mvs.snapshot()
    assert 20 <= len(snap) <= 35  # 25-30 expected
    for v in snap:
        assert v["is_simulated"] is True
        assert 999_000_000 <= v["mmsi"] <= 999_999_999
        assert 33.0 <= v["lat"] <= 39.5
        assert 124.0 <= v["lng"] <= 132.0


def test_stop_clears_vessels():
    mvs.start()
    assert mvs.snapshot() != []
    mvs.stop()
    assert mvs.is_active() is False
    assert mvs.snapshot() == []
