import copy
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.services import watch_officer as w, collision_scenarios as s, decision_followup as f
from backend.routers.proposals import router
from tests.test_watch_officer import data, NOW, PAIR


@pytest.fixture
def setup(tmp_path):
    store=w.Store(tmp_path/'watch.db')
    risks,lookup=data();store.refresh(risks,lookup,NOW);pid=store.list()[0]['id']
    snapshot=s.capture(list(PAIR),lookup(PAIR),NOW);snapshot['proposal_id']=pid
    run=s.compare(snapshot,PAIR[0],6,0,15)
    return store,risks,lookup,pid,run


def test_review_binding_idempotency_and_approval_evidence(setup):
    store,risks,lookup,pid,run=setup
    p=store.review_scenario(pid,run,'reference','주변 확인','tab','review1',NOW+1)
    assert p['status']=='open' and p['decision'] is None and p['execution'] is None
    assert len(store.review_scenario(pid,run,'reference','주변 확인','tab','review1',NOW+2)['scenario_reviews'])==1
    with pytest.raises(ValueError):store.review_scenario(pid,run,'rejected','주변 확인','tab','review1',NOW+2)
    wrong=copy.deepcopy(run);wrong['snapshot']['proposal_id']='other'
    with pytest.raises(ValueError):store.review_scenario(pid,wrong,'reference','이유','tab','review2',NOW+2)
    result=store.decide(pid,'approved','집중 추적','tab',risks,lookup,NOW+3)
    assert result['execute']
    assert result['proposal']['decision']['scenario_review_ids']==['review1']
    p=store.review_scenario(pid,run,'deferred','추가 확인','tab','review3',NOW+4)
    assert p['decision']['scenario_review_ids']==['review1']
    assert len(w.Store(store.path).list()[0]['scenario_reviews'])==2


def test_observations_deduplicate_and_never_treat_stale_as_safe(setup):
    store,risks,lookup,pid,run=setup
    store.review_scenario(pid,run,'reference','이유','tab','r1',NOW)
    store.refresh(risks,lookup,NOW+1);store.refresh(risks,lookup,NOW+2)
    result=store.followup(pid,NOW+2)
    assert result['state']=='fresh' and len(result['observations'])==1
    assert result['latest']['risk_state']=='high'
    store.refresh(risks,lookup,NOW+61)
    result=store.followup(pid,NOW+61)
    assert result['state']=='stale' and len(result['observations'])==1
    # Continue monitoring even if the proposal expired/finished; fresh AIS is independent of map receipts.
    for v in lookup(PAIR):v['_updated']=NOW+70
    lookup(PAIR)[1]['cog']=90
    store.refresh(risks,lookup,NOW+70)
    result=store.followup(pid,NOW+70)
    assert result['state']=='fresh' and result['latest']['risk_state']=='reduced'
    assert result['latest']['tcpa_min'] is None
    assert store.followup(pid,NOW+901)['state']=='ended'


def test_prediction_errors_use_each_reception_time_not_poll_time(setup):
    store,risks,lookup,pid,run=setup
    vs=copy.deepcopy(lookup(PAIR))
    for v in vs:
        predicted=run['scenarios']['baseline']['tracks'][str(v['mmsi'])]['points'][6]
        v.update(lat=predicted['lat'],lng=predicted['lng'],_updated=NOW+60)
    observed=f.observe(list(PAIR),vs,NOW+80,store.list()[0]['rule'])
    result=f.residuals(run,[observed,observed])
    for points in result['tracks'].values():
        assert len(points)==1
        assert points[0]['t_s']==60
        assert points[0]['errors_nm']['baseline']==pytest.approx(0,abs=1e-8)
    assert result['tracks'][str(PAIR[0])][0]['errors_nm']['alternative']>.1


def test_followup_api_missing_run_and_review_validation(setup,tmp_path,monkeypatch):
    store,risks,lookup,pid,run=setup
    monkeypatch.setattr(w,'get_store',lambda:store)
    monkeypatch.setattr(w,'snapshot',lambda:(risks,lookup))
    monkeypatch.setattr(w.time,'time',lambda:NOW+1)
    monkeypatch.setattr(s.config,'SCENARIO_DB',str(tmp_path/'scenarios.db'))
    s.Repository().save('run',run)
    app=FastAPI();app.include_router(router,prefix='/api/v1');client=TestClient(app)
    path='/api/v1/proposals/'+pid
    body={'run_id':run['id'],'review_id':'r','outcome':'reference','reason':'추가 확인','client_id':'test'}
    assert client.post(path+'/scenario-reviews',json=body).status_code==200
    body['reason']=' '
    assert client.post(path+'/scenario-reviews',json=body).status_code==409
    result=client.get(path+'/followup',params={'run_id':run['id']})
    assert result.status_code==200 and 'prediction_comparison' in result.json()
    assert client.get(path+'/followup',params={'run_id':'missing'}).status_code==404
