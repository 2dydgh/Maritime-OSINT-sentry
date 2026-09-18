import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createStore}=require('../../static/js/watch-officer.js');
const record=(status='approved',revision=2)=>({id:'p1',status,revision,updated_at:'2026-09-14',execution:{id:'ex1'},pair:[1,2],trigger:{subjects:[{mmsi:1},{mmsi:2}]},rule:{version:'collision-watch-v2'},events:[]});
const response=data=>({ok:true,json:async()=>data});

test('approval must commit before dispatch, then record start',async()=>{
 const calls=[];
 const store=createStore({clientId:'tab',fetchFn:async(url,opts)=>{
   calls.push(url.endsWith('decision')?'approve':'receipt');
   return response(url.endsWith('decision')?{proposal:record(),execute:true}:record('tracking',3));
 },dispatchFn:()=>{calls.push('dispatch');return true;},stopFn:()=>{},isTrackingFn:()=>true});
 await store.approve('p1');
 assert.deepEqual(calls,['approve','dispatch','receipt']);
 assert.equal(store.activeId(),'p1');
});

test('HTTP failure or expired approval never dispatches',async()=>{
 for(const reply of [{ok:false,status:409},response({proposal:record('expired'),execute:false})]){
  let executed=0;
  const store=createStore({clientId:'tab',fetchFn:async()=>reply,dispatchFn:()=>++executed,stopFn:()=>{}});
  await assert.rejects(store.approve('p1'));assert.equal(executed,0);
 }
});

test('double click issues one decision request',async()=>{
 let resolve,calls=0,executed=0;
 const pending=new Promise(r=>resolve=r);
 const store=createStore({clientId:'tab',fetchFn:async(url)=>{calls++;return url.endsWith('decision')?pending:response(record('tracking',3));},dispatchFn:()=>{executed++;return true;},stopFn:()=>{}});
 const first=store.approve('p1'); await store.approve('p1');
 resolve(response({proposal:record(),execute:true}));await first;
 assert.equal(calls,2);assert.equal(executed,1);
});

test('map failure records failed execution',async()=>{
 let outcome;
 const store=createStore({clientId:'tab',fetchFn:async(url,opts)=>{
  if(url.endsWith('decision'))return response({proposal:record(),execute:true});
  outcome=JSON.parse(opts.body).outcome;return response(record('failed',3));
 },dispatchFn:()=>{throw Error('map missing');},stopFn:()=>{}});
 await assert.rejects(store.approve('p1'),/map missing/);assert.equal(outcome,'failed');assert.equal(store.activeId(),null);
});

test('lost receipt retries acknowledgement without executing again',async()=>{
 let dispatched=0,receipts=0;
 const store=createStore({clientId:'tab',fetchFn:async(url)=>{
  if(url.endsWith('decision'))return response({proposal:record(),execute:true});
  if(url.endsWith('execution')){if(++receipts===1)throw Error('network');return response(record('tracking',3));}
  return response({proposals:[record('tracking',3)]});
 },dispatchFn:()=>{dispatched++;return true;},stopFn:()=>{},isTrackingFn:()=>true});
 await assert.rejects(store.approve('p1'),/network/);
 await store.load();assert.equal(dispatched,1);assert.equal(receipts,2);
});

test('terminal server state stops local tracking and ignores stale update',async()=>{
 let stopped=0;
 const store=createStore({clientId:'tab',fetchFn:async(url)=>response(url.endsWith('decision')?{proposal:record(),execute:true}:record('tracking',3)),dispatchFn:()=>true,stopFn:()=>stopped++});
 await store.approve('p1');store.receive(record('completed',4));store.receive(record('approved',2));
 assert.equal(stopped,1);assert.equal(store.all()[0].status,'completed');
});


test('legacy API schema is rejected before render; a later valid load recovers',async()=>{
 let notifications=0;
 const legacy={id:'old',status:'open',updated_at:'2026-09-14',trigger:{dcpa_nm:.1},subjects:[{mmsi:1},{mmsi:2}]};
 let payload={proposals:[record(),legacy]};
 const store=createStore({fetchFn:async()=>response(payload),stopFn:()=>{}});
 store.onChange(()=>notifications++);
 await assert.rejects(store.load(),/백엔드를 재시작/);
 assert.equal(notifications,0);assert.equal(store.all().length,0);
 payload={proposals:[record()]};await store.load();
 assert.equal(store.all().length,1);assert.equal(notifications,1);
});

