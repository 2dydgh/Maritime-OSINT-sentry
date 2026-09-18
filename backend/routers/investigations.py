"""Manual event-scoped investigation; no agent-facing approval endpoint."""
from fastapi import APIRouter, HTTPException

from backend.services import investigation_agent as agent
from backend.services.investigation_store import Repository

router = APIRouter(prefix='/investigations', tags=['decision-support'])


@router.post('/proposals/{pid}', status_code=202)
async def start(pid: str):
    repo = Repository()
    try:
        record, created = repo.create(pid, agent.TIMEOUT, agent.MODEL)
        if created:
            agent.launch(repo, record)
        return repo.view(record)
    except KeyError:
        raise HTTPException(404, '제안 기록을 찾을 수 없습니다.')
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get('/proposals/{pid}')
def recent(pid: str):
    try:
        repo = Repository()
        return {'investigations':[repo.view(r) for r in repo.recent(pid)]}
    except KeyError:
        raise HTTPException(404, '제안 기록을 찾을 수 없습니다.')


@router.get('/{rid}')
def get(rid: str):
    try:
        repo = Repository()
        return repo.view(repo.get(rid))
    except KeyError:
        raise HTTPException(404, '조사 기록을 찾을 수 없습니다.')


@router.post('/{rid}/cancel')
def cancel(rid: str):
    try:
        repo = Repository()
        return repo.view(repo.update(rid, status='cancelled', cancel_requested=True, message='운용자가 조사를 취소했습니다.'))
    except KeyError:
        raise HTTPException(404, '조사 기록을 찾을 수 없습니다.')
