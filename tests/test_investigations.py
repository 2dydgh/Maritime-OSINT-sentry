import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel

from backend.ontology.evidence import Evidence, M, load
from backend.routers import investigations, proposals
from backend.services import collision_scenarios as s
from backend.services import investigation_agent as a
from backend.services import watch_officer as w
from backend.services.investigation_store import Repository
from tests.test_watch_officer import PAIR, data


@pytest.fixture
def investigation(tmp_path, monkeypatch):
    risks, lookup = data()
    now = time.time()-1
    for v in lookup(PAIR):
        v['_updated'] = now
    risks['updated_at'] = now
    risks['distance'][0]['ts'] = w.iso(now)
    store = w.Store(tmp_path/'watch.db')
    store.refresh(risks, lookup, now+0.1)
    pid = store.list()[0]['id']
    repo = Repository(store)
    r, _ = repo.create(pid, 180, 'test')
    ctx = a.Investigation(repo, r['id'], s.Repository(tmp_path/'scenarios.db'))
    monkeypatch.setattr(w, 'snapshot', lambda:(risks,lookup))
    monkeypatch.setattr(w, 'get_store', lambda:store)
    return ctx, risks, lookup


def draft(ctx, action='focus_tracking', reason='risk_persists'):
    current, graph = ctx.inspect(), ctx.knowledge()
    return a.Recommendation(action=action, reason=reason, evidence_ids=[current['id'], graph['id']])


def test_exact_evidence_and_server_numbers(investigation):
    ctx, _, _ = investigation
    result = ctx.validate(draft(ctx))
    assert result['validation']['passed']
    # Fixture's trigger says .1nm, but new server computation is almost zero.
    assert result['facts']['data']['approval_check']['dcpa_nm'] < .01
    assert result['action']=='focus_tracking'
    assert ctx.proposal()['status']=='open'  # investigation never approves


@pytest.mark.parametrize('case', ['unknown','duplicate','other_pair','other_proposal','missing_graph'])
def test_forged_or_missing_evidence_is_rejected(investigation, case):
    ctx, _, _ = investigation
    d = draft(ctx)
    r = ctx.record
    if case=='unknown':d.evidence_ids[0]='invented'
    elif case=='duplicate':d.evidence_ids[1]=d.evidence_ids[0]
    elif case=='missing_graph':d.evidence_ids[1]=ctx.inspect()['id']
    else:
        e = r['evidence'][d.evidence_ids[0]]
        if case=='other_pair':e['pair']=[111111111,222222222]
        else:e['proposal_id']='another-incident'
        ctx.repo.update(ctx.rid,evidence=r['evidence'])
    with pytest.raises(ValueError):ctx.validate(d)


@pytest.mark.parametrize('case,action,reason', [
    ('stale','check_observations','data_insufficient'),
    ('missing','check_observations','data_insufficient'),
    ('tracking','continue_monitoring','already_active'),
    ('changed','no_new_action','criteria_not_met'),
    ('closed','operator_review','record_needs_review'),
])
def test_state_changes_require_different_recommendations(investigation, case, action, reason):
    ctx, _risks, lookup = investigation
    if case=='stale':lookup(PAIR)[0]['_updated']-=120
    elif case=='missing':lookup(PAIR).clear()
    elif case=='changed':lookup(PAIR)[1]['cog']=90
    else:
        p=ctx.proposal()
        with ctx.repo.store.transaction() as db:
            ctx.repo.store.transition(db,p,'tracking' if case=='tracking' else 'completed','test',time.time())
    result=ctx.validate(draft(ctx,action,reason))
    assert result['action']==action
    with pytest.raises(ValueError):ctx.validate(draft(ctx))


def test_old_inspection_or_mid_run_change_cannot_pass(investigation):
    ctx, _, lookup = investigation
    d=draft(ctx)
    r=ctx.record;r['evidence'][d.evidence_ids[0]]['data']['checked_at']-=61
    ctx.repo.update(ctx.rid,evidence=r['evidence'])
    with pytest.raises(ValueError,match='오래'):ctx.validate(d)
    d=draft(ctx);lookup(PAIR)[1]['cog']=90
    with pytest.raises(ValueError,match='변경'):ctx.validate(d)


def test_invalid_graph_blocks_tracking(investigation):
    ctx, _, _ = investigation
    p=ctx.proposal()
    with ctx.repo.store.transaction() as db:
        p['pair']=[PAIR[0],PAIR[0]]
        # Deliberately malformed RDF source, leaving valid tool target unchanged.
        p['trigger']['subjects'][0]['mmsi']='invalid'
        p['pair']=list(PAIR)
        ctx.repo.store.save(db,p,time.time())
    assert not ctx.knowledge()['data']['validation']['conforms']
    with pytest.raises(ValueError):ctx.validate(draft(ctx))
    assert ctx.validate(draft(ctx,'operator_review','record_needs_review'))['validation']['passed']


