from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services import collision_scenarios as service
from backend.services import watch_officer

router = APIRouter(prefix="/collision/scenarios", tags=["collision-scenarios"])


class Pair(BaseModel):
    proposal_id: str | None = Field(default=None, max_length=100)
    mmsi_a: int = Field(ge=100000000, le=999999999)
    mmsi_b: int = Field(ge=100000000, le=999999999)


class Comparison(BaseModel):
    turn_seconds: int = Field(default=0, ge=0, le=300)
    speed_seconds: int = Field(default=0, ge=0, le=300)
    snapshot_id: str = Field(min_length=1, max_length=100)
    target: int
    speed: float = Field(ge=0, le=50, allow_inf_nan=False)
    course: float = Field(ge=0, lt=360, allow_inf_nan=False)
    minutes: int = Field(default=15, ge=5, le=30)


@router.post("/snapshots")
def capture(body: Pair):
    try:
        if body.proposal_id:
            store = watch_officer.get_store()
            with store.transaction() as db:
                proposal = store.get(db, body.proposal_id)
            if sorted(proposal["pair"]) != sorted([body.mmsi_a, body.mmsi_b]):
                raise ValueError("제안의 선박 쌍과 비교 대상이 다릅니다.")
        snapshot = service.capture([body.mmsi_a, body.mmsi_b])
        snapshot["proposal_id"] = body.proposal_id
        if body.proposal_id:
            snapshot["proposal_context"] = {
                "revision": proposal["revision"],
                "status": proposal["status"],
                "trigger": proposal["trigger"],
                "rule": proposal["rule"],
            }
        return service.Repository().save("snapshot", snapshot)
    except KeyError:
        raise HTTPException(404, "제안을 찾을 수 없습니다")
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.post("/runs")
def compare(body: Comparison):
    repo = service.Repository()
    try:
        snapshot = repo.get("snapshot", body.snapshot_id)
        return repo.save(
            "run",
            service.compare(
                snapshot, body.target, body.speed, body.course, body.minutes, body.turn_seconds, body.speed_seconds
            ),
        )
    except KeyError:
        raise HTTPException(404, "스냅샷을 찾을 수 없습니다")
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/runs")
def recent():
    return {"runs": service.Repository().recent()}


@router.get("/runs/{rid}")
def get_run(rid: str):
    try:
        return service.Repository().get("run", rid)
    except KeyError:
        raise HTTPException(404, "비교 기록을 찾을 수 없습니다")
