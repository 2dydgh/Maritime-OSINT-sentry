
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pyshacl import validate
from rdflib import RDF, XSD, Graph, Literal

from backend.ontology.evidence import Evidence, M, definition, load
from backend.routers.knowledge import router
from backend.services import collision_scenarios as s
from backend.services import watch_officer as w
from tests.test_watch_officer import NOW, PAIR, data


@pytest.fixture
def saved(tmp_path):
    store=w.Store(tmp_path/'watch.db');repo=s.Repository(tmp_path/'scenarios.db')
    risks,lookup=data()
    # Production trigger inputs usually lack reception times.
    for risk in risks['distance']:
        risk['ship_a']=dict(risk['ship_a']);risk['ship_a'].pop('_updated')
        risk['ship_b']=dict(risk['ship_b']);risk['ship_b'].pop('_updated')
    store.refresh(risks,lookup,NOW);pid=store.list()[0]['id']
    snap=s.capture(list(PAIR),lookup(PAIR),NOW);snap['proposal_id']=pid
    first=s.compare(snap,PAIR[0],6,0,15,60,120);repo.save('run',first)
    store.review_scenario(pid,first,'reference','거리와 주변 영향 검토','tab','before',NOW+1)
    p=store.decide(pid,'approved','추가 확인 필요','tab',risks,lookup,NOW+2)['proposal']
    store.receipt(pid,p['execution']['id'],'tab','tracking','map_tracking_started',NOW+3)
    second=s.compare(snap,PAIR[0],8,10,15);repo.save('run',second)
    store.review_scenario(pid,second,'deferred','승인 후 추가 검토','tab','after',NOW+4)
    for offset in (5,10):
        for vessel in lookup(PAIR):vessel['_updated']=NOW+offset
        risks['updated_at']=NOW+offset
        store.refresh(risks,lookup,NOW+offset)
    return store,repo,pid,first,second


def bundle(saved):
    store,repo,pid,_,_=saved
    return load(pid,store.path,repo.path)


def test_definitions_are_owl_and_shapes_are_valid():
    from rdflib.namespace import OWL
    schema=definition('maritime.ttl')
    assert (M.Prediction,RDF.type,OWL.Class) in schema
    assert (M.usesReview,RDF.type,OWL.ObjectProperty) in schema
    assert validate(Graph(),shacl_graph=definition('shapes.ttl'),meta_shacl=True)[0]


def test_real_mapping_queries_and_time_frozen_basis(saved):
    view=Evidence(bundle(saved),NOW+11)
    assert view.validation()['conforms']
    answer=view.answer('why')
    text=' '.join(c['text'] for c in answer['claims'])
    assert '추가 확인 필요' in text and '영수증이 있습니다' in text
    decision=view.g.value(view.root,M.hasDecision)
    reviews=list(view.g.objects(decision,M.usesReview))
    assert len(reviews)==1
    assert str(view.g.value(reviews[0],M.reason))=='거리와 주변 영향 검토'
    basis=view.answer('basis')
    after_review=next(n for n in basis['graph']['nodes'] if n['type']=='Review' and any(p['value']=='승인 후 추가 검토' for p in n['properties']))
    assert not after_review['relevant']
    assert '수신 시각' in ' '.join(view.gaps)
    assert len(list(view.g.subjects(RDF.type,M.AnalysisInputState)))==2
    for node in view.g.subjects(RDF.type,M.Prediction):
        assert (node,RDF.type,M.AISObservation) not in view.g
    for node in view.g.subjects(RDF.type,M.AISObservation):
        assert view.g.value(node,M.receivedAt) is not None
    assert Graph().parse(data=view.to_turtle(),format='turtle').isomorphic(view.g)


def test_receipt_only_from_execution_event_not_review_status(saved):
    raw=bundle(saved)
    raw['proposal']['events']=[e for e in raw['proposal']['events'] if e.get('kind')!='execution_receipt' and e.get('reason')!='map_tracking_started']
    assert any(e['status']=='tracking' for e in raw['proposal']['events'])
    text=' '.join(c['text'] for c in Evidence(raw,NOW+11).answer('why')['claims'])
    assert '확인 가능한 지도 추적 시작 영수증은 없습니다' in text