def test_comparison_bounds_and_immutable_replay(investigation, monkeypatch):
    ctx, _, lookup = investigation
    original=s.capture
    monkeypatch.setattr(s,'capture',lambda pair:original(pair,lookup(pair)))
    for change in ('slower','starboard'):
        record=ctx.compare('first',change)
        run=ctx.scenario_repo.get('run',record['data']['run_id'])
        assert run['snapshot']['proposal_id']==ctx.record['proposal_id']
        assert run['snapshot']['coverage']['assessment']=='partial'
    assert not ctx.compare('second','port')['data']['available']
    assert not ctx.proposal().get('scenario_reviews')  # AI comparisons are not operator reviews.


def test_duplicate_start_cancel_and_restart_recovery(investigation):
    ctx, _, _ = investigation
    pid=ctx.record['proposal_id']
    with ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(lambda _:ctx.repo.create(pid,180,'test'),range(3)))
    assert all(r['id']==ctx.rid and not created for r,created in results)
    ctx.repo.update(ctx.rid,status='cancelled')
    assert ctx.repo.update(ctx.rid,status='completed')['status']=='cancelled'
    r,created=ctx.repo.create(pid,180,'test');assert created
    ctx.repo.update(r['id'],owner_pid=99999999)
    assert Repository(ctx.repo.store).get(r['id'])['status']=='interrupted'


def test_approval_revalidates_and_freezes_investigation(investigation):
    ctx, risks, lookup = investigation
    result=ctx.validate(draft(ctx));ctx.repo.update(ctx.rid,status='completed',result=result)
    pid=ctx.record['proposal_id']
    approved=ctx.repo.store.decide(pid,'approved','근거 확인','tab',risks,lookup,investigation_id=ctx.rid)
    assert approved['execute']
    assert approved['proposal']['decision']['investigation']['id']==ctx.rid
    graph=Evidence(load(pid,ctx.repo.store.path,ctx.scenario_repo.path))
    assert graph.validation()['conforms']
    assert list(graph.g.triples((None,M.usesInvestigation,None)))
    assert any(n['type']=='AgentInvestigation' and n['relevant'] for n in graph.answer('basis')['graph']['nodes'])
    again=ctx.repo.store.decide(pid,'approved','retry','tab',risks,lookup,investigation_id=ctx.rid)
    assert not again['execute']


@pytest.mark.parametrize('case',['expired','changed','unknown'])
def test_approval_rejects_expired_or_changed_result(investigation,case):
    ctx, risks, lookup = investigation
    result=ctx.validate(draft(ctx))
    if case=='expired':result['validated_at']-=61
    ctx.repo.update(ctx.rid,status='completed',result=result)
    if case=='changed':lookup(PAIR)[1]['cog']=90
    if case=='changed':
        result=ctx.repo.store.decide(ctx.record['proposal_id'],'approved','test','tab',risks,lookup,investigation_id=ctx.rid)
        assert not result['execute']
    else:
        with pytest.raises(ValueError):ctx.repo.store.decide(ctx.record['proposal_id'],'approved','test','tab',risks,lookup,investigation_id='missing' if case=='unknown' else ctx.rid)


def function_model(action='focus_tracking', reason='risk_persists', extra=False):
    async def respond(messages, info):
        returns=[p for m in messages for p in m.parts if isinstance(p,ToolReturnPart)]
        names={p.tool_name for p in returns}
        if 'inspect_current' not in names:return ModelResponse(parts=[ToolCallPart('inspect_current',{})])
        if extra and 'recalculate_cpa' not in names:return ModelResponse(parts=[ToolCallPart('recalculate_cpa',{})])
        if 'query_knowledge' not in names:return ModelResponse(parts=[ToolCallPart('query_knowledge',{})])
        ids=[p.content['id'] for p in returns if p.tool_name in ('inspect_current','query_knowledge')]
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name,dict(action=action,reason=reason,evidence_ids=ids))])
    return FunctionModel(respond)


@pytest.mark.asyncio
@pytest.mark.parametrize('extra',[False,True])
async def test_pydantic_tool_loop_records_actual_selected_tools(investigation,extra):
    ctx, _, _=investigation
    await a.execute(ctx,function_model(extra=extra))
    r=ctx.record
    assert r['status']=='completed',r
    names=[e['tool'] for e in r['events']]
    assert ('recalculate_cpa' in names)==extra
    # 루프 안 관문 + 발행 재확인 = 검증 2회, 통과 기록은 1줄. 화면의 '실행한 확인 작업'에
    # 같은 항목이 두 번 찍히지 않아야 하고, 결과가 인용하는 근거가 바로 그 한 줄이어야 한다.
    passes=[e for e in r['events'] if e['tool']=='validate_result']
    assert len(passes)==1, names
    assert r['result']['facts']['id']==passes[0]['evidence_id']
    assert r['result']['validation']['passed']
    assert ctx.proposal()['status']=='open'


