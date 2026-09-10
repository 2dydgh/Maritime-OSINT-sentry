"""당직사관 제안 조회·결심·근거 그래프 API."""
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from backend.services import watch_graph, watch_officer

logger = logging.getLogger(__name__)
router = APIRouter()

MEDIA = {"turtle": "text/turtle; charset=utf-8", "json-ld": "application/ld+json"}


class Decision(BaseModel):
    outcome: Literal["approved", "dismissed"]
    reason: str | None = None


@router.get("/proposals")
async def list_proposals(status: str | None = None, limit: int = Query(50, ge=1, le=500)):
    items = watch_officer.list_proposals(status=status, limit=limit)
    return {"proposals": items, "total": len(items)}


@router.post("/proposals/{proposal_id}/decision")
async def decide(proposal_id: str, body: Decision):
    try:
        rec = watch_officer.decide(proposal_id, body.outcome, body.reason)
    except KeyError:
        raise HTTPException(404, "proposal not found")
    except ValueError as e:
        raise HTTPException(409, str(e))
    watch_graph.add_decision(rec)
    await watch_officer._publish("proposal_update", rec)
    return rec


@router.get("/proposals/{proposal_id}/graph")
async def graph(proposal_id: str, format: str = "turtle"):
    if format not in MEDIA:
        raise HTTPException(400, "format must be turtle or json-ld")
    if watch_officer.get_proposal(proposal_id) is None:
        raise HTTPException(404, "proposal not found")
    return Response(watch_graph.serialize(proposal_id, format), media_type=MEDIA[format])