test('missing subjects does not reach card rendering',()=>{
 const store=createStore({stopFn:()=>{}});
 const p=record();delete p.trigger.subjects;
 assert.throws(()=>store.receive(p),/데이터 형식/);
 assert.equal(store.all().length,0);
});

test('AI investigation reference is committed with human approval before map execution',async()=>{
 let body,executed=false;
 const store=createStore({clientId:'tab',fetchFn:async(url,opts)=>{
  if(url.endsWith('decision')){body=JSON.parse(opts.body);assert.equal(executed,false);return response({proposal:record(),execute:true});}
  return response(record('tracking',3));
 },dispatchFn:()=>{executed=true;return true;},stopFn:()=>{}});
 await store.approve('p1','검토했습니다','investigation-1');
 assert.equal(body.investigation_id,'investigation-1');assert.equal(body.reason,'검토했습니다');assert.equal(executed,true);
});

test('server validation detail is preserved for operator feedback',async()=>{
 const store=createStore({clientId:'tab',fetchFn:async()=>({ok:false,status:409,json:async()=>({detail:'승인 가능한 최신 조사 결과가 아닙니다. 다시 조사하세요.'})}),dispatchFn:()=>{throw Error('must not execute');},stopFn:()=>{}});
 await assert.rejects(store.approve('p1','검토','old-run'),/다시 조사하세요/);
});

// ── 브라우저 알림 판정 ──
const {notableAlerts,IMMINENT_TCPA_MIN,NOTIFY_REPEAT_MS}=require('../../static/js/watch-officer.js');
const prop=(id,dcpa,tcpa,extra={})=>({id,status:'open',pair:[id+'a',id+'b'],
  trigger:{source:'distance',dcpa_nm:dcpa,tcpa_min:tcpa,subjects:[{name:id+'A'},{name:id+'B'}]},...extra});

test('only the worst case and imminent cases ring; stale and closed cases never ring',()=>{
 const list=[prop('far',0.4,20),prop('worst',0.05,12),prop('soon',0.3,3),
   prop('stale',0.01,1,{stale:'vessel_stale'}),prop('closed',0.01,1,{status:'expired'})];
 const {alerts}=notableAlerts(list,{},0);
 const got=alerts.map(a=>a.kind+':'+a.id);
 assert.deepEqual(got,['imminent:soon','top:worst'],'관측 지연·닫힌 사건은 가장 위험해도 울리면 안 된다');
 assert.ok(alerts[0].title.includes('3.0분'),'임박 알림이 먼저 와서 제목이 된다');
});

test('the same pair does not ring again inside the repeat window, even if rank flaps',()=>{
 const a=prop('a',0.05,12), b=prop('b',0.10,12);
 let r=notableAlerts([a,b],{},0);                       // a 최상위
 assert.equal(r.alerts.length,1);
 r=notableAlerts([{...a,trigger:{...a.trigger,dcpa_nm:0.2}},b],r.seen,60_000); // b 가 최상위로
 assert.deepEqual(r.alerts.map(x=>x.id),['b']);
 r=notableAlerts([a,b],r.seen,120_000);                 // 다시 a — 10분 안이므로 조용
 assert.equal(r.alerts.length,0,'순위가 오가며 깜빡여도 같은 쌍은 한 번만 울린다');
 r=notableAlerts([a,b],r.seen,NOTIFY_REPEAT_MS+1);      // 창을 넘기면 다시 알린다
 assert.deepEqual(r.alerts.map(x=>x.id),['a']);
});

test('imminent threshold is inclusive and uses the server rank for top',()=>{
 const edge=prop('edge',0.9,IMMINENT_TCPA_MIN), ml={...prop('ml',0.5,15),trigger:{...prop('ml',0.5,15).trigger,source:'ml'}};
 const {alerts}=notableAlerts([edge,ml],{},0);
 assert.deepEqual(alerts.map(a=>a.kind+':'+a.id),['imminent:edge','top:ml'],'ML 고위험이 DCPA 보다 우선한다(서버 rank_key 와 동일)');
});

test('area of responsibility is stated so missing far-away cases are not read as a fault',()=>{
 const {aorText}=require('../../static/js/watch-officer.js');
 assert.equal(aorText([32,124,39.5,132]),'담당 해역 위도 32~39.5° · 경도 124~132°');
 assert.ok(aorText(null).includes('제한 없음'));
});