@pytest.mark.asyncio
async def test_wrong_output_exhausts_retries_without_approval(investigation):
    ctx, _, _=investigation
    await a.execute(ctx,function_model('no_new_action','criteria_not_met'))
    assert ctx.record['status']=='failed'
    assert ctx.record['result'] is None and ctx.proposal()['status']=='open'


@pytest.mark.asyncio
@pytest.mark.parametrize('cancel',[False,True])
async def test_timeout_and_cancel_stop_model(investigation,cancel):
    ctx, _, _=investigation
    if not cancel:ctx.repo.update(ctx.rid,deadline=time.time()+.1)
    async def slow(messages,info):await asyncio.sleep(60)
    task=asyncio.create_task(a.execute(ctx,FunctionModel(slow)))
    if cancel:
        await asyncio.sleep(.1);ctx.repo.update(ctx.rid,status='cancelled')
    await asyncio.wait_for(task,3)
    assert ctx.record['status']==('cancelled' if cancel else 'timed_out')


def test_api_scopes_start_history_cancel_and_unknown(investigation,monkeypatch):
    ctx, _, _=investigation
    monkeypatch.setattr(a,'launch',lambda *args:None)
    app=FastAPI();app.include_router(investigations.router);app.include_router(proposals.router)
    with TestClient(app) as client:
        pid=ctx.record['proposal_id']
        assert client.post('/investigations/proposals/'+pid).json()['id']==ctx.rid
        assert len(client.get('/investigations/proposals/'+pid).json()['investigations'])==1
        assert client.get('/investigations/unknown').status_code==404
        assert client.post('/investigations/proposals/unknown').status_code==404
        assert client.post('/investigations/'+ctx.rid+'/cancel').json()['status']=='cancelled'
        assert client.post('/proposals/'+pid+'/decision',json=dict(outcome='approved',reason='test',client_id='tab',investigation_id=ctx.rid)).status_code==409


def test_backup_checks_ai_comparison_references(investigation,tmp_path):
    from backend.data_platform.operations import backup
    ctx, _, _=investigation
    ctx.repo.event(ctx.rid,'compare_scenario','completed',{'run_id':'missing-run'})
    with pytest.raises(RuntimeError,match='unresolved scenario'):
        backup(tmp_path/'backup',{'watch':ctx.repo.store.path})


@pytest.mark.asyncio
async def test_unbounded_model_tool_loop_is_stopped(investigation):
    ctx, _, _=investigation
    async def loop(messages,info):
        return ModelResponse(parts=[ToolCallPart('inspect_current',{})])
    await a.execute(ctx,FunctionModel(loop))
    assert ctx.record['status']=='failed'
    assert ctx.record['error_type']=='UsageLimitExceeded'
    assert ctx.record['result'] is None


@pytest.mark.asyncio
async def test_model_unavailable_fails_without_fabricated_result(investigation):
    ctx, _, _=investigation
    async def unavailable(messages,info):
        raise ConnectionError('unavailable')
    await a.execute(ctx,FunctionModel(unavailable))
    assert ctx.record['status']=='failed' and ctx.record['result'] is None
    assert ctx.proposal()['status']=='open'


def test_reopened_result_reflects_case_decision_without_rewriting_evidence(investigation):
    ctx, risks, lookup = investigation
    result=ctx.validate(draft(ctx));ctx.repo.update(ctx.rid,status='completed',result=result)
    original=ctx.record
    before=ctx.repo.view(original)
    assert before['case']['can_approve'] and before['case']['can_dismiss']
    assert before['case']['names']==['A','B']
    ctx.repo.store.decide(original['proposal_id'],'approved','조사 근거 확인','tab',risks,lookup,investigation_id=ctx.rid)
    after=ctx.repo.view(ctx.record)
    assert after['case']['status']=='approved'
    assert not after['case']['can_approve'] and not after['case']['can_dismiss']
    assert after['case']['decision_investigation_id']==ctx.rid
    assert ctx.record==original  # Current UI state does not rewrite the investigation.


def test_expired_investigation_can_be_dismissed_but_not_approved(investigation):
    ctx, risks, lookup = investigation
    result=ctx.validate(draft(ctx));result['validated_at']-=61
    ctx.repo.update(ctx.rid,status='completed',result=result)
    record=ctx.repo.view(ctx.record)
    assert record['case']['approval_expired']
    assert not record['case']['can_approve'] and record['case']['can_dismiss']
    decision=ctx.repo.store.decide(record['proposal_id'],'dismissed','과거 근거를 검토하고 기각','tab',risks,lookup,investigation_id=ctx.rid)
    assert not decision['execute'] and decision['proposal']['status']=='dismissed'
    assert decision['proposal']['decision']['investigation']['id']==ctx.rid


