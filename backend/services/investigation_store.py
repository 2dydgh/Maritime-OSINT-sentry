"""Investigation records share the watch DB so approval links commit atomically."""
import json
import os
import time
from uuid import uuid4

from backend.services import watch_officer

ACTIVE = ('queued', 'running')


def failure_message(error_type):
    return {
        'UsageLimitExceeded':'AI가 최종 제안을 제출하기 전에 호출·응답 한도에 도달했습니다. 완료된 확인 결과는 저장돼 있습니다.',
        'UnexpectedModelBehavior':'AI가 올바른 근거와 조치로 최종 제안을 제출하지 못했습니다. 검증에서 거절된 이유와 확인 결과를 살펴보세요.',
        'ModelHTTPError':'로컬 모델 서버가 요청을 처리하지 못했습니다. 모델 서버 상태를 확인한 뒤 다시 조사하세요.',
        'APIConnectionError':'로컬 모델 서버에 연결하지 못했습니다. Ollama 실행 상태를 확인하세요.',
        'APITimeoutError':'로컬 모델의 응답을 기다리는 시간이 초과됐습니다. 완료된 확인 결과는 저장돼 있습니다.',
    }.get(error_type,'모델 응답·도구 실행 또는 제안 검증을 완료하지 못했습니다. 저장된 확인 결과를 살펴보세요.')


class Repository:
    def __init__(self, store=None):
        self.store = store or watch_officer.get_store()
        with self.store.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY, pid TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL)')
            db.execute('CREATE UNIQUE INDEX IF NOT EXISTS investigation_active ON investigations(pid) WHERE status IN (\'queued\',\'running\')')

    def _save(self, db, record):
        db.execute('INSERT INTO investigations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record',
                   (record['id'], record['proposal_id'], record['status'], json.dumps(record, ensure_ascii=False, allow_nan=False)))

    def recover(self, db):
        for (raw,) in db.execute("SELECT record FROM investigations WHERE status IN ('queued','running')").fetchall():
            r = json.loads(raw)
            alive = True
            try:
                os.kill(r['owner_pid'], 0)
                from pathlib import Path
                stat = Path('/proc') / str(r['owner_pid']) / 'stat'
                if stat.exists() and stat.read_text().split(') ',1)[1].startswith('Z '):
                    alive = False
            except (ProcessLookupError, FileNotFoundError):
                alive = False
            except PermissionError:
                pass
            if not alive or time.time() > r['deadline'] + 5:
                r.update(status='interrupted', message='서버 재시작 또는 실행 시간 초과로 조사가 중단됐습니다. 다시 조사하세요.')
                self._save(db, r)

    def create(self, pid, timeout, model):
        with self.store.transaction() as db:
            p = self.store.get(db, pid)
            self.recover(db)
            row = db.execute("SELECT record FROM investigations WHERE pid=? AND status IN ('queued','running')", (pid,)).fetchone()
            if row:
                return json.loads(row[0]), False
            count = db.execute("SELECT COUNT(*) FROM investigations WHERE status IN ('queued','running')").fetchone()[0]
            if count >= 2:
                raise ValueError('동시에 두 사건까지 조사할 수 있습니다. 진행 중인 조사를 마치거나 취소하세요.')
            now = time.time()
            r = dict(id=str(uuid4()), proposal_id=pid, pair=p['pair'], proposal_revision=p['revision'],
                     model=model, created_at=watch_officer.iso(now), deadline=now+timeout, owner_pid=os.getpid(),
                     status='queued', message='조사를 준비합니다.', events=[], evidence={}, result=None, cancel_requested=False)
            self._save(db, r)
            return r, True

    def get(self, rid):
        with self.store.transaction() as db:
            self.recover(db)
            row = db.execute('SELECT record FROM investigations WHERE id=?', (rid,)).fetchone()
            if not row:
                raise KeyError(rid)
            return json.loads(row[0])

    def recent(self, pid):
        with self.store.transaction() as db:
            self.store.get(db, pid)
            self.recover(db)
            return [json.loads(row[0]) for row in db.execute('SELECT record FROM investigations WHERE pid=? ORDER BY rowid DESC LIMIT 10', (pid,))]

    def view(self, record):
        """Current case state beside immutable investigation evidence (UI only)."""
        with self.store.transaction() as db:
            p = self.store.get(db, record['proposal_id'])
        result = record.get('result') or {}
        decision = p.get('decision') or {}
        eligible = (p['status']=='open' and record['status']=='completed'
                    and result.get('action')=='focus_tracking' and result.get('validation',{}).get('passed'))
        fresh = 0 <= time.time()-result.get('validated_at',0) <= 60
        names = {str(v.get('mmsi')):v.get('name') or str(v.get('mmsi')) for v in p['trigger']['subjects']}
        display = dict(record)
        if record['status']=='failed':
            display['message'] = failure_message(record.get('error_type'))
        return {**display, 'case':{
            'status':p['status'], 'names':[names.get(str(m),str(m)) for m in p['pair']],
            'decision':{k:decision.get(k) for k in ('at','outcome','reason')},
            'decision_investigation_id':(decision.get('investigation') or {}).get('id'),
            'can_approve':bool(eligible and fresh), 'can_dismiss':bool(eligible),
            'approval_expired':bool(eligible and not fresh),
        }}

    def update(self, rid, **changes):
        with self.store.transaction() as db:
            row = db.execute('SELECT record FROM investigations WHERE id=?', (rid,)).fetchone()
            if not row:
                raise KeyError(rid)
            r = json.loads(row[0])
            # A late task must not overwrite cancellation/recovery/completion.
            if r['status'] not in ACTIVE:
                return r
            r.update(changes)
            self._save(db, r)
            return r

    def event(self, rid, name, state, payload=None):
        r = self.get(rid)
        if r['status'] not in ACTIVE or r['cancel_requested']:
            raise InterruptedError('조사가 취소되거나 중단됐습니다.')
        events = r['events'] + [dict(at=watch_officer.iso(time.time()), tool=name, state=state)]
        evidence = r['evidence']
        # Short references are local to this persisted run, never global IDs.
        eid = 'e'+str(len(evidence)+1)
        if payload is not None:
            evidence[eid] = dict(id=eid, tool=name, proposal_id=r['proposal_id'], pair=r['pair'],
                                 recorded_at=watch_officer.iso(time.time()), data=payload)
            events[-1]['evidence_id'] = eid
        self.update(rid, events=events, evidence=evidence)
        return evidence.get(eid)


def approved_investigation(db, rid, proposal, now, outcome='approved'):
    """Called inside the existing decision transaction; no AI can call approval."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investigations'").fetchone():
        raise ValueError('조사 결과가 없습니다.')
    row = db.execute('SELECT record FROM investigations WHERE id=?', (rid,)).fetchone()
    if not row:
        raise ValueError('조사 결과가 없습니다.')
    r = json.loads(row[0])
    result = r.get('result') or {}
    if (r['proposal_id'] != proposal['id'] or r['pair'] != proposal['pair'] or r['status'] != 'completed'
            or result.get('action') != 'focus_tracking' or not result.get('validation', {}).get('passed')
            or (outcome=='approved' and not 0 <= now - result.get('validated_at', 0) <= 60)):
        raise ValueError('승인 가능한 최신 조사 결과가 아닙니다. 다시 조사하세요.')
    return {'id':rid, 'result':result, 'evidence':r['evidence'], 'model':r['model']}
