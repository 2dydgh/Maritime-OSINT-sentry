import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {summary,timeline,skipped}=require('../../static/js/investigation-view.js');

test('stored observation age is measured at investigation time, not current time',()=>{
 const s=summary({tool:'inspect_current',data:{proposal_status:'open',checked_at:1000,error:'vessel_stale',subjects:[{mmsi:123,_updated:900}]}});
 assert(s.rows.some(([,v])=>v.includes('100초 경과')));
 assert(s.notes.some(n=>n.includes('수신 시각이 오래')));
 assert(!s.rows.some(([k])=>k==='예상 최근접거리'));
});
test('missing CPA is not displayed as zero or safe',()=>{
 const s=summary({tool:'recalculate_cpa',data:{available:true,dcpa_nm:null,tcpa_min:null}});
 assert(s.rows.some(([k,v])=>k==='예상 최근접거리'&&v==='확인 불가 nm'));
 assert(!s.notes.some(n=>n.includes('안전')));
});
test('knowledge summary distinguishes graph validation and gaps',()=>{
 const s=summary({tool:'query_knowledge',data:{validation:{conforms:false},graph:{nodes:[{}],edges:[]},claims:[],gaps:['원본 관측 누락'],graph_truncated:true}});
 assert(s.rows.some(([k,v])=>k==='기록 형식·연결 검사'&&v==='추가 확인 필요'));
 assert(s.notes.includes('원본 관측 누락'));
 assert(s.notes.some(n=>n.includes('조회 범위')));
});
test('comparison summary preserves replay reference and hypothetical limits',()=>{
 const s=summary({tool:'compare_scenario',data:{run_id:'run-1',baseline:{pair:{closest_distance_nm:.25}},alternative:{pair:{closest_distance_nm:.5}},note:'가정 비교입니다.'}});
 assert.equal(s.runId,'run-1');assert(s.notes.includes('가정 비교입니다.'));
 assert(s.rows.some(([k,v])=>k==='기준안 최소 거리'&&v==='0.25 nm'));
});
test('timeline pairs each start and completion while retaining repeated checks',()=>{
 const events=[{tool:'inspect_current',state:'started',at:'a'},{tool:'inspect_current',state:'completed',at:'b',evidence_id:'e1'},{tool:'inspect_current',state:'started',at:'c'},{tool:'inspect_current',state:'completed',at:'d',evidence_id:'e2'},{tool:'query_knowledge',state:'started',at:'e'}];
 const rows=timeline(events);assert.equal(rows.length,3);assert.equal(rows[0].evidence_id,'e1');assert.equal(rows[1].evidence_id,'e2');assert.equal(rows[2].state,'started');assert.equal(events[0].state,'started');
});

test('skipped CPA and scenario tools are explained, not left silently missing',()=>{
 // 운영 기록(조사 1dfeab6b): 관측 지연으로 결론이 나자 서버가 계산 도구를 막았는데,
 // 화면은 그 사실을 말하지 않아 운용자가 고장으로 읽었다.
 const ran=[{tool:'inspect_current'},{tool:'query_knowledge'},{tool:'validate_result'}];
 const note=skipped(ran,{action:'check_observations',reason:'data_insufficient'});
 assert(note.includes('CPA 재계산')&&note.includes('가정 시나리오 비교'));
 assert(note.includes('오래'));
});
test('no skip note when tracking is recommended or tools actually ran',()=>{
 assert.equal(skipped([],{action:'focus_tracking',reason:'risk_persists'}),'');
 assert.equal(skipped([{tool:'recalculate_cpa'},{tool:'compare_scenario'}],{action:'no_new_action',reason:'criteria_not_met'}),'');
 assert.equal(skipped([{tool:'inspect_current'}],null),'','결과가 없으면(조사 중·실패) 이유를 단정하지 않는다');
});
