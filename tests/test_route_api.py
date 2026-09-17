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
    assert len(data["coordinates"]) >= 2  # searoute 꼭짓점 — 조밀화는 프론트가 한다
    assert data["distance_km"] > 1000


def _km(a, b):
    import math
    r = math.radians
    h = (math.sin(r(b[1] - a[1]) / 2) ** 2
         + math.cos(r(a[1])) * math.cos(r(b[1])) * math.sin(r(b[0] - a[0]) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(h))


def test_route_returns_spline_control_points():
    """서버는 searoute 꼭짓점만 돌려주고, 촘촘한 선은 프론트 smoothRouteCoords() 가
    구면 스플라인으로 만든다(2026-04 72eaaaf 에서 서버 보간 제거). 예전 테스트는
    '점 간격 25km 이하' 를 요구했는데, 그건 폐기된 계약이라 5개월간 빨간불이었다.

    지금 계약에서 깨지면 안 되는 것:
    - 선분 길이의 합이 distance_km 와 일치 — 좌표가 잘리거나 어긋나면 드러난다
    - 끝점이 요청한 항구 근처 — searoute 는 해상 네트워크 노드로 스냅하므로 수십 km
      어긋날 수 있다(프론트 _anchorRouteEnds() 가 보정). 다만 위경도를 뒤바꾸는 식의
      회귀는 수천 km 로 튀므로 넉넉한 한계로도 잡힌다."""
    origin, dest = (129.05, 35.1), (103.85, 1.29)
    resp = client.get("/api/v1/route", params={
        "from_lat": origin[1], "from_lng": origin[0],
        "to_lat": dest[1], "to_lng": dest[0],
    })
    assert resp.status_code == 200
    data = resp.json()
    coords = data["coordinates"]
    assert len(coords) >= 2

    path_km = sum(_km(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
    assert abs(path_km - data["distance_km"]) / data["distance_km"] < 0.01, (
        f"좌표 선분 합 {path_km:.1f}km 이 distance_km {data['distance_km']} 와 어긋난다")

    assert _km(origin, coords[0]) < 100, "시작점이 요청 항구에서 너무 멀다(위경도 뒤바뀜?)"
    assert _km(dest, coords[-1]) < 100, "끝점이 요청 항구에서 너무 멀다(위경도 뒤바뀜?)"


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