def test_missing_and_cross_proposal_links_abstain(saved):
    raw=bundle(saved);raw['runs'].pop(saved[3]['id'])
    result=Evidence(raw,NOW+11).answer('basis')
    assert not result['validation']['conforms']
    assert '결론을 제공하지 않습니다' in result['claims'][0]['text']
    raw=bundle(saved);raw['runs'][saved[3]['id']]['snapshot']['proposal_id']='other'
    assert not Evidence(raw,NOW+11).validation()['conforms']
    raw=bundle(saved);raw['proposal']['decision']['scenario_review_ids']=['missing']
    assert not Evidence(raw,NOW+11).validation()['conforms']


def test_future_review_invalid_and_missing_legacy_list_not_inferred(saved):
    raw=bundle(saved);raw['proposal']['decision']['scenario_review_ids'].append('after')
    assert not Evidence(raw,NOW+11).validation()['conforms']
    raw=bundle(saved);raw['proposal']['decision'].pop('scenario_review_ids')
    view=Evidence(raw,NOW+11)
    assert view.validation()['conforms']
    assert not list(view.g.objects(view.g.value(view.root,M.hasDecision),M.usesReview))
    assert any('현재 검토 목록으로 대체하지 않았습니다' in gap for gap in view.gaps)


def test_followup_fresh_stale_ended_and_no_judgment(saved):
    raw=bundle(saved)
    fresh=Evidence(raw,NOW+11).answer('after')
    assert '최근 유효한 수신' in ' '.join(c['text'] for c in fresh['claims'])
    stale=Evidence(raw,NOW+80).answer('after')
    assert '현재 위험 변화는 판단할 수 없습니다' in ' '.join(c['text'] for c in stale['claims'])
    ended=Evidence(raw,NOW+1900).answer('after')
    assert '과거 수신' in ' '.join(c['text'] for c in ended['claims'])
    raw['proposal']['decision']=None;raw['proposal']['execution']=None
    assert '판단 전후의 변화를 설명할 수 없습니다' in Evidence(raw,NOW+11).answer('after')['claims'][0]['text']


def test_shacl_rejects_bad_observation_and_prediction_confusion(saved):
    view=Evidence(bundle(saved),NOW+11)
    obs=next(view.g.subjects(RDF.type,M.AISObservation))
    view.g.set((obs,M.latitude,Literal(999.,datatype=XSD.double)))
    assert not view.validation()['conforms']
    view=Evidence(bundle(saved),NOW+11)
    prediction=next(view.g.subjects(RDF.type,M.Prediction))
    view.g.add((prediction,RDF.type,M.AISObservation))
    assert not view.validation()['conforms']


def test_read_only_api_source_fingerprint_and_no_arbitrary_queries(saved,monkeypatch):
    store,repo,pid,_,_=saved
    monkeypatch.setattr(s.config,'WATCH_DB',str(store.path));monkeypatch.setattr(s.config,'SCENARIO_DB',str(repo.path))
    app=FastAPI();app.include_router(router,prefix='/api/v1');client=TestClient(app)
    before=store.path.read_bytes(),repo.path.read_bytes()
    root='/api/v1/knowledge/proposals/'+pid
    result=client.get(root,params={'question':'why'}).json()
    assert result['validation']['conforms']
    node=next(n for n in result['graph']['nodes'] if n['type']=='Decision')
    original=client.get(node['source_url']).json()
    assert original['record']==bundle(saved)['proposal']['decision']
    assert client.get(node['source_url'].split('&fingerprint=')[0]+'&fingerprint='+'0'*24).status_code==409
    assert client.get(root,params={'question':'SELECT ?s WHERE {?s ?p ?o}'}).status_code==422
    assert client.get(root+'/source',params={'node':'file:///etc/passwd'}).status_code==409
    assert client.get('/api/v1/knowledge/proposals/missing').status_code==404
    assert client.get(root+'/graph.ttl').headers['content-type'].startswith('text/turtle')
    assert Graph().parse(data=client.get('/api/v1/knowledge/schema.ttl').text,format='turtle')
    assert before==(store.path.read_bytes(),repo.path.read_bytes())
