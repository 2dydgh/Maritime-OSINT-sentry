"""Read proposals, authorize map tracking, and receive browser acknowledgements."""
from typing import Annotated, Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from backend import config
from backend.services import watch_officer, collision_scenarios, decision_followup

router = APIRouter(prefix='/proposals', tags=['decision-support'])


class Decision(BaseModel):
    outcome: Literal['approved','dismissed']
    reason: str = Field(min_length=1, max_length=500)
    client_id: str = Field(min_length=1, max_length=100)
    investigation_id: str | None = Field(default=None, min_length=1, max_length=100)


class Receipt(BaseModel):
    execution_id: str = Field(min_length=1, max_length=100)
    client_id: str = Field(min_length=1, max_length=100)
    outcome: Literal['tracking','failed','completed']
    reason: str = Field(default='', max_length=500)


class Handoff(BaseModel):
    # 인증이 없어 이름은 자기 기재 값이다. 화면에도 그렇게 표시한다.
    operator: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ''
    client_id: str = Field(min_length=1, max_length=100)


@router.get('/handoff')
def handoff_summary():
    """지난 인계 이후의 판단과, 지금 넘겨받는 열린·추적 중 사건."""
    watch_officer.on_collision_update()
    return watch_officer.get_store().handoff_summary()


@router.post('/handoffs')
def record_handoff(body: Handoff):
    return watch_officer.get_store().record_handoff(body.operator, body.note, body.client_id)


@router.get('')
def list_proposals(limit: int = Query(100, ge=1, le=500)):
    watch_officer.on_collision_update()
    # 담당 해역을 함께 내려 화면이 '왜 이 사건들만 보이는지' 말할 수 있게 한다.
    return {'proposals': watch_officer.get_store().list(limit), 'aor': config.WATCH_AOR_BOX}


@router.post('/{pid}/decision')
def decide(pid: str, body: Decision):
    try:
        risks, lookup = watch_officer.snapshot()
        return watch_officer.get_store().decide(pid, body.outcome, body.reason, body.client_id, risks, lookup, investigation_id=body.investigation_id)
    except KeyError:
        raise HTTPException(404, 'proposal not found')
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.post('/{pid}/execution')
def receipt(pid: str, body: Receipt):
    try:
        return watch_officer.get_store().receipt(pid, **body.model_dump())
    except KeyError:
        raise HTTPException(404, 'proposal not found')
    except ValueError as exc:
        raise HTTPException(409, str(exc))


class ScenarioReview(BaseModel):
    run_id: str = Field(min_length=1, max_length=100)
    review_id: str = Field(min_length=1, max_length=100)
    outcome: Literal['reference', 'deferred', 'rejected']
    reason: str = Field(min_length=1, max_length=500)
    client_id: str = Field(min_length=1, max_length=100)


@router.post('/{pid}/scenario-reviews')
def review(pid: str, body: ScenarioReview):
    try:
        run = collision_scenarios.Repository().get('run', body.run_id)
        return watch_officer.get_store().review_scenario(pid, run, body.outcome, body.reason, body.client_id, body.review_id)
    except KeyError:
        raise HTTPException(404, '제안 또는 비교 기록을 찾을 수 없습니다.')
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get('/{pid}/followup')
def followup(pid: str, run_id: str | None = Query(default=None, max_length=100)):
    try:
        watch_officer.on_collision_update()
        result = watch_officer.get_store().followup(pid)
        if run_id:
            run = collision_scenarios.Repository().get('run', run_id)
            if run['snapshot'].get('proposal_id') != pid:
                raise HTTPException(409, '이 제안에 연결된 비교가 아닙니다.')
            result['prediction_comparison'] = decision_followup.residuals(run, result['observations'])
        return result
    except KeyError:
        raise HTTPException(404, '제안 또는 비교 기록을 찾을 수 없습니다.')


@router.get('/{pid}/record')
def saved_record(pid: str):
    from backend.ontology.evidence import load
    try:
        return load(pid)['proposal']
    except KeyError:
        raise HTTPException(404, '제안 기록을 찾을 수 없습니다.')
