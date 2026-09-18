"""Collision decision support: durable approval and browser execution receipts.

Single-host SQLite transactions serialize decisions. No navigation commands are
sent to vessels. A tracking receipt attests to the approving browser's map only.
"""
import json
import logging
import math
import os
import socket
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from backend import config
from backend.services import ais_stream, collision_analyzer, decision_followup

ACTIVE = ('open', 'approved', 'tracking')
# 관측이 잠시 끊긴 것과 위험이 해소된 것은 다른 사건이다. 앞의 셋은 공백이지
# 해소가 아니므로 검토 대기 제안을 곧바로 닫지 않는다. vessel_invalid(자료 오류)와
# risk_changed(조건 미충족)는 그대로 만료 사유로 둔다.
OBSERVATION_GAP = ('analysis_stale', 'vessel_stale', 'vessel_missing')
# 운용자가 스스로 끝낸 제안만 긴 쿨다운 대상. 나머지는 시스템 사정이라 곧 재시도한다.
OPERATOR_SETTLED = ('dismissed', 'completed')


def rank_key(trigger):
    """위험한 순서: ML 고위험 → DCPA 작은 순 → TCPA 임박한 순.
    제안 생성(refresh)·인계 요약·브라우저 알림(watch-officer.js rankKey)이 모두 이 순서를 따른다."""
    return (trigger.get('source') != 'ml', float(trigger.get('dcpa_nm', math.inf)), float(trigger.get('tcpa_min', math.inf)))


def in_aor(candidate):
    """담당 해역(config.WATCH_AOR_BOX) 안의 사건인가. 두 선박 중 한 척이라도 들어오면 우리
    사건이다 — 경계를 가로지르는 쌍을 놓치지 않도록. 좌표를 알 수 없으면 포함한다(놓치는 것보다
    더 보이는 쪽이 안전하다). 호출 시점에 설정을 읽으므로 테스트에서 바꿀 수 있다."""
    box = config.WATCH_AOR_BOX
    if not box:
        return True
    min_lat, min_lng, max_lat, max_lng = box
    placed = False
    for s in candidate.get('subjects', []):
        lat, lng = s.get('lat'), s.get('lng')
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            continue
        placed = True
        if min_lat <= lat <= max_lat and min_lng <= lng <= max_lng:
            return True
    return not placed


def iso(now):
    return datetime.fromtimestamp(now, UTC).isoformat()


def snapshot():
    risks = collision_analyzer.get_watch_snapshot()
    # Include active proposal vessels even after they leave the risk list.
    return risks, lambda pair: ais_stream.get_watch_vessels(pair)


def candidates(risks):
    result = {}
    for source in ('distance', 'ml'):
        for r in risks[source]:
            try:
                a, b = r['ship_a'], r['ship_b']
                pair = tuple(sorted((int(a['mmsi']), int(b['mmsi']))))
                d, t = float(r['dcpa_nm']), float(r['tcpa_min'])
                if pair[0] == pair[1] or not (math.isfinite(d) and math.isfinite(t) and d >= 0 and t > 0):
                    continue
                high = int(r.get('risk_level', 0)) >= 3 if source == 'ml' else d < config.WATCH_DCPA_NM and t < config.WATCH_TCPA_MIN
                if high:
                    result[pair] = {'source': source, 'dcpa_nm': d, 'tcpa_min': t,
                                    'risk_label': r.get('risk_label', 'CPA 조건 충족'),
                                    'analysis_at': r['ts'], 'subjects': [a, b]}
            except (KeyError, ValueError, TypeError):
                continue
    return result


