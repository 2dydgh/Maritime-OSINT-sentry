"""Read-only ontology evidence APIs. Query text and import URLs are never accepted."""
import json
import sqlite3
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from backend.ontology.evidence import HERE, Evidence, digest, load

router = APIRouter(prefix='/knowledge', tags=['knowledge-evidence'])


def evidence(pid):
    try:
        bundle = load(pid)
    except KeyError:
        raise HTTPException(404,'제안 기록을 찾을 수 없습니다.')
    except (sqlite3.DatabaseError, json.JSONDecodeError, ValueError, TypeError):
        raise HTTPException(503,'저장된 근거를 읽지 못했습니다. 원본 기록과 저장소 상태를 확인하세요.')
    try:
        return Evidence(bundle)
    except (KeyError,ValueError,TypeError):
        raise HTTPException(503,'원본 기록의 구조를 해석하지 못했습니다. 원본 형식을 확인하세요.')


@router.get('/schema.ttl')
def ontology():
    return Response((HERE/'maritime.ttl').read_text(),media_type='text/turtle')


@router.get('/shapes.ttl')
def shapes():
    return Response((HERE/'shapes.ttl').read_text(),media_type='text/turtle')


@router.get('/proposals/{pid}')
def answer(pid: str, question: Literal['why','basis','after'] = 'why'):
    return evidence(pid).answer(question)


@router.get('/proposals/{pid}/graph.ttl')
def graph(pid: str):
    view = evidence(pid)
    return Response(view.to_turtle(),media_type='text/turtle',headers={
        'Content-Disposition':'attachment; filename="proposal-evidence.ttl"',
        'X-Ontology-Version':'1.1.0',
    })


@router.get('/proposals/{pid}/source')
def source(pid: str, node: str = Query(min_length=1,max_length=500), fingerprint: str | None = Query(default=None,pattern='^[a-f0-9]{24}$')):
    view = evidence(pid)
    if node not in view.sources or (fingerprint and digest(view.sources[node]['record']) != fingerprint):
        raise HTTPException(409,'근거 기록이 변경되었거나 이 제안에 속하지 않습니다. 근거 화면을 새로 조회하세요.')
    return {'node':node,'proposal_revision':view.p.get('revision'),**view.sources[node]}
