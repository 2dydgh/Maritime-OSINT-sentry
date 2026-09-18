"""Bounded RDF projection of saved decision records, without DB writes or live AIS."""
import hashlib
import json
import math
import sqlite3
import time
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

from pyshacl import validate
from rdflib import RDF, RDFS, XSD, Graph, Literal, Namespace, URIRef

from backend import config

M = Namespace('https://maritime-osint.example/ontology#')
SH = Namespace('http://www.w3.org/ns/shacl#')
HERE = Path(__file__).parent
VERSION = '1.1.0'
MAX_OBSERVATIONS = 60
QUESTIONS = {'why':'왜 추적 대상으로 판단했나?', 'basis':'판단 근거는 무엇인가?', 'after':'판단 이후 무엇이 달라졌나?'}
STATUSES = {'open':'검토 대기', 'approved':'승인됨·실행 확인 대기', 'tracking':'추적 중', 'dismissed':'기각', 'expired':'만료', 'failed':'실행 실패', 'unknown':'실행·관측 상태 확인 불가', 'completed':'종료'}


@lru_cache(maxsize=2)
def definition(name):
    return Graph().parse(HERE/name, format='turtle')


def readonly(path):
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path.name)
    return sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True, timeout=10)


def load(pid, watch_path=None, scenario_path=None):
    """One SQLite read snapshot for proposal+observations, then immutable runs."""
    try:
        db = readonly(watch_path or config.WATCH_DB)
    except FileNotFoundError:
        raise KeyError(pid) from None
    try:
        db.execute('BEGIN')
        row = db.execute('SELECT record FROM proposals WHERE id=?', (pid,)).fetchone()
        if not row:
            raise KeyError(pid)
        p = json.loads(row[0])
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        observations, total, until = [], 0, None
        if 'observations' in tables:
            total = db.execute('SELECT COUNT(*) FROM observations WHERE pid=?', (pid,)).fetchone()[0]
            rows = db.execute('SELECT record FROM observations WHERE pid=? ORDER BY at DESC,received_key LIMIT ?', (pid,MAX_OBSERVATIONS)).fetchall()
            observations = [json.loads(r[0]) for r in reversed(rows)]
        if 'monitors' in tables:
            row = db.execute('SELECT until_at FROM monitors WHERE pid=?', (pid,)).fetchone()
            until = row[0] if row else None
    finally:
        db.close()
    ids = sorted({r['run_id'] for r in p.get('scenario_reviews',[])[:50] if r.get('run_id')})
    runs = {}
    if ids:
        try:
            db = readonly(scenario_path or config.SCENARIO_DB)
        except FileNotFoundError:
            db = None
        if db:
            try:
                rows = db.execute("SELECT id,body FROM records WHERE kind='run' AND id IN ("+','.join('?' for _ in ids)+')', ids)
                runs = {rid:json.loads(body) for rid,body in rows}
            finally:
                db.close()
    return {'proposal':p, 'runs':runs, 'observations':observations, 'observation_total':total, 'monitor_until':until}


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,allow_nan=False,default=str).encode()).hexdigest()[:24]


