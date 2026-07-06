import time
from fastapi.testclient import TestClient
from backend.main import app
from backend.services import ais_stream

client = TestClient(app)


def test_dark_ships_route_returns_registered_entries():
    mmsi = 999200001
    now = time.time()
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels[mmsi] = {
            "mmsi": mmsi, "name": "TEST-ROUTE", "lat": 35.0, "lng": 129.0,
            "vessel_type": "cargo", "lost_at": now - 3600,
        }
    try:
        resp = client.get("/api/v1/ships/dark")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == len(data["dark_ships"])
        entry = next(d for d in data["dark_ships"] if d["mmsi"] == mmsi)
        assert entry["name"] == "TEST-ROUTE"
        assert entry["radius_nm"] == 24.0
    finally:
        with ais_stream._vessels_lock:
            ais_stream._dark_vessels.pop(mmsi, None)


def test_dark_ships_route_empty_list_when_none_dark():
    with ais_stream._vessels_lock:
        ais_stream._dark_vessels.clear()
    resp = client.get("/api/v1/ships/dark")
    assert resp.status_code == 200
    assert resp.json() == {"dark_ships": [], "total": 0}