def validate(pair, risks, lookup, now, candidate):
    if not 0 <= now - risks['updated_at'] <= config.WATCH_MAX_ANALYSIS_AGE_SEC:
        return 'analysis_stale', None
    if candidate is not None:
        try:
            analysis_at = datetime.fromisoformat(candidate['analysis_at']).timestamp()
            if not 0 <= now - analysis_at <= config.WATCH_MAX_ANALYSIS_AGE_SEC:
                return 'analysis_stale', None
        except (ValueError, TypeError):
            return 'analysis_stale', None
    vessels = lookup(pair)
    if len(vessels) != 2:
        return 'vessel_missing', None
    for v in vessels:
        if not 0 <= now - v.get('_updated', 0) <= config.WATCH_MAX_VESSEL_AGE_SEC:
            return 'vessel_stale', None
        if any(not isinstance(v.get(k), (int, float)) or not math.isfinite(v[k]) for k in ('lat', 'lng', 'sog', 'cog')):
            return 'vessel_invalid', None
        if not (-90 <= v['lat'] <= 90 and -180 <= v['lng'] <= 180 and 0 <= v['sog'] < 102.3 and 0 <= v['cog'] < 360):
            return 'vessel_invalid', None
    a, b = vessels
    tcpa, dcpa = collision_analyzer._compute_tcpa_dcpa(*(a[k] for k in ('lat','lng','sog','cog')), *(b[k] for k in ('lat','lng','sog','cog')))
    if not math.isfinite(tcpa) or tcpa <= 0:
        return 'risk_changed', None
    if candidate is None:
        return 'risk_changed', None
    if candidate['source'] == 'distance' and not (dcpa < config.WATCH_DCPA_NM and tcpa < config.WATCH_TCPA_MIN):
        return 'risk_changed', None
    # ML stays model-based, but divergent/remote pairs cannot approve on an old score.
    if candidate['source'] == 'ml' and (dcpa > 1 or tcpa > 20):
        return 'risk_changed', None
    return None, {'checked_at': iso(now), 'analysis_at': candidate['analysis_at'],
                  'dcpa_nm': dcpa, 'tcpa_min': tcpa,
                  'vessel_received_at': [iso(v['_updated']) for v in vessels],
                  'subjects': [{k:v.get(k) for k in ('mmsi','name','lat','lng','sog','cog')} for v in vessels]}