def test_api_view_never_offers_approval_of_closed_proposal(investigation):
    ctx, risks, lookup = investigation
    result=ctx.validate(draft(ctx));ctx.repo.update(ctx.rid,status='completed',result=result)
    pid=ctx.record['proposal_id']
    ctx.repo.store.decide(pid,'dismissed','관망','tab',risks,lookup)
    app=FastAPI();app.include_router(investigations.router)
    with TestClient(app) as client:
        r=client.get('/investigations/'+ctx.rid).json()
        assert r['case']['status']=='dismissed' and not r['case']['can_approve']
        assert r['case']['decision_investigation_id'] is None
        assert client.get('/investigations/proposals/'+pid).json()['investigations'][0]['case']==r['case']


def test_changed_stale_reason_and_expiry_do_not_restart_same_recommendation(investigation):
    ctx, risks, lookup=investigation
    risks['updated_at']=time.time()-120
    d=draft(ctx,'check_observations','data_insufficient')
    p=ctx.proposal()
    with ctx.repo.store.transaction() as db:
        ctx.repo.store.transition(db,p,'expired','analysis_stale',time.time())
    risks['updated_at']=time.time()-1
    risks['distance'][0]['ts']=w.iso(time.time()-1)
    lookup(PAIR)[0]['_updated']=time.time()-120
    record=ctx.record
    record['evidence'][d.evidence_ids[0]]['data']['checked_at']-=70
    ctx.repo.update(ctx.rid,evidence=record['evidence'])
    result=ctx.validate(d)
    assert result['action']=='check_observations'
    assert result['facts']['data']['error']=='vessel_stale'
    assert result['facts']['data']['proposal_status']=='expired'
    with pytest.raises(ValueError):ctx.validate(a.Recommendation(action='focus_tracking',reason='risk_persists',evidence_ids=d.evidence_ids))


@pytest.mark.asyncio
async def test_confirmed_data_gap_leaves_only_final_output_tool(investigation):
    ctx, risks, lookup=investigation
    lookup(PAIR)[0]['_updated']=time.time()-120
    seen=[]
    async def respond(messages,info):
        returns=[p for m in messages for p in m.parts if isinstance(p,ToolReturnPart)]
        seen.append([t.name for t in info.function_tools])
        if not returns:return ModelResponse(parts=[ToolCallPart('inspect_current',{})])
        if len(returns)==1:return ModelResponse(parts=[ToolCallPart('query_knowledge',{})])
        assert not info.function_tools
        # Data state changes inside the same conservative action class.
        risks['updated_at']=time.time()-120
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name,dict(action='check_observations',reason='data_insufficient',evidence_ids=[r.content['id'] for r in returns]))])
    await a.execute(ctx,FunctionModel(respond))
    assert ctx.record['status']=='completed'
    assert len([e for e in ctx.record['events'] if e['state']=='started'])==2
    assert seen[-1]==[]


def test_actual_action_change_supplies_fresh_evidence_for_correction(investigation):
    ctx, _risks, lookup=investigation
    d=draft(ctx)
    lookup(PAIR)[0]['_updated']=time.time()-120
    with pytest.raises(ValueError,match='변경'):ctx.validate(d)
    ready=ctx.ready()
    assert ready['action']=='check_observations'
    assert ready['evidence_ids'][0]!=d.evidence_ids[0]
    assert ctx.validate(a.Recommendation(**ready))['action']=='check_observations'


def test_legacy_failure_explained_without_rewriting_record(investigation):
    ctx, _, _=investigation
    original=ctx.repo.update(ctx.rid,status='failed',message='old generic failure',error_type='UsageLimitExceeded')
    assert '한도' in ctx.repo.view(original)['message']
    assert ctx.record['message']=='old generic failure'


def test_validation_pass_is_recorded_once_at_publication(investigation):
    """운영 기록에서 '근거·조치 조건 재확인' 이 9ms 간격으로 두 번 찍혔다. 루프 안 관문과
    발행 시점 재확인이 둘 다 통과 이벤트를 남겼기 때문이다. 재확인 자체는 두 번 하되
    기록은 발행 시점 한 번만 남아야 한다."""
    ctx, _, _ = investigation
    d = draft(ctx)
    count = lambda: sum(1 for e in ctx.repo.get(ctx.rid)['events'] if e['tool'] == 'validate_result')

    gate = ctx.validate(d, record=False)      # 에이전트 루프 안 관문
    assert gate['action'] == 'focus_tracking'
    assert count() == 0, '루프 안 관문은 통과 기록을 남기지 않는다'

    published = ctx.validate(d)               # 발행 시점 최종 재확인
    assert count() == 1
    assert published['facts']['id'], '발행 결과는 인용 가능한 근거 ID 를 가져야 한다'
