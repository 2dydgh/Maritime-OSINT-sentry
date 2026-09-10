"""당직사관 제안 API 테스트."""
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.services import watch_graph as wg
from backend.services import watch_officer as wo

client = TestClient(app)


def _ml3(a=111, b=222):
    def info(m, n):
        return {"mmsi": m, "name": n, "type": "cargo", "lat": 35.0, "lng": 129.0, "sog": 10.0, "cog": 90.0, "country": "KR"}
    return {"ship_a": info(a, "ALPHA"), "ship_b": info(b, "BRAVO"), "risk_level": 3, "risk_label": "위험",
            "current_dist_nm": 1.0, "tcpa_min": 8.0, "dcpa_nm": 0.5, "ts": "2026-09-10T03:12:00+00:00"}


@pytest.fixture(autouse=True)
def _state(monkeypatch, tmp_path):
    async def silent(_payload):
        pass
    monkeypatch.setattr(wo, "_broadcast", silent)
    monkeypatch.setattr(wo, "JSONL_PATH", tmp_path / "p.jsonl")
    wo.reset(); wg.reset()
    new, _, _ = wo.evaluate([_ml3()], [], now=1000.0)
    wg.add_proposal(new[0])
    yield new[0]["id"]
    wo.reset(); wg.reset()


def test_list_and_filter(_state):
    r = client.get("/api/v1/proposals")
    assert r.status_code == 200 and r.json()["total"] == 1
    assert r.json()["proposals"][0]["id"] == _state
    assert client.get("/api/v1/proposals?status=approved").json()["total"] == 0


def test_list_total_ignores_limit(_state):
    wo.evaluate([_ml3(), _ml3(a=333, b=444)], [], now=1000.0)
    r = client.get("/api/v1/proposals?limit=1")
    assert len(r.json()["proposals"]) == 1
    assert r.json()["total"] == 2


def test_decision_flow_and_409(_state, tmp_path):
    r = client.post(f"/api/v1/proposals/{_state}/decision", json={"outcome": "dismissed", "reason": "monitor"})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    assert len((tmp_path / "p.jsonl").read_text().splitlines()) == 1
    r = client.post(f"/api/v1/proposals/{_state}/decision", json={"outcome": "approved"})
    assert r.status_code == 409
    assert client.post("/api/v1/proposals/nope/decision", json={"outcome": "approved"}).status_code == 404
    assert client.post(f"/api/v1/proposals/{_state}/decision", json={"outcome": "maybe"}).status_code == 422


def test_graph_endpoint_formats(_state):
    r = client.get(f"/api/v1/proposals/{_state}/graph")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/turtle")
    assert "wasDerivedFrom" in r.text
    r = client.get(f"/api/v1/proposals/{_state}/graph?format=json-ld")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/ld+json")
    assert client.get(f"/api/v1/proposals/{_state}/graph?format=xml").status_code == 400
    assert client.get("/api/v1/proposals/nope/graph").status_code == 404