class Store:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def transaction(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, pair TEXT NOT NULL, status TEXT NOT NULL, updated REAL NOT NULL, record TEXT NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS proposals_pair ON proposals(pair,updated)')
            db.execute('CREATE TABLE IF NOT EXISTS monitors(pid TEXT PRIMARY KEY, until_at REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS observations(pid TEXT NOT NULL, received_key TEXT NOT NULL, at REAL NOT NULL, record TEXT NOT NULL, PRIMARY KEY(pid,received_key))')
            db.execute('CREATE INDEX IF NOT EXISTS observations_time ON observations(pid,at)')
            db.execute('CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY, at REAL NOT NULL, record TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, until REAL NOT NULL)')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def save(self, db, p, now):
        p['updated_at'] = iso(now)
        p['revision'] += 1
        db.execute('INSERT INTO proposals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated=excluded.updated,record=excluded.record',
                   (p['id'], ':'.join(map(str,p['pair'])), p['status'], now, json.dumps(p, ensure_ascii=False, allow_nan=False)))

    def transition(self, db, p, status, reason, now, kind=None):
        p['status'] = status
        event = {'at': iso(now), 'status': status, 'reason': reason}
        if kind:
            event['kind'] = kind
        p['events'].append(event)
        self.save(db, p, now)

    def get(self, db, pid):
        row = db.execute('SELECT record FROM proposals WHERE id=?', (pid,)).fetchone()
        if not row:
            raise KeyError(pid)
        return json.loads(row[0])

    def refresh(self, risks, lookup, now=None):
        now = time.time() if now is None else now
        cands = candidates(risks)
        fresh = 0 <= now - risks['updated_at'] <= config.WATCH_MAX_ANALYSIS_AGE_SEC
        all_pairs = {tuple(sorted((int(r['ship_a']['mmsi']), int(r['ship_b']['mmsi'])))) for r in risks['ml'] + risks['distance']}
        with self.transaction() as db:
            self.collect_observations(db, lookup, now)
            active = [json.loads(r[0]) for r in db.execute("SELECT record FROM proposals WHERE status IN ('open','approved','tracking')")]
            for p in active:
                pair = tuple(p['pair'])
                cand = cands.get(pair)
                error, _evidence = validate(pair, risks, lookup, now, cand)
                if p['status'] == 'open':
                    if error in OBSERVATION_GAP:
                        # 공백은 유예하되 무한정 열어두지는 않는다.
                        since = p.get('stale_since') or now
                        if now - since > config.WATCH_STALE_GRACE_SEC:
                            self.transition(db, p, 'expired', error, now)
                        elif p.get('stale') != error:
                            p['stale'], p['stale_since'] = error, since
                            self.save(db, p, now)
                    elif error:
                        self.transition(db, p, 'expired', error, now)
                    else:
                        recovered = p.pop('stale', None) is not None
                        p.pop('stale_since', None)
                        if recovered or cand != p['trigger']:
                            p['trigger'] = cand
                            self.save(db, p, now)
                elif p['status'] == 'approved' and now - p['execution']['requested_at'] > 30:
                    self.transition(db, p, 'unknown', 'execution_receipt_timeout', now)
                elif p['status'] == 'tracking' and now - p['execution']['last_seen'] > 20:
                    self.transition(db, p, 'unknown', 'browser_heartbeat_timeout', now)
                elif error in ('analysis_stale', 'vessel_missing', 'vessel_stale', 'vessel_invalid'):
                    self.transition(db, p, 'unknown', error, now)
                elif fresh and pair not in all_pairs:
                    self.transition(db, p, 'completed', 'risk_no_longer_listed', now)
                else:
                    p['risk_state'] = 'high' if cand and not error else 'reduced'
                    p['latest_analysis_at'] = iso(risks['updated_at'])
                    self.save(db, p, now)
            # 가장 위험한 것부터 만든다: ML 고위험 → DCPA 작은 순 → TCPA 임박한 순.
            # 정원을 넘기면 만들지 않는다. 당직자가 볼 수 있는 건 목록 전체가 아니라
            # 최악 몇 건이고, 무한정 쌓으면 그 몇 건마저 묻힌다.
            # 정원은 '지금 승인할 수 있는' 사건만 센다. 관측 지연 사건까지 세면 AIS 가 흔들릴 때
            # 승인도 못 하는 사건이 정원을 채워, 신선하고 더 위험한 사건이 최대 유예 시간
            # (WATCH_STALE_GRACE_SEC) 동안 올라오지 못한다. 지연 사건은 유예로 수가 묶인다.
            room = config.WATCH_MAX_OPEN - sum(1 for p in active if p['status'] == 'open' and not p.get('stale'))
            # 담당 해역 밖 쌍은 새로 제안하지 않는다. 이미 열린 사건은 위 루프에서 필터 없는 후보로
            # 계속 검증한다 — 필터를 거기까지 걸면 해역 밖 사건이 '조건 해소(risk_changed)' 로 잘못
            # 만료되고, 추적 중 사건은 '위험 감소' 로 잘못 기록된다.
            ordered = sorted(((pair, c) for pair, c in cands.items() if in_aor(c)), key=lambda kv: rank_key(kv[1]))
            for pair, cand in ordered:
                if room <= 0:
                    break
                if validate(pair, risks, lookup, now, cand)[0]:
                    continue
                key = ':'.join(map(str,pair))
                previous = db.execute('SELECT status,updated FROM proposals WHERE pair=? ORDER BY updated DESC LIMIT 1', (key,)).fetchone()
                if previous:
                    if previous[0] in ACTIVE:
                        continue
                    # 운용자가 기각·종료한 쌍은 30분 쉬어간다. 그러나 관측 공백처럼
                    # 시스템 사정으로 끝난 제안까지 30분 가리면, 위험이 계속되는 쌍이
                    # 그동안 화면에서 사라진다. 운영 기록상 같은 쌍의 재제안이 1800초
                    # 안에 한 건도 없었던 것이 그 증거다.
                    cooldown = (config.WATCH_COOLDOWN_MIN * 60 if previous[0] in OPERATOR_SETTLED
                                else config.WATCH_RETRY_COOLDOWN_SEC)
                    if now - previous[1] < cooldown:
                        continue
                p = {'id': str(uuid4()), 'pair': list(pair), 'created_at': iso(now), 'revision': 0,
                     'status': 'open', 'trigger': cand, 'decision': None, 'execution': None,
                     'rule': {'version': 'collision-watch-v2', 'dcpa_nm': config.WATCH_DCPA_NM, 'tcpa_min': config.WATCH_TCPA_MIN,
                              'max_analysis_age_sec': config.WATCH_MAX_ANALYSIS_AGE_SEC, 'max_vessel_age_sec': config.WATCH_MAX_VESSEL_AGE_SEC},
                     'events': [{'at': iso(now), 'status': 'open', 'reason': 'collision_rule'}]}
                self.save(db, p, now)
                room -= 1

    def acquire_scanner(self, owner, now=None):
        """제안 스캐너 임대를 얻거나 갱신한다. 다른 소유자가 유효한 임대를 쥐고 있으면
        (False, 그 소유자). 한 DB 를 여러 백엔드가 서로 다른 기준으로 갱신하면 한쪽이 만든 제안을
        다른 쪽이 곧바로 '조건 해소' 로 닫는다 — 스캔은 한 곳에서만 한다."""
        now = time.time() if now is None else now
        with self.transaction() as db:
            row = db.execute("SELECT owner, until FROM leases WHERE name='scanner'").fetchone()
            if row and row[0] != owner and row[1] > now:
                return False, row[0]
            db.execute("INSERT INTO leases VALUES('scanner',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, until=excluded.until",
                       (owner, now + config.WATCH_SCANNER_LEASE_SEC))
            return True, owner

    # ── 당직 인계 ─────────────────────────────────────────────────────────
    # 제안은 화면을 열어야만 보이고 상태가 10초마다 바뀌므로, 교대자는 "지난 인계 이후
    # 무엇이 있었고 지금 무엇을 넘겨받는가" 를 앱 안에서 확인해야 한다(메일 스레드로는
    # 곧바로 앱과 어긋난다). 판단·조사·후속 기록은 이미 있으므로 새로 남기는 것은
    # "누가 언제 무엇을 이어받았나" 뿐이다.
    HANDOFF_DEFAULT_WINDOW_SEC = 12 * 3600

    def record_handoff(self, operator, note, client_id, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            rows = db.execute("SELECT id,status FROM proposals WHERE status IN ('open','approved','tracking')").fetchall()
            h = {'id': str(uuid4()), 'at': iso(now), 'at_epoch': now, 'operator': operator, 'note': note,
                 'client_id': client_id,
                 # 인수 시점에 열려 있던 사건을 함께 남긴다 — "무엇을 넘겨받았나" 가 사후에 확인돼야 한다.
                 'open_ids': sorted(r[0] for r in rows if r[1] == 'open'),
                 'active_ids': sorted(r[0] for r in rows if r[1] != 'open')}
            db.execute('INSERT INTO handoffs VALUES(?,?,?)', (h['id'], now, json.dumps(h, ensure_ascii=False)))
            return h

    def handoff_summary(self, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            last = db.execute('SELECT record FROM handoffs ORDER BY at DESC LIMIT 1').fetchone()
            last = json.loads(last[0]) if last else None
            since = last['at_epoch'] if last else now - self.HANDOFF_DEFAULT_WINDOW_SEC
            rows = db.execute("SELECT record FROM proposals WHERE status IN ('open','approved','tracking') OR updated >= ?", (since,)).fetchall()
        open_, active, decisions = [], [], []
        for (record,) in rows:
            p = json.loads(record)
            if p['status'] == 'open':
                open_.append(p)
            elif p['status'] in ('approved', 'tracking'):
                active.append(p)
            d = p.get('decision')
            if d and d.get('at'):
                try:
                    at = datetime.fromisoformat(d['at']).timestamp()
                except ValueError:
                    continue
                if at >= since:
                    decisions.append({'id': p['id'], 'pair': p['pair'],
                                      'names': [s.get('name') or s.get('mmsi') for s in p['trigger']['subjects']],
                                      'outcome': d['outcome'], 'reason': d.get('reason', ''), 'at': d['at'],
                                      'status': p['status']})
        open_.sort(key=lambda p: rank_key(p['trigger']))
        active.sort(key=lambda p: p['updated_at'], reverse=True)
        decisions.sort(key=lambda d: d['at'], reverse=True)
        return {'generated_at': iso(now), 'since': iso(since), 'last_handoff': last, 'aor': config.WATCH_AOR_BOX,
                'open': open_, 'active': active, 'decisions': decisions}

    def list(self, limit=100):
        with self.transaction() as db:
            rows = db.execute("SELECT p.record, (SELECT o.record FROM observations o WHERE o.pid=p.id ORDER BY o.at DESC LIMIT 1), (SELECT m.until_at FROM monitors m WHERE m.pid=p.id) FROM proposals p ORDER BY CASE WHEN status IN ('open','approved','tracking') THEN 0 ELSE 1 END,updated DESC LIMIT ?", (limit,))
            result = []
            for record, observation, until in rows:
                p = json.loads(record)
                p['followup'] = {'latest':json.loads(observation) if observation else None, 'until':until}
                result.append(p)
            return result

    def decide(self, pid, outcome, reason, client_id, risks, lookup, now=None, investigation_id=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            p = self.get(db, pid)
            if p['status'] != 'open':
                return {'proposal': p, 'execute': False}
            if outcome not in ('approved','dismissed'):
                raise ValueError('invalid decision')
            investigation = None
            if investigation_id:
                from backend.services.investigation_store import approved_investigation
                investigation = approved_investigation(db, investigation_id, p, now, outcome)
            if outcome == 'approved':
                error, evidence = validate(tuple(p['pair']), risks, lookup, now, candidates(risks).get(tuple(p['pair'])))
                if error:
                    # refresh() 와 같은 정책: 관측 공백은 승인만 막고 제안은 살려둔다.
                    # 공백으로 닫아버리면 AIS 가 돌아와도 운용자에게 다시 보이지 않는다.
                    if error in OBSERVATION_GAP:
                        p['stale'] = error
                        self.save(db, p, now)
                    else:
                        self.transition(db, p, 'expired', error, now)
                    return {'proposal': p, 'execute': False}
                p['approval_evidence'] = evidence
                p['execution'] = {'id': str(uuid4()), 'client_id': client_id, 'requested_at': now, 'last_seen': now}
            if outcome == 'approved':
                self.monitor(db, pid, now + 30*60)
            p['decision'] = {'scenario_review_ids': [r['id'] for r in p.get('scenario_reviews', [])], 'at': iso(now), 'by': 'operator', 'client_id': client_id, 'outcome': outcome, 'reason': reason}
            if investigation:
                p['decision']['investigation'] = investigation
            self.transition(db, p, outcome, 'operator_decision', now)
            return {'proposal': p, 'execute': outcome == 'approved'}

    def monitor(self, db, pid, until):
        db.execute('INSERT INTO monitors VALUES(?,?) ON CONFLICT(pid) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)', (pid, until))

    def collect_observations(self, db, lookup, now):
        rows = db.execute('SELECT p.record FROM proposals p JOIN monitors m ON p.id=m.pid WHERE m.until_at>=?', (now,)).fetchall()
        for row in rows:
            p = json.loads(row[0])
            try:
                observation = decision_followup.observe(p['pair'], lookup(p['pair']), now, p['rule'])
            except ValueError:
                observation = None
            if observation is None:
                continue  # Missing/stale AIS never counts as risk reduction.
            key = json.dumps([(v['mmsi'], v['_updated']) for v in observation['subjects']])
            db.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?,?)',
                       (p['id'], key, now, json.dumps(observation, allow_nan=False)))
            db.execute('DELETE FROM observations WHERE pid=? AND received_key NOT IN (SELECT received_key FROM observations WHERE pid=? ORDER BY at DESC LIMIT 1200)', (p['id'], p['id']))

    def review_scenario(self, pid, run, outcome, reason, client_id, review_id, now=None):
        now = time.time() if now is None else now
        if outcome not in ('reference', 'deferred', 'rejected') or not reason.strip():
            raise ValueError('검토 결과와 이유를 입력하세요.')
        with self.transaction() as db:
            p = self.get(db, pid)
            if sorted(run['snapshot']['pair']) != sorted(p['pair']) or run['snapshot'].get('proposal_id') != pid:
                raise ValueError('이 제안에서 시작한 비교만 연결할 수 있습니다.')
            reviews = p.setdefault('scenario_reviews', [])
            previous = next((r for r in reviews if r['id'] == review_id), None)
            if previous:
                if any(previous[k] != value for k, value in {'run_id':run['id'], 'outcome':outcome, 'reason':reason, 'client_id':client_id}.items()):
                    raise ValueError('이미 사용한 검토 요청 번호입니다.')
                return p
            if len(reviews) >= 50:
                raise ValueError('제안당 검토 기록은 최대 50건입니다.')
            reviews.append({'id':review_id, 'run_id':run['id'], 'at':iso(now), 'client_id':client_id,
                            'outcome':outcome, 'reason':reason, 'snapshot_at':run['snapshot']['created_at'],
                            'change':run['change'], 'model':run['model'],
                            'baseline_min_nm':run['scenarios']['baseline']['pair']['closest_distance_nm'],
                            'alternative_min_nm':run['scenarios']['alternative']['pair']['closest_distance_nm']})
            p['events'].append({'at':iso(now), 'status':p['status'], 'reason':'scenario_review_recorded'})
            self.monitor(db, pid, decision_followup.timestamp(run['snapshot']['created_at']) + run['horizon_s'])
            self.save(db, p, now)
            return p

    def followup(self, pid, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            p = self.get(db, pid)
            rows = db.execute('SELECT record FROM observations WHERE pid=? ORDER BY at', (pid,)).fetchall()
            monitor = db.execute('SELECT until_at FROM monitors WHERE pid=?', (pid,)).fetchone()
        observations = [json.loads(row[0]) for row in rows]
        latest = observations[-1] if observations else None
        state = 'not_started' if not monitor else 'ended' if now > monitor[0] else 'waiting'
        if monitor and now <= monitor[0] and latest:
            state = 'fresh' if all(0 <= now-v['_updated'] <= 60 for v in latest['subjects']) else 'stale'
        return {'proposal_id':pid, 'state':state, 'until':iso(monitor[0]) if monitor else None,
                'latest':latest, 'observations':observations, 'approval_evidence':p.get('approval_evidence'),
                'note':'수신된 AIS를 주기적으로 기록합니다. 수신 중단은 안전 또는 위험 해소로 판정하지 않습니다.'}

    def receipt(self, pid, execution_id, client_id, outcome, reason, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            p = self.get(db, pid)
            ex = p['execution']
            if not ex or ex['id'] != execution_id or ex['client_id'] != client_id:
                raise ValueError('execution owner mismatch')
            if p['status'] not in ('approved','tracking'):
                return p  # Late receipts cannot resurrect terminal records.
            if now - ex['last_seen'] > (30 if p['status'] == 'approved' else 20):
                self.transition(db, p, 'unknown', 'execution_receipt_timeout', now)
                return p
            if outcome not in ('tracking','failed','completed'):
                raise ValueError('invalid execution outcome')
            if outcome == 'completed' and p['status'] != 'tracking':
                raise ValueError('tracking has not started')
            ex['last_seen'] = now
            if outcome == p['status']:
                self.save(db, p, now)
            else:
                self.transition(db, p, outcome, reason or 'browser_receipt', now, kind='execution_receipt')
            return p


def get_store():
    return Store(config.WATCH_DB)


SCANNER_OWNER = f'{socket.gethostname()}:{os.getpid()}'
_warned_holders = set()


def on_collision_update():
    store = get_store()
    held, holder = store.acquire_scanner(SCANNER_OWNER)
    if not held:
        # 화면·승인·인계는 이 서버에서도 그대로 동작한다. 제안 갱신만 임대를 쥔 서버에 맡긴다.
        if holder not in _warned_holders:
            _warned_holders.add(holder)
            logging.getLogger(__name__).warning(
                '다른 백엔드(%s)가 당직사관 스캐너를 맡고 있어 이 서버(%s)는 제안을 갱신하지 않습니다. '
                '같은 DB 로 서버를 여러 개 띄웠는지 확인하세요.', holder, SCANNER_OWNER)
        return
    risks, lookup = snapshot()
    store.refresh(risks, lookup)
