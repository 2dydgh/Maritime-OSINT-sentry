"""Frozen local-plane, constant-velocity collision comparisons (not maneuver advice)."""
import json
import math
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from backend import config
from backend.services import ais_stream

MODEL = 'constant-velocity-local-plane-v1'
MAX_AGE = 60
CONTEXT_NM = 10
MAX_NEIGHBORS = 50


def stamp(ts):
    return datetime.fromtimestamp(ts, UTC).isoformat()


def valid(v, now):
    return (all(isinstance(v.get(k), (int,float)) and not isinstance(v[k],bool) and math.isfinite(v[k]) for k in ('lat','lng','sog','cog','_updated'))
            and abs(v['lat']) <= 80 and -180 <= v['lng'] <= 180 and 0 <= v['sog'] < 102.3 and 0 <= v['cog'] < 360 and 0 <= now-v['_updated'] <= MAX_AGE)


def velocity(ship):
    angle=math.radians(ship['cog'])
    return ship['sog']*math.sin(angle)/3600, ship['sog']*math.cos(angle)/3600


def xy(lat, lng, origin):
    dlon=(lng-origin['lng']+180)%360-180
    return dlon*60*math.cos(math.radians(origin['lat'])), (lat-origin['lat'])*60


def point(ship, seconds, origin):
    vx,vy=velocity(ship)
    x,y=ship['x_nm']+vx*seconds,ship['y_nm']+vy*seconds
    return {'t_s':seconds,'x_nm':x,'y_nm':y,'lat':origin['lat']+y/60,
            'lng':(origin['lng']+x/(60*math.cos(math.radians(origin['lat'])))+180)%360-180}


def capture(pair, vessels=None, now=None):
    now=time.time() if now is None else now
    if len(pair)!=2 or pair[0]==pair[1]:
        raise ValueError('서로 다른 선박 두 척을 선택하세요.')
    if vessels is None:
        with ais_stream._vessels_lock:
            vessels=[dict(v,mmsi=k) for k,v in ais_stream._vessels.items()]
    by_id={int(v['mmsi']):v for v in vessels}
    if any(m not in by_id or not valid(by_id[m],now) for m in pair):
        raise ValueError('선택 선박의 위치·속력·방향이 없거나 수신 후 60초가 지났습니다. 최신 수신 후 다시 시도하세요.')
    origin={k:by_id[pair[0]][k] for k in ('lat','lng')}
    if math.hypot(*xy(by_id[pair[1]]['lat'],by_id[pair[1]]['lng'],origin))>20:
        raise ValueError('첫 버전은 선박 간 거리 20해리 이내에서 비교할 수 있습니다.')
    selected=[by_id[m] for m in pair]
    context=[]; excluded=0
    for v in vessels:
        if int(v['mmsi']) in pair:continue
        try:
            distances=[math.hypot(*xy(v['lat'],v['lng'],s)) for s in selected]
            if not math.isfinite(min(distances)) or min(distances)>CONTEXT_NM:continue
        except (KeyError,TypeError,ValueError):continue
        if not valid(v,now):excluded+=1;continue
        context.append((min(distances),v))
    context.sort(key=lambda item:item[0])
    omitted=max(0,len(context)-MAX_NEIGHBORS)
    ships=[]
    for v in selected+[v for _,v in context[:MAX_NEIGHBORS]]:
        x,y=xy(v['lat'],v['lng'],origin);vx,vy=velocity(v);age=now-v['_updated']
        ships.append({'mmsi':int(v['mmsi']),'name':v.get('name') or str(v['mmsi']),'type':v.get('type','other'),
                      'sog':v['sog'],'cog':v['cog'],'received_at':stamp(v['_updated']),
                      'source_lat':v['lat'],'source_lng':v['lng'],
                      'x_nm':x+vx*age,'y_nm':y+vy*age})
    return {'id':str(uuid4()),'created_at':stamp(now),'model':MODEL,'pair':pair,'origin':origin,'ships':ships,
            'coverage':{'radius_nm':CONTEXT_NM,'included':len(ships)-2,'stale_or_invalid':excluded,'capacity_omitted':omitted,
                        'assessment':'partial','note':'수신된 AIS 중 주변 10해리·최대 50척만 확인합니다. 미수신 선박과 범위 밖에서 진입하는 선박은 평가하지 못합니다.'},
            'assumptions':['로컬 수신 시각을 기준으로 동일 시점까지 등속 투영합니다. 실제 센서 관측 시각과 다를 수 있습니다.',
                           '변경 속력·방향은 시뮬레이션 시작 시 즉시 적용되고 이후 일정합니다.',
                           '선회·제동 성능, 해안·수심·항법규칙·기상 영향은 계산하지 않습니다. 운항 지시가 아닌 가정 비교입니다.']}


def closest(a,b,horizon,origin):
    av,bv=velocity(a),velocity(b)
    rx,ry=b['x_nm']-a['x_nm'],b['y_nm']-a['y_nm']
    vx,vy=bv[0]-av[0],bv[1]-av[1];vv=vx*vx+vy*vy
    t=-(rx*vx+ry*vy)/vv if vv>1e-16 else None
    bounded=0 if t is None else max(0,min(horizon,t))
    d=math.hypot(rx+vx*bounded,ry+vy*bounded)
    return {'closest_distance_nm':d,'closest_time_s':bounded,'tcpa_min':t/60 if t is not None else None,
            'dcpa_nm':math.hypot(rx+vx*t,ry+vy*t) if t is not None and t>=0 else None,
            'within_horizon':t is not None and 0<=t<=horizon,'a':point(a,bounded,origin),'b':point(b,bounded,origin)}


