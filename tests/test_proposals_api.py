from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.routers import proposals
from backend.services import watch_officer as w
from tests.test_watch_officer import NOW, data


def test_approval_and_execution_api(tmp_path, monkeypatch):
    store=w.Store(tmp_path/'watch.sqlite3')
    risks,lookup=data(); store.refresh(risks,lookup,NOW)
    monkeypatch.setattr(w,'get_store',lambda:store)
    monkeypatch.setattr(w,'snapshot',lambda:(risks,lookup))
    monkeypatch.setattr(w.time,'time',lambda:NOW+1)
    app=FastAPI();app.include_router(proposals.router,prefix='/api/v1')
    client=TestClient(app)
    p=client.get('/api/v1/proposals').json()['proposals'][0]
    url='/api/v1/proposals/'+p['id']
    body={'outcome':'approved','reason':'집중 추적','client_id':'tab1'}
    r=client.post(url+'/decision',json=body)
    assert r.status_code==200 and r.json()['execute']
    assert not client.post(url+'/decision',json=body).json()['execute']
    eid=r.json()['proposal']['execution']['id']
    receipt={'execution_id':eid,'client_id':'tab1','outcome':'tracking'}
    assert client.post(url+'/execution',json=receipt).json()['status']=='tracking'
    receipt['client_id']='tab2'
    assert client.post(url+'/execution',json=receipt).status_code==409
    assert client.post(url+'/decision',json={'outcome':'approved'}).status_code==422
    assert client.post('/api/v1/proposals/missing/decision',json=body).status_code==404


def test_handoff_api_validates_operator_at_trust_boundary(tmp_path, monkeypatch):
    store=w.Store(tmp_path/'watch.sqlite3')
    risks,lookup=data(); store.refresh(risks,lookup,NOW)
    monkeypatch.setattr(w,'get_store',lambda:store)
    monkeypatch.setattr(w,'snapshot',lambda:(risks,lookup))
    monkeypatch.setattr(w.time,'time',lambda:NOW+1)
    app=FastAPI();app.include_router(proposals.router,prefix='/api/v1')
    client=TestClient(app)
    summary=client.get('/api/v1/proposals/handoff').json()
    assert len(summary['open'])==1 and summary['last_handoff'] is None
    # 공백만 있는 이름은 인계자로 인정하지 않는다.
    assert client.post('/api/v1/proposals/handoffs',json={'operator':'   ','client_id':'tab'}).status_code==422
    assert client.post('/api/v1/proposals/handoffs',json={'operator':'x'*41,'client_id':'tab'}).status_code==422
    r=client.post('/api/v1/proposals/handoffs',json={'operator':'  홍길동 ','note':' 주시 ','client_id':'tab'})
    assert r.status_code==200 and r.json()['operator']=='홍길동' and r.json()['note']=='주시'
    assert client.get('/api/v1/proposals/handoff').json()['last_handoff']['operator']=='홍길동'
