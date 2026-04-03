from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_route_busan_to_tokyo():
    resp = client.get("/api/v1/route", params={
        "from_lat": 35.1, "from_lng": 129.05,
        "to_lat": 35.45, "to_lng": 139.77,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "coordinates" in data
    assert "distance_km" in data
    assert "point_count" in data
    assert len(data["coordinates"]) >= 20  # interpolated, should be dense
    assert data["distance_km"] > 1000


def test_route_interpolation_density():
    """Points should be no more than ~25km apart after interpolation."""
    import math
    resp = client.get("/api/v1/route", params={
        "from_lat": 35.1, "from_lng": 129.05,
        "to_lat": 1.29, "to_lng": 103.85,
    })
    data = resp.json()
    coords = data["coordinates"]
    max_gap = 0
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        dlat = math.radians(b[1] - a[1])
        dlon = math.radians(b[0] - a[0])
        x = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(dlon / 2) ** 2
        km = 2 * 6371 * math.asin(math.sqrt(x))
        if km > max_gap:
            max_gap = km
    assert max_gap < 25, f"Max gap between points is {max_gap:.1f}km, expected < 25km"


def test_route_missing_params():
    resp = client.get("/api/v1/route", params={"from_lat": 35.1})
    assert resp.status_code == 422


def test_port_search_api():
    resp = client.get("/api/v1/ports/search", params={"q": "Busan"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    assert data[0]["name"] == "Busan"


def test_port_search_korean():
    resp = client.get("/api/v1/ports/search", params={"q": "부산"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
