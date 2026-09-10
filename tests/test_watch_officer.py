"""당직사관 에이전트 테스트 — 규칙·중복억제·저장·그래프·브리핑."""
from pathlib import Path

import rdflib
from rdflib.namespace import OWL, RDF

from backend import config

MOS = rdflib.Namespace("https://maritime-osint-sentry/ontology#")
TTL_PATH = Path(__file__).parent.parent / "backend" / "data" / "mos.ttl"


def test_config_defaults():
    assert config.WATCH_DCPA_NM == 0.3
    assert config.WATCH_TCPA_MIN == 10.0
    assert config.WATCH_COOLDOWN_MIN == 30.0
    assert config.WATCH_BRIEF_LLM is True


def test_ontology_declares_six_classes_and_four_properties():
    g = rdflib.Graph().parse(TTL_PATH, format="turtle")
    classes = {s for s in g.subjects(RDF.type, OWL.Class) if str(s).startswith(str(MOS))}
    assert len(classes) == 6
    props = set(g.subjects(RDF.type, OWL.ObjectProperty)) | set(g.subjects(RDF.type, OWL.DatatypeProperty))
    assert len(props) == 4
    assert (MOS.Proposal, None, None) in g


import pytest

from backend.services import watch_officer as wo


def _info(mmsi, name="SHIP", typ="cargo", lat=35.0, lng=129.0):
    return {"mmsi": mmsi, "name": name, "type": typ, "lat": lat, "lng": lng, "sog": 10.0, "cog": 90.0, "country": "KR"}


def _ml(level, a=111, b=222, dcpa=0.5, tcpa=8.0):
    return {"ship_a": _info(a, "ALPHA"), "ship_b": _info(b, "BRAVO", lat=35.01), "risk_level": level,
            "risk_label": {1: "주의", 2: "경고", 3: "위험"}[level], "current_dist_nm": 1.0,
            "tcpa_min": tcpa, "dcpa_nm": dcpa, "ts": "2026-09-10T03:12:00+00:00"}


def _dist(dcpa, tcpa, a=111, b=222, severity="danger"):
    return {"ship_a": _info(a, "ALPHA"), "ship_b": _info(b, "BRAVO", lat=35.01), "tcpa_min": tcpa, "dcpa_nm": dcpa,
            "current_dist_nm": 1.0, "severity": severity, "encounter": "crossing", "pair_class": "AA",
            "ts": "2026-09-10T03:12:00+00:00"}


@pytest.fixture(autouse=True)
def _reset_state():
    wo.reset()
    yield
    wo.reset()


def test_pair_key_is_sorted():
    assert wo.pair_key(222, 111) == (111, 222)


def test_rule_ml_level3_is_candidate_level2_is_not():
    assert len(wo.collision_high_risk([_ml(3)], [])) == 1
    assert wo.collision_high_risk([_ml(2)], []) == []


def test_rule_distance_thresholds_are_exclusive_boundaries():
    assert len(wo.collision_high_risk([], [_dist(0.29, 9.9)])) == 1
    assert wo.collision_high_risk([], [_dist(0.3, 9.9)]) == []      # dcpa == 임계 → 아님
    assert wo.collision_high_risk([], [_dist(0.29, 10.0)]) == []    # tcpa == 임계 → 아님
    assert wo.collision_high_risk([], [_dist(0.29, 0.0)]) == []     # tcpa 0 → 아님


def test_ml_and_distance_same_pair_yield_one_candidate_preferring_ml():
    cands = wo.collision_high_risk([_ml(3)], [_dist(0.1, 5.0)])
    assert len(cands) == 1
    assert cands[0]["trigger"]["source"] == "ml"


