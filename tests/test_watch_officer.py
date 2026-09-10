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