class Evidence:
    def __init__(self, bundle, now=None):
        self.bundle = bundle
        self.p = bundle['proposal']
        self.pid = str(self.p['id'])
        self.now = time.time() if now is None else now
        self.g = Graph()
        self.g.bind('m', M)
        self.g.bind('owl', Namespace('http://www.w3.org/2002/07/owl#'))
        self.g.bind('xsd',XSD)
        self.nodes, self.sources, self.gaps = {}, {}, []
        self.path = '/api/v1/proposals/'+quote(self.pid,safe='')+'/record'
        self.root = URIRef('urn:mos:proposal:'+quote(self.pid,safe=''))
        self.build()

    def gap(self, text):
        if text not in self.gaps:
            self.gaps.append(text)

    def node(self, kind, label, raw, pointer, path=None, identifier=None):
        node = identifier or URIRef('urn:mos:'+kind.lower()+':'+digest([self.pid,path or self.path,pointer,raw]))
        self.g.add((node,RDF.type,M[kind]))
        self.g.add((node,RDFS.label,Literal(label,lang='ko')))
        self.put(node,'sourcePath',path or self.path)
        self.put(node,'sourcePointer',pointer)
        self.nodes[str(node)] = {'id':str(node),'type':kind,'label':label}
        self.sources[str(node)] = {'path':path or self.path,'pointer':pointer,'record':raw}
        return node

    def put(self, node, key, value, datatype=XSD.string):
        if value is None:
            return
        if datatype == XSD.double:
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
                self.gap('숫자 형식이 잘못된 원본 필드가 있어 해당 값을 제외했습니다: '+key)
                return
            value = float(value)
        if datatype == XSD.dateTime:
            try:
                if isinstance(value,(int,float)) and not isinstance(value,bool):
                    value = datetime.fromtimestamp(value,UTC)
                elif isinstance(value,str):
                    value = datetime.fromisoformat(value)
                if not isinstance(value,datetime) or value.tzinfo is None:
                    raise ValueError('timezone required')
                value = value.astimezone(UTC)
            except (ValueError,TypeError,OverflowError,OSError):
                self.gap('시각이 누락되었거나 시간대가 불분명한 원본 값이 있습니다: '+key)
                return
        self.g.add((node,M[key],Literal(value,datatype=datatype)))

    def link(self, a, relation, b):
        self.g.add((a,M[relation],b))

    def vessel(self, v):
        value = str(v.get('mmsi',''))
        node = URIRef('urn:mos:vessel:mmsi:'+quote(value,safe=''))
        if str(node) not in self.nodes:
            self.node('Vessel',(v.get('name') or value)+' · '+value,self.p,'',identifier=node)
            self.put(node,'mmsi',value)
        return node

    def state(self, v, pointer, path=None, received=None, source_raw=None):
        received = received if received is not None else v.get('_updated')
        kind = 'AISObservation' if received is not None else 'AnalysisInputState'
        node = self.node(kind,('수신 관측' if received is not None else '수신 시각 없는 과거 입력')+' · '+str(v.get('mmsi','')),v if source_raw is None else source_raw,pointer,path)
        self.link(node,'observedVessel',self.vessel(v))
        for key,source in [('latitude','lat'),('longitude','lng'),('speedKnots','sog'),('courseDegrees','cog')]:
            self.put(node,key,v.get(source),XSD.double)
        if received is not None:
            self.put(node,'receivedAt',received,XSD.dateTime)
        else:
            self.gap('일부 과거 분석 입력에는 AIS 수신 시각이 없습니다. 분석 시각을 수신 시각으로 대체하지 않았습니다.')
        return node,kind

    def analysis(self, raw, pointer, label, approval=False):
        node = self.node('RiskAnalysis',label,raw,pointer)
        self.put(node,'recordedAt',raw.get('checked_at') if approval else raw.get('analysis_at'),XSD.dateTime)
        self.put(node,'dcpaNm',raw.get('dcpa_nm'),XSD.double)
        self.put(node,'tcpaMinutes',raw.get('tcpa_min'),XSD.double)
        self.put(node,'model','approval-cpa-recheck' if approval else raw.get('source'))
        received = raw.get('vessel_received_at',[])
        for i,v in enumerate(raw.get('subjects',[])):
            obs,kind = self.state(v,pointer+'/subjects/'+str(i),received=received[i] if i<len(received) else None)
            self.link(node,'usesObservation' if kind=='AISObservation' else 'usesInputState',obs)
        if len(raw.get('subjects',[]))!=2:
            self.gap('위험 분석의 원본 선박 입력 두 건이 모두 보존되지 않았습니다.')
        return node

    def scenario(self, run):
        rid = str(run['id'])
        path = '/api/v1/collision/scenarios/runs/'+quote(rid,safe='')
        node = self.node('ScenarioComparison','저장된 시나리오 비교 · '+rid[:8],run,'',path)
        self.put(node,'recordedAt',run.get('created_at'),XSD.dateTime)
        self.put(node,'model',run.get('model'))
        self.put(node,'runId',rid)
        snap = run['snapshot']
        for i,v in enumerate(snap.get('ships',[])[:2]):
            raw = dict(v,lat=v.get('source_lat'),lng=v.get('source_lng'))
            obs,_ = self.state(raw,'/snapshot/ships/'+str(i),path,received=v.get('received_at'),source_raw=v)
            projection = self.node('ProjectedState','비교 시작 상태 · '+str(v.get('mmsi','')),v,'/snapshot/ships/'+str(i),path)
            self.put(projection,'recordedAt',snap.get('created_at'),XSD.dateTime)
            self.link(projection,'derivedFrom',obs)
            self.link(node,'startsFrom',projection)
        for key,title in [('baseline','기준 유지'),('alternative','변경 가정')]:
            metric = run.get('scenarios',{}).get(key,{}).get('pair',{})
            prediction = self.node('Prediction',title+' · 예측 결과',metric,'/scenarios/'+key+'/pair',path)
            self.put(prediction,'minimumDistanceNm',metric.get('closest_distance_nm'),XSD.double)
            self.put(prediction,'minimumTimeSeconds',metric.get('closest_time_s'),XSD.double)
            self.link(node,'hasPrediction',prediction)
        return node

    def build(self):
        p = self.p
        self.node('Proposal','집중 추적 제안 · '+self.pid[:8],p,'',identifier=self.root)
        self.put(self.root,'status',p.get('status'))
        self.put(self.root,'revision',p.get('revision'),XSD.integer)
        self.put(self.root,'recordedAt',p.get('created_at'),XSD.dateTime)
        for mmsi in p.get('pair',[]):
            v = next((v for v in p.get('trigger',{}).get('subjects',[]) if str(v.get('mmsi'))==str(mmsi)), {'mmsi':mmsi})
            self.link(self.root,'involvesVessel',self.vessel(v))
        self.link(self.root,'triggeredBy',self.analysis(p.get('trigger',{}),'/trigger','제안에 저장된 위험 분석'))
        review_nodes, scenario_nodes = {}, {}
        for i,review in enumerate(p.get('scenario_reviews',[])[:50]):
            node = self.node('Review','검토 · '+{'reference':'참고안','deferred':'보류','rejected':'미채택'}.get(review.get('outcome'),'결과 미기록'),review,'/scenario_reviews/'+str(i))
            review_nodes[review.get('id')] = node
            self.link(self.root,'hasReview',node)
            for key,source in [('outcome','outcome'),('reason','reason'),('sessionId','client_id')]:
                self.put(node,key,review.get(source))
            self.put(node,'recordedAt',review.get('at'),XSD.dateTime)
            rid = review.get('run_id')
            run = self.bundle['runs'].get(rid)
            if not run:
                self.gap('검토가 참조하는 비교 원본이 없습니다: '+str(rid))
                continue
            if run.get('id')!=rid or run.get('snapshot',{}).get('proposal_id')!=self.pid or sorted(run['snapshot'].get('pair',[]))!=sorted(p.get('pair',[])):
                self.gap('다른 제안 또는 선박 쌍의 비교 참조를 제외했습니다: '+str(rid))
                continue
            if rid not in scenario_nodes:
                scenario_nodes[rid] = self.scenario(run)
            self.link(node,'compares',scenario_nodes[rid])
        decision = None
        if p.get('decision'):
            raw = p['decision']
            decision = self.node('Decision','운용자 판단',raw,'/decision')
            self.link(self.root,'hasDecision',decision)
            for key,source in [('outcome','outcome'),('reason','reason'),('sessionId','client_id')]:
                self.put(decision,key,raw.get(source))
            self.put(decision,'recordedAt',raw.get('at'),XSD.dateTime)
            investigation = raw.get('investigation')
            if investigation:
                node = self.node('AgentInvestigation','승인 당시 AI 조사',investigation,'/decision/investigation')
                self.link(decision,'usesInvestigation',node)
                self.put(node,'model',investigation.get('model'))
                self.put(node,'outcome',investigation.get('result',{}).get('action'))
                self.put(node,'reason',investigation.get('result',{}).get('explanation'))
                self.put(node,'recordedAt',investigation.get('result',{}).get('validated_at'),XSD.dateTime)
            if raw.get('outcome')=='approved' and p.get('approval_evidence'):
                self.link(decision,'basedOn',self.analysis(p['approval_evidence'],'/approval_evidence','승인 시 CPA 재검증',approval=True))
            elif raw.get('outcome')=='approved':
                self.gap('승인 당시 재검증 근거가 보존되지 않았습니다.')
            if 'scenario_review_ids' not in raw:
                self.gap('이 과거 판단에는 당시 검토 목록이 없습니다. 현재 검토 목록으로 대체하지 않았습니다.')
            for rid in raw.get('scenario_review_ids',[]):
                if rid in review_nodes:
                    self.link(decision,'usesReview',review_nodes[rid])
                else:
                    self.gap('판단이 참조한 검토 원본이 없습니다: '+str(rid))
                    self.link(decision,'usesReview',URIRef('urn:mos:missing-review:'+quote(str(rid),safe='')))
        execution = p.get('execution')
        if execution:
            node = self.node('TrackingExecution','지도 추적 실행 요청',execution,'/execution')
            self.link(self.root,'hasExecution',node)
            if decision:
                self.link(node,'authorizedBy',decision)
            self.put(node,'recordedAt',execution.get('requested_at'),XSD.dateTime)
            self.put(node,'sessionId',execution.get('client_id'))
            for i,event in enumerate(p.get('events',[])):
                is_receipt = event.get('kind')=='execution_receipt' or event.get('reason') in ('map_tracking_started','operator_stopped_tracking','map_tracking_stopped')
                if not is_receipt or event.get('status') not in ('tracking','completed','failed'):
                    continue
                receipt = self.node('ExecutionReceipt','브라우저 영수증 · '+STATUSES.get(event['status'],event['status']),event,'/events/'+str(i))
                self.put(receipt,'recordedAt',event.get('at'),XSD.dateTime)
                self.put(receipt,'status',event['status'])
                self.put(receipt,'reason',event.get('reason'))
                self.link(node,'confirmedBy',receipt)
        self.put(self.root,'monitorUntil',self.bundle.get('monitor_until'),XSD.dateTime)
        for observation in self.bundle.get('observations',[]):
            key = digest(observation)
            path = '/api/v1/proposals/'+quote(self.pid,safe='')+'/followup'
            node = self.node('FollowupAssessment','후속 거리·CPA 평가',observation,'/observations/by-content/'+key,path)
            self.link(self.root,'hasFollowup',node)
            self.put(node,'recordedAt',observation.get('at'),XSD.dateTime)
            self.put(node,'status',observation.get('risk_state'))
            for prop,source in [('distanceNm','distance_nm'),('dcpaNm','dcpa_nm'),('tcpaMinutes','tcpa_min')]:
                self.put(node,prop,observation.get(source),XSD.double)
            for i,v in enumerate(observation.get('subjects',[])):
                obs,kind = self.state(v,'/observations/by-content/'+key+'/subjects/'+str(i),path)
                self.link(node,'usesObservation' if kind=='AISObservation' else 'usesInputState',obs)
        if not self.bundle.get('observations'):
            self.gap('저장된 후속 관측이 없습니다. 현재 위험 감소 여부를 확인할 수 없습니다.')
        total = self.bundle.get('observation_total',len(self.bundle.get('observations',[])))
        if total>MAX_OBSERVATIONS:
            self.gap(f'근거 그래프에는 저장된 후속 평가 {total}건 중 최신 {MAX_OBSERVATIONS}건을 포함했습니다. 전체 기록은 후속 확인에서 볼 수 있습니다.')

    def to_turtle(self):
        # N-Triples is a Turtle subset. Explicit typed literals preserve double
        # precision; RDFLib's pretty Turtle shorthand rounds doubles to 6 digits.
        return '# Ontology: /api/v1/knowledge/schema.ttl ; version '+VERSION+'\n'+self.g.serialize(format='nt')

    def query(self, name):
        return list(self.g.query((HERE/'queries'/(name+'.rq')).read_text(),initBindings={'proposal':self.root}))

    def validation(self):
        conforms, report, _ = validate(self.g,shacl_graph=definition('shapes.ttl'),inference='none',advanced=False,js=False,do_owl_imports=False)
        violations = []
        for result in report.subjects(RDF.type,SH.ValidationResult):
            focus, path = report.value(result,SH.focusNode), report.value(result,SH.resultPath)
            violations.append({'node':str(focus),'path':str(path) if path else '', 'message':str(report.value(result,SH.resultMessage) or '데이터 제약 위반')})
        return {'conforms':bool(conforms),'count':len(violations),'violations':violations[:50]}

    def answer(self, question):
        if question not in QUESTIONS:
            raise ValueError('unsupported question')
        validation = self.validation()
        rows = self.query(question)
        claims, relevant = [], {str(self.root)}
        def claim(text, *nodes):
            ids = [str(n) for n in nodes if n is not None and str(n) in self.nodes]
            relevant.update(ids)
            claims.append({'text':text,'evidence':ids})
        status = str(self.g.value(self.root,M.status) or 'unknown')
        if question=='why':
            row = rows[0] if rows else None
            claim('이 제안의 저장 상태는 “'+STATUSES.get(status,status)+'”입니다. 현재 브라우저의 실제 추적 상태와 다를 수 있습니다.',self.root)
            if row and row.decision:
                outcome = str(row.outcome)
                claim(('집중 추적을 승인했습니다.' if outcome=='approved' else '제안을 기각했습니다.')+' 기록된 판단 이유: '+str(row.reason or '기록 없음'),row.decision)
                if row.analysis and row.dcpa is not None:
                    claim('승인 시 재검증 DCPA는 '+format(float(row.dcpa),'.2f')+' nm'+(' · TCPA '+format(float(row.tcpa),'.1f')+'분' if row.tcpa is not None else '')+'입니다.',row.analysis)
                receipts = [r.receipt for r in rows if str(r.receiptStatus)=='tracking']
                if receipts:
                    claim('브라우저가 지도 추적 시작을 확인한 과거 영수증이 있습니다. 선박 운항 변경의 실행 기록은 아닙니다.',receipts[0])
                elif outcome=='approved':
                    claim('승인 기록은 있으나, 확인 가능한 지도 추적 시작 영수증은 없습니다.',row.decision)
            else:
                claim('저장된 운용자 판단이 없습니다. 이 제안으로 추적을 승인했다고 설명할 수 없습니다.',self.root)
        elif question=='basis':
            relevant.update(str(r.node) for r in rows if str(r.node) in self.nodes)
            decision = self.g.value(self.root,M.hasDecision)
            reviews = list(self.g.objects(decision,M.usesReview)) if decision else []
            claim('제안에 저장된 분석과 원본 입력을 연결했습니다. 수신 시각이 빠진 입력은 관측과 구분해 표시합니다.',self.g.value(self.root,M.triggeredBy))
            if decision:
                claim('확인 가능한 판단 당시 검토 연결은 '+str(len(reviews))+'건입니다. 이후에 추가된 검토는 이 목록에 포함하지 않습니다.',decision,*reviews)
            else:
                claim('아직 판단 기록이 없어 “판단 당시 근거”는 없습니다. 제안에 저장된 근거를 표시합니다.',self.root)
        else:
            decision = self.g.value(self.root,M.hasDecision)
            decision_at = self.g.value(decision,M.recordedAt) if decision else None
            # Only observations at/after the decision answer "after judgment".
            if decision_at:
                rows = [r for r in rows if r.at.toPython()>=decision_at.toPython()]
            if not decision_at:
                claim('저장된 판단 시각이 없어 판단 전후의 변화를 설명할 수 없습니다.',self.root)
            elif not rows:
                claim('판단 이후 저장된 후속 관측이 없습니다. 위험 감소를 확인할 수 없습니다.',decision)
            else:
                latest = rows[0]
                relevant.add(str(latest.node))
                until = self.g.value(self.root,M.monitorUntil)
                stamps = [self.g.value(n,M.receivedAt) for n in self.g.objects(latest.node,M.usesObservation)]
                fresh = bool(until and self.now<=until.toPython().timestamp() and len(stamps)==2 and all(t and 0<=self.now-t.toPython().timestamp()<=60 for t in stamps))
                claim(('최근 유효한 수신 기록' if fresh else '과거 수신 기록')+'의 선박 간 거리는 '+format(float(latest.distance),'.2f')+' nm입니다.',latest.node)
                if not fresh:
                    claim('관측 기간이 끝났거나 수신이 지연되어 현재 위험 변화는 판단할 수 없습니다.',latest.node)
                else:
                    claim('최근 CPA 주의 조건은 '+('유지됩니다.' if str(latest.state)=='high' else '충족되지 않습니다. 안전이 확정됐다는 뜻은 아닙니다.'),latest.node)
                if len(rows)>1:
                    first = rows[-1]
                    claim('표시 범위에서 관측 거리는 '+format(float(first.distance),'.2f')+' → '+format(float(latest.distance),'.2f')+' nm로 변했습니다. 추적 조치가 이 변화를 일으켰다는 뜻은 아닙니다.',first.node,latest.node)
        if not validation['conforms']:
            claims = [{'text':'원본 연결 또는 데이터 형식이 검증 조건을 충족하지 않아 결론을 제공하지 않습니다. 아래 검증 결과와 원본을 확인하세요.','evidence':[]}]
        ontology = definition('maritime.ttl')
        nodes = []
        for nid, meta in self.nodes.items():
            node = URIRef(nid)
            properties = []
            for predicate,value in sorted(self.g.predicate_objects(node),key=lambda pair:str(pair[0])):
                if isinstance(value,Literal) and predicate not in (RDFS.label,M.sourcePath,M.sourcePointer):
                    properties.append({'label':str(ontology.value(predicate,RDFS.label) or predicate.split('#')[-1]),'value':str(value)})
            nodes.append(dict(meta,properties=properties,source_url='/api/v1/knowledge/proposals/'+quote(self.pid,safe='')+'/source?node='+quote(nid,safe='')+'&fingerprint='+digest(self.sources[nid]['record']),relevant=nid in relevant,run_id=str(self.g.value(node,M.runId)) if self.g.value(node,M.runId) else None))
        edges = [{'from':str(a),'to':str(b),'relation':str(rel),'label':str(ontology.value(rel,RDFS.label) or rel.split('#')[-1])}
                 for a,rel,b in self.g if isinstance(b,URIRef) and str(a) in self.nodes and str(b) in self.nodes]
        return {'proposal_id':self.pid,'revision':self.p.get('revision'),'ontology_version':VERSION,
                'generated_at':datetime.fromtimestamp(self.now,UTC).isoformat(),
                'question':question,'question_label':QUESTIONS[question],'claims':claims,'gaps':self.gaps,
                'validation':validation,'graph':{'nodes':nodes,'edges':sorted(edges,key=lambda e:(e['from'],e['relation'],e['to']))},
                'coverage':{'followup_included':len(self.bundle.get('observations',[])),'followup_total':self.bundle.get('observation_total',0)},
                'answer_method':'fixed-sparql-and-templates'}
