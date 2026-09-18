/* Pure presentation of saved facts; no model-written claims or live-state inference. */
(function(root){
    'use strict';
    const tools={inspect_current:'현재 관측·사건 확인',query_knowledge:'연결된 판단 근거 조회',recalculate_cpa:'CPA 재계산',compare_scenario:'가정 시나리오 비교',validate_result:'근거·조치 조건 재확인',validate_rejected:'제안 검증 · 수정 필요'};
    const cases={open:'검토 대기',approved:'승인됨 · 추적 시작 확인 대기',tracking:'추적 중',dismissed:'기각됨',expired:'제안 만료',completed:'추적 종료',unknown:'추적·관측 상태 확인 필요',failed:'추적 실행 실패'};
    const errors={analysis_stale:'충돌 분석의 갱신이 지연됐습니다.',vessel_missing:'관련 선박의 관측을 찾지 못했습니다.',vessel_stale:'선박 관측의 수신 시각이 오래됐습니다.',vessel_invalid:'선박 위치·속력·방향 자료가 유효하지 않습니다.',risk_changed:'이번 확인에서 기존 추적 제안 조건을 충족하지 않았습니다.',fresh_observations_required:'최신 선박 관측이 있어야 다시 계산할 수 있습니다.'};
    const time=v=>v==null?'기록 없음':new Date(typeof v==='number'?v*1000:v).toLocaleString('ko-KR');
    const number=v=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(2):'확인 불가';
    function summary(e){
        const d=e.data||{},rows=[],notes=[];
        const row=(label,value)=>rows.push([label,String(value??'기록 없음')]);
        if(e.tool==='inspect_current'||e.tool==='validate_result'){
            row('조사 당시 사건 상태',cases[d.proposal_status]||d.proposal_status);
            row('확인 시각',time(d.checked_at));
            const check=d.approval_check;
            if(check){row('예상 최근접거리',number(check.dcpa_nm)+' nm');row('예상 최근접까지',number(check.tcpa_min)+'분');}
            notes.push(d.error?(errors[d.error]||'현재 자료를 추가 확인해야 합니다.'):'확인 당시 집중 추적 제안 조건을 충족했습니다.');
            (d.subjects||[]).forEach(v=>{
                const age=typeof v._updated==='number'&&typeof d.checked_at==='number'?d.checked_at-v._updated:null;
                row('선박 '+v.mmsi+' 수신',time(v._updated)+(age!=null&&age>=0?' · 확인 당시 '+Math.floor(age)+'초 경과':''));
            });
        }else if(e.tool==='query_knowledge'){
            row('기록 형식·연결 검사',d.validation?.conforms?'통과':'추가 확인 필요');
            row('관련 기록',(d.graph?.nodes?.length??0)+'건');row('정보 간 연결',(d.graph?.edges?.length??0)+'개');
            (d.claims||[]).forEach(c=>notes.push(c.text));(d.gaps||[]).forEach(g=>notes.push(g));
            if(d.graph_truncated)notes.push('일부 관계는 이번 조회 범위에서 제외됐습니다.');
        }else if(e.tool==='recalculate_cpa'){
            row('계산 방식','기존 CPA 계산');row('계산 시각',time(d.checked_at));
            if(d.available){row('예상 최근접거리',number(d.dcpa_nm)+' nm');row('예상 최근접까지',number(d.tcpa_min)+'분');}
            notes.push(d.available?'최신 수신 위치·속력·방향으로 계산한 값입니다.':(errors[d.error]||'계산에 필요한 자료가 부족합니다.'));
        }else if(e.tool==='compare_scenario'){
            row('시나리오 시작',time(d.snapshot_at));
            if(d.run_id){row('기준안 최소 거리',number(d.baseline?.pair?.closest_distance_nm)+' nm');row('변경안 최소 거리',number(d.alternative?.pair?.closest_distance_nm)+' nm');row('함께 확인한 주변 선박',(d.coverage?.included??0)+'척');}
            notes.push(d.note||d.error||'비교 결과가 없습니다.');
            if(d.coverage?.note)notes.push(d.coverage.note);
        }else if(e.tool==='validate_rejected')notes.push(d.detail||'근거와 조치 조건을 다시 확인해야 합니다.');
        else notes.push('아래 원본 기록에서 상세 정보를 확인할 수 있습니다.');
        if(d.available===false&&d.error&&!notes.includes(d.error))notes.push(errors[d.error]||d.error);
        return {title:tools[e.tool]||'조사 근거',rows,notes:[...new Set(notes)],runId:d.run_id};
    }
    function timeline(events){
        const rows=[];
        for(const event of events){
            const previous=rows[rows.length-1];
            if(event.state==='completed'&&previous?.tool===event.tool&&previous.state==='started'){
                Object.assign(previous,event,{started_at:previous.at});
            }else rows.push({...event});
        }
        return rows;
    }
    /* '실행한 확인 작업' 목록에 CPA 재계산·시나리오 비교가 없으면 운용자는 고장인지 의도인지
       알 수 없다. 서버는 현재 상태만으로 결론(permitted_recommendation)을 정하고, 결론이
       집중 추적이 아니면 남은 계산 도구를 막는다(prepare) — 계산해도 결론이 바뀌지 않기
       때문이다. 그 사실을 이유와 함께 말해준다. 이유 문구는 서버 reason 과 1:1 로 맞춘다. */
    const skipReasons={
        data_insufficient:'관측·분석 자료가 오래됐거나 없어서, 지금 계산하면 믿을 수 없는 값이 나옵니다. 새 관측이 들어온 뒤 다시 조사하세요.',
        already_active:'이미 승인·추적 중인 사건이라 새 추적을 판단할 계산이 필요 없습니다.',
        criteria_not_met:'최신 자료가 제안 조건을 충족하지 않아, 추가 계산이 결론을 바꾸지 않습니다.',
        record_needs_review:'기록의 연결·상태를 사람이 먼저 확인해야 해서 계산보다 기록 검토가 우선입니다.'};
    function skipped(events,result){
        if(!result||result.action==='focus_tracking')return '';
        const ran=new Set((events||[]).map(e=>e.tool));
        const missing=['recalculate_cpa','compare_scenario'].filter(t=>!ran.has(t)).map(t=>tools[t]);
        if(!missing.length)return '';
        return missing.join('·')+'는 실행하지 않았습니다. '+(skipReasons[result.reason]||'이번 결론에는 추가 계산이 필요하지 않았습니다.');
    }
    root.InvestigationView={tools,cases,errors,time,number,summary,timeline,skipped};
    if(typeof module!=='undefined')module.exports=root.InvestigationView;
})(typeof window==='undefined'?globalThis:window);