def test_evaluate_creates_record_with_spec_shape():
    new, updated, expired = wo.evaluate([_ml(3)], [], now=1_000_000.0)
    assert (len(new), len(updated), len(expired)) == (1, 0, 0)
    p = new[0]
    assert p["id"].startswith("p_") and p["id"].endswith("_111_222")
    assert p["status"] == "open" and p["decision"] is None
    assert p["trigger"]["kind"] == "collision_risk" and p["trigger"]["risk_level"] == 3
    assert [s["mmsi"] for s in p["subjects"]] == [111, 222]
    assert p["actions"][0]["action"] == "fly_to" and p["actions"][0]["zoom"] == 12
    assert p["actions"][1] == {"action": "highlight_pair", "mmsi": [111, 222], "risk_level": 3}
    assert p["brief_source"] == "template"
    assert "ALPHA" in p["brief"] and "BRAVO" in p["brief"] and "0.50" in p["brief"] and "8.0" in p["brief"]


def test_evaluate_same_pair_twice_updates_not_duplicates():
    new, _, _ = wo.evaluate([_ml(3)], [], now=1000.0)
    new2, updated, _ = wo.evaluate([_ml(3, dcpa=0.2)], [], now=1010.0)
    assert new2 == [] and len(updated) == 1
    assert updated[0]["id"] == new[0]["id"]
    assert updated[0]["trigger"]["dcpa_nm"] == 0.2
    assert len(wo.list_proposals()) == 1


def test_pair_disappearing_expires_and_cooldown_blocks_reproposal():
    new, _, _ = wo.evaluate([_ml(3)], [], now=1000.0)
    _, _, expired = wo.evaluate([], [], now=1010.0)
    assert expired[0]["id"] == new[0]["id"] and expired[0]["status"] == "expired"
    new3, _, _ = wo.evaluate([_ml(3)], [], now=1010.0 + 29 * 60)
    assert new3 == []
    new4, _, _ = wo.evaluate([_ml(3)], [], now=1010.0 + 31 * 60)
    assert len(new4) == 1 and new4[0]["id"] != new[0]["id"]


def test_decide_marks_and_rejects_non_open():
    new, _, _ = wo.evaluate([_ml(3)], [], now=1000.0)
    pid = new[0]["id"]
    rec = wo.decide(pid, "dismissed", "false_positive", now=1005.0)
    assert rec["status"] == "dismissed" and rec["decision"]["reason"] == "false_positive"
    with pytest.raises(ValueError):
        wo.decide(pid, "approved")
    with pytest.raises(KeyError):
        wo.decide("nope", "approved")
    # 결정 후 쿨다운
    new2, _, _ = wo.evaluate([_ml(3)], [], now=1005.0 + 10 * 60)
    assert new2 == []


def test_list_proposals_filters_and_orders_newest_first():
    wo.evaluate([_ml(3, a=1, b=2)], [], now=1000.0)
    wo.evaluate([_ml(3, a=1, b=2), _ml(3, a=3, b=4)], [], now=1100.0)
    assert [p["subjects"][0]["mmsi"] for p in wo.list_proposals()] == [3, 1]
    wo.decide(wo.list_proposals()[0]["id"], "approved")
    assert len(wo.list_proposals(status="open")) == 1
    assert len(wo.list_proposals(limit=1)) == 1


def test_memory_cap_drops_oldest_decided_first(monkeypatch):
    monkeypatch.setattr(wo, "MAX_PROPOSALS", 3)
    for i in range(3):
        wo.evaluate([_ml(3, a=10 + i, b=20 + i)], [], now=1000.0 + i)
        wo.decide(wo.list_proposals()[0]["id"], "approved")
    wo.evaluate([_ml(3, a=99, b=98)], [], now=2000.0)
    ids = [p["subjects"][0]["mmsi"] for p in wo.list_proposals(limit=100)]
    assert ids == [99, 12, 11]


def test_brief_template_distance_source_uses_cpa_label():
    new, _, _ = wo.evaluate([], [_dist(0.1, 5.0)], now=1000.0)
    assert "CPA 임계" in new[0]["brief"] and "횡단" in new[0]["brief"]
