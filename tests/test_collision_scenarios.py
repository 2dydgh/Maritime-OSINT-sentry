import copy
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.services import collision_scenarios as s
from backend.routers.collision_scenarios import router

NOW=1800000000
A,B,C=111111111,222222222,333333333

def vessels():
    return [dict(mmsi=A,name='A',lat=0,lng=0,sog=12,cog=90,_updated=NOW),
            dict(mmsi=B,name='B',lat=0,lng=2/60,sog=12,cog=270,_updated=NOW),
            dict(mmsi=C,name='C',lat=1/60,lng=0,sog=0,cog=0,_updated=NOW)]

def test_same_initial_conditions_and_neighbor_tradeoff():
    snap=s.capture([A,B],vessels(),NOW);before=copy.deepcopy(snap)
    run=s.compare(snap,A,12,0,15)
    base,alt=run['scenarios'].values()
    assert base['pair']['closest_distance_nm']==pytest.approx(0,abs=1e-8)
    assert base['pair']['closest_time_s']==pytest.approx(300)
    assert alt['pair']['closest_distance_nm']>1
    # Turning north separates selected pair but brings A into stationary C.
    assert alt['nearby'][0]['other']==C
    assert alt['nearby'][0]['distance_nm']==pytest.approx(0,abs=1e-8)
    assert snap==before
    for m in [A,B,C]:
        assert base['tracks'][str(m)]['points'][0]==alt['tracks'][str(m)]['points'][0]
    assert base['tracks'][str(B)]==alt['tracks'][str(B)]
    assert base['tracks'][str(C)]==alt['tracks'][str(C)]
    same=s.compare(snap,A,12,90,15)['scenarios']
    assert same['baseline']==same['alternative']

def test_cpa_time_bounds_and_parallel():
    origin={'lat':0,'lng':0}
    a=dict(x_nm=0,y_nm=0,sog=12,cog=90)
    b=dict(x_nm=10,y_nm=0,sog=0,cog=0)
    p=s.closest(a,b,300,origin)
    assert not p['within_horizon']
    assert p['closest_distance_nm']==pytest.approx(9)
    assert p['tcpa_min']==pytest.approx(50)
    b['x_nm']=-1
    assert s.closest(a,b,300,origin)['closest_time_s']==0
    b.update(sog=12,cog=90)
    assert s.closest(a,b,300,origin)['tcpa_min'] is None

def test_freshness_and_coverage():
    vs=vessels();vs[0]['_updated']=NOW-61
    with pytest.raises(ValueError):s.capture([A,B],vs,NOW)
    vs=vessels();vs[2]['_updated']=NOW-61
    snap=s.capture([A,B],vs,NOW)
    assert snap['coverage']['stale_or_invalid']==1
    assert snap['coverage']['assessment']=='partial'
    vs=vessels();vs[0]['_updated']=NOW-30
    snap=s.capture([A,B],vs,NOW)
    assert snap['ships'][0]['x_nm']==pytest.approx(.1)
    with pytest.raises(ValueError):s.capture([A,A],vs,NOW)

@pytest.mark.parametrize('speed,course',[(float('nan'),90),(51,90),(12,360),(-1,90)])
def test_invalid_changes(speed,course):
    with pytest.raises(ValueError):s.compare(s.capture([A,B],vessels(),NOW),A,speed,course,15)

def test_saved_api_replays_without_live_data(tmp_path,monkeypatch):
    monkeypatch.setattr(s.config,'SCENARIO_DB',str(tmp_path/'scenarios.db'))
    original=s.capture
    monkeypatch.setattr(s,'capture',lambda pair:original(pair,vessels(),NOW))
    app=FastAPI();app.include_router(router,prefix='/api/v1')
    client=TestClient(app)
    prefix='/api/v1/collision/scenarios'
    snap=client.post(prefix+'/snapshots',json={'mmsi_a':A,'mmsi_b':B}).json()
    monkeypatch.setattr(s,'capture',lambda _:pytest.fail('must not recapture'))
    response=client.post(prefix+'/runs',json={'snapshot_id':snap['id'],'target':A,'speed':12,'course':0,'minutes':15})
    assert response.status_code==200
    run=response.json()
    assert client.get(prefix+'/runs/'+run['id']).json()==run
    # 목록은 시각만으로 고를 수 없어 선박 쌍과 변경 대상을 함께 싣는다.
    # 1MB 넘는 body 를 파이썬으로 파싱하지 않고 SQLite json_extract 로 뽑아온다.
    listed=client.get(prefix+'/runs').json()['runs'][0]
    assert listed['id']==run['id']
    assert listed['ships']==['A','B']
    assert listed['changed']=='A'          # target=A 로 돌린 비교
    assert client.get(prefix+'/runs/missing').status_code==404
    assert client.post(prefix+'/runs',json={'snapshot_id':snap['id'],'target':C,'speed':12,'course':0}).status_code==422


def test_ramped_speed_distance_and_course_wrap():
    from backend.services.scenario_maneuver import path
    ship=dict(mmsi=A,x_nm=0,y_nm=0,sog=12,cog=0)
    points=path(ship,0,0,0,60,60,{'lat':0,'lng':0})
    assert points[-1]['y_nm']==pytest.approx(.1)  # mean 6 kt over 1 minute
    assert points[0]['sog']==12 and points[-1]['sog']==0
    ship['cog']=350
    points=path(ship,12,10,60,0,60,{'lat':0,'lng':0})
    assert points[30]['cog']==pytest.approx(0)
    assert points[-1]['cog']==pytest.approx(10)


def test_maneuver_keeps_baseline_and_frozen_inputs():
    snap=s.capture([A,B],vessels(),NOW);before=copy.deepcopy(snap)
    instant=s.compare(snap,A,0,0,15)
    ramp=s.compare(snap,A,0,0,15,60,120)
    assert ramp['model']=='ramped-motion-local-plane-v1'
    assert ramp['scenarios']['baseline']==instant['scenarios']['baseline']
    assert ramp['scenarios']['alternative']['tracks'][str(B)]==instant['scenarios']['alternative']['tracks'][str(B)]
    assert snap==before
    assert ramp['scenarios']['alternative']['tracks'][str(A)]['points'][0]['sog']==12
    assert ramp['scenarios']['alternative']['pair']['metric_method']=='piecewise-linear-1s'
    assert ramp['scenarios']['alternative']['pair']['tcpa_min'] is None
    assert len(ramp['scenarios']['alternative']['tracks'][str(A)]['points'])==91
