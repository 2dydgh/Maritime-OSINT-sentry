"""당직사관 근거 그래프 — PROV-O + SOSA + mos: 어휘의 rdflib 인메모리 그래프.

JSONL 레코드가 원본이다. 그래프는 저장하지 않고 restore 시 레코드에서 재생성한다.
추론기·트리플스토어·SPARQL 엔드포인트 없음.
"""
import json
from pathlib import Path

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import PROV, RDF, SOSA, XSD

MOS = Namespace("https://maritime-osint-sentry/ontology#")
TTL_PATH = Path(__file__).resolve().parent.parent / "data" / "mos.ttl"
AGENT = MOS["agent/watch-officer"]
OPERATOR = MOS["agent/operator"]
FORMATS = {"turtle": "turtle", "json-ld": "json-ld"}

_graph = Graph()


def reset() -> None:
    global _graph
    _graph = Graph()
    _graph.bind("mos", MOS); _graph.bind("prov", PROV); _graph.bind("sosa", SOSA)
    _graph.parse(TTL_PATH, format="turtle")
    _graph.add((AGENT, RDF.type, MOS.WatchOfficer))
    _graph.add((OPERATOR, RDF.type, PROV.Person))


reset()


def _obs_iri(s: dict) -> URIRef:
    return MOS[f"obs/{s['mmsi']}/{s['observed_at']}"]


def add_proposal(rec: dict) -> None:
    g, pid = _graph, rec["id"]
    prop, enc, assess = MOS[f"proposal/{pid}"], MOS[f"encounter/{pid}"], MOS[f"assessment/{pid}"]
    for s in rec["subjects"]:
        vessel, obs = MOS[f"vessel/{s['mmsi']}"], _obs_iri(s)
        g.add((vessel, RDF.type, MOS.Vessel))
        g.add((obs, RDF.type, SOSA.Observation))
        g.add((obs, SOSA.hasFeatureOfInterest, vessel))
        g.add((obs, SOSA.resultTime, Literal(s["observed_at"], datatype=XSD.dateTime)))
        g.add((obs, SOSA.hasSimpleResult, Literal(json.dumps(
            {"lat": s["lat"], "lng": s["lng"], "sog": s["sog"], "cog": s["cog"]}))))
        g.add((assess, PROV.used, obs))
        g.add((enc, MOS.involves, vessel))
    g.add((assess, RDF.type, MOS.RiskAssessment))
    g.add((assess, PROV.wasAssociatedWith, AGENT))
    g.add((enc, RDF.type, MOS.Encounter))
    g.add((enc, PROV.wasGeneratedBy, assess))
    g.add((enc, MOS.riskLevel, Literal(rec["trigger"]["risk_level"] or 0, datatype=XSD.integer)))
    g.add((prop, RDF.type, MOS.Proposal))
    g.add((prop, PROV.wasDerivedFrom, enc))
    g.add((prop, PROV.wasAttributedTo, AGENT))
    g.add((prop, PROV.generatedAtTime, Literal(rec["created_at"], datatype=XSD.dateTime)))
    g.add((prop, MOS.proposesAction, Literal(json.dumps(rec["actions"], ensure_ascii=False))))


def add_decision(rec: dict) -> None:
    if not rec.get("decision"):
        return
    g, pid = _graph, rec["id"]
    dec = MOS[f"decision/{pid}"]
    g.add((dec, RDF.type, MOS.Decision))
    g.add((dec, PROV.used, MOS[f"proposal/{pid}"]))
    g.add((dec, PROV.wasAssociatedWith, OPERATOR))
    g.add((dec, PROV.endedAtTime, Literal(rec["decision"]["at"], datatype=XSD.dateTime)))
    g.add((dec, MOS.outcome, Literal(rec["status"])))
    if rec["decision"].get("reason"):
        g.add((dec, MOS.reason, Literal(rec["decision"]["reason"])))


def subgraph(proposal_id: str) -> Graph:
    """제안 → 조우 → 평가 → 관측 → 선박, 그리고 이 제안을 참조한 결심만. 다른 제안으로는 안 건넌다."""
    g, out = _graph, Graph()
    out.bind("mos", MOS); out.bind("prov", PROV); out.bind("sosa", SOSA)
    prop = MOS[f"proposal/{proposal_id}"]
    nodes = [prop, MOS[f"encounter/{proposal_id}"], MOS[f"assessment/{proposal_id}"],
             MOS[f"decision/{proposal_id}"], AGENT, OPERATOR]
    nodes += list(g.objects(MOS[f"assessment/{proposal_id}"], PROV.used))          # observations
    nodes += list(g.objects(MOS[f"encounter/{proposal_id}"], MOS.involves))        # vessels
    for n in nodes:
        for triple in g.triples((n, None, None)):
            out.add(triple)
    return out


def serialize(proposal_id: str, fmt: str = "turtle") -> str:
    if fmt not in FORMATS:
        raise ValueError(f"unsupported format {fmt}")
    return subgraph(proposal_id).serialize(format=FORMATS[fmt])