def compare(snapshot, target, speed, course, minutes, turn_seconds=0, speed_seconds=0):
    if snapshot.get('model')!=MODEL:raise ValueError('지원하지 않는 스냅샷 모델입니다.')
    if target not in snapshot['pair']:raise ValueError('비교 대상 두 척 중 변경할 선박을 선택하세요.')
    if not all(math.isfinite(v) for v in (speed,course,minutes)) or not (0<=speed<=50 and 0<=course<360 and 5<=minutes<=30):
        raise ValueError('속력 0~50kt, 진행방향 0~360도 미만, 비교 시간 5~30분을 입력하세요.')
    if any(isinstance(v,bool) or not isinstance(v,int) or not 0<=v<=300 for v in (turn_seconds,speed_seconds)):
        raise ValueError('선회·속력 변경 시간은 0~300초 정수로 입력하세요.')
    horizon=minutes*60;steps=list(range(0,int(horizon),10))+[horizon]
    result={'id':str(uuid4()),'created_at':stamp(time.time()),'snapshot':snapshot,'model':MODEL,
            'change':{'mmsi':target,'sog':speed,'cog':course},'horizon_s':horizon,'scenarios':{}}
    for key in ('baseline','alternative'):
        ships=[dict(v) for v in snapshot['ships']]
        if key=='alternative':
            for v in ships:
                if v['mmsi']==target:v.update(sog=speed,cog=course)
        by_id={s['mmsi']:s for s in ships};a,b=[by_id[m] for m in snapshot['pair']]
        nearby=[]
        for subject in (a,b):
            for other in ships[2:]:
                metric=closest(subject,other,horizon,snapshot['origin'])
                nearby.append({'subject':subject['mmsi'],'other':other['mmsi'],'name':other['name'],
                               'distance_nm':metric['closest_distance_nm'],'time_s':metric['closest_time_s']})
        nearby.sort(key=lambda r:r['distance_nm'])
        result['scenarios'][key]={'pair':closest(a,b,horizon,snapshot['origin']),
            'nearby':nearby[:10], 'nearby_under_05nm':sum(r['distance_nm']<.5 for r in nearby),
            'tracks':{str(v['mmsi']):{'ship':v,'points':[point(v,t,snapshot['origin']) for t in steps]} for v in ships}}
    if turn_seconds or speed_seconds:
        from backend.services.scenario_maneuver import apply
        return apply(result,turn_seconds,speed_seconds)
    return result


class Repository:
    def __init__(self,path=None):self.path=Path(path or config.SCENARIO_DB)
    def connect(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        db=sqlite3.connect(self.path,timeout=10)
        db.execute('CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT,created_at TEXT,body TEXT)')
        return db
    def save(self,kind,record):
        db=self.connect()
        try:
            with db:db.execute('INSERT INTO records VALUES(?,?,?,?)',(record['id'],kind,record['created_at'],json.dumps(record,ensure_ascii=False,allow_nan=False)))
        finally:db.close()
        return record
    def get(self,kind,rid):
        db=self.connect()
        try:row=db.execute('SELECT body FROM records WHERE kind=? AND id=?',(kind,rid)).fetchone()
        finally:db.close()
        if not row:raise KeyError(rid)
        return json.loads(row[0])
    # 목록에 선박명을 실어야 "언제" 뿐 아니라 "어느 쌍"인지 고를 수 있다.
    # 기록 하나가 1MB 를 넘으므로(10초 간격 항적 표본) body 를 파이썬으로 끌어오지
    # 않고 SQLite 안에서 필요한 필드만 뽑는다. 20건이면 24MB 파싱 대 문자열 몇 개다.
    _RECENT_SQL=("SELECT id,created_at,"
                 "json_extract(body,'$.snapshot.ships[0].name'),"
                 "json_extract(body,'$.snapshot.ships[1].name'),"
                 "json_extract(body,'$.snapshot.ships[0].mmsi'),"
                 "json_extract(body,'$.snapshot.ships[1].mmsi'),"
                 "json_extract(body,'$.change.mmsi') "
                 "FROM records WHERE kind='run' ORDER BY created_at DESC LIMIT 20")
    _RECENT_FALLBACK="SELECT id,created_at FROM records WHERE kind='run' ORDER BY created_at DESC LIMIT 20"

    def recent(self):
        db=self.connect()
        try:
            try:rows=db.execute(self._RECENT_SQL).fetchall()
            except sqlite3.OperationalError:
                # JSON1 없는 SQLite 빌드 — 이름만 빠지고 목록은 그대로 동작한다.
                rows=[(r[0],r[1],None,None,None,None,None) for r in db.execute(self._RECENT_FALLBACK)]
        finally:db.close()
        out=[]
        for rid,created,name_a,name_b,mmsi_a,mmsi_b,changed in rows:
            names=[n for n in (name_a,name_b) if n]
            changed_name=name_a if changed is not None and changed==mmsi_a else name_b if changed is not None and changed==mmsi_b else None
            out.append({'id':rid,'created_at':created,'ships':names,'changed':changed_name})
        return out
