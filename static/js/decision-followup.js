/* Review records are evidence, never vessel maneuver authorizations. */
(function () {
    'use strict';
    const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const number = value => value == null ? '—' : Number(value).toFixed(2);
    const stateNames = {not_started:'관측 시작 전',waiting:'새 AIS 수신 대기',fresh:'최근 AIS 수신 확인',stale:'수신 지연 · 현재 위험 확인 불가',ended:'관측 기간 종료 · 저장 기록'};
    const reviewNames = {reference:'참고안',deferred:'보류',rejected:'미채택'};
    async function request(path, body, signal) {
        const response=await fetch('/api/v1/proposals/'+path,{signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        const result=await response.json();
        if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'요청 값을 확인하세요.');
        return result;
    }
    function mount(host,pid,run,onTracks) {
        let disposed=false, loading=false, reviewId=crypto.randomUUID();
        const controller=new AbortController();
        const get=name=>host.querySelector('[data-fu="'+name+'"]');
        host.classList.add('decision-followup');
        host.innerHTML=`<h3>${run?'비교를 판단 근거로 남기기 · 선택':'승인 후 상태 확인'}</h3>${run?`<form data-fu="review"><p>이 비교를 참고할지 선택하고 이유를 남기세요. 기록한 뒤 사건 검토로 돌아가 집중 추적 여부를 판단합니다.</p><label>검토 결과<select data-fu="outcome"><option value="reference">참고안</option><option value="deferred">보류</option><option value="rejected">미채택</option></select></label><label>검토 이유<input data-fu="reason" required maxlength="500" placeholder="거리 변화와 주변 선박 영향을 검토한 이유"></label><button data-fu="save">검토 기록 저장</button></form>`:''}<p data-fu="message" role="status"></p>${run?'<details class="followup-optional"><summary>저장된 관측과 예측 비교 · 선택</summary>':'<p>지도 추적 상태와 관측의 신선도를 확인한 뒤, 두 선박 거리의 변화를 살펴보세요.</p>'}<p data-fu="tracking"></p><p data-fu="state">후속 관측을 불러옵니다…</p><div data-fu="latest"></div><div data-fu="trend"></div><div data-fu="errors"></div><details><summary>관측·예측 비교 기준</summary><p>검토 기록 이후에는 비교 시간까지, 집중 추적 승인 이후에는 30분간 수신 AIS를 주기적으로 기록합니다. 수신 시각이 같은 데이터는 중복 기록하지 않습니다. 녹색 관측 항적은 지도에 표시합니다.</p><p>로컬 수신 시각은 실제 관측 시각과 다를 수 있습니다. 변경안과 실제 위치의 차이는 변경안이 실행됐다는 증거가 아닙니다. CPA 규칙은 안전 판정이 아닙니다.</p></details>${run?'</details>':''}`;
        if(run){
            get('review').oninput=()=>{reviewId=crypto.randomUUID();};
            get('review').onsubmit=async event=>{
                event.preventDefault();get('save').disabled=true;
                try{
                    const result=await request(pid+'/scenario-reviews',{run_id:run.id,review_id:reviewId,outcome:get('outcome').value,reason:get('reason').value.trim(),client_id:window.WatchOfficerUI?.clientId || 'local-review'},controller.signal);
                    if(disposed)return;
                    window.WatchOfficerUI?.store.receive(result);
                    get('message').textContent='검토 이유를 저장했습니다. 아래 사건 검토로 돌아가 집중 추적 여부를 판단하세요.';
                    load();
                }catch(e){if(!disposed)get('message').textContent=e.message;}
                finally{if(!disposed)get('save').disabled=false;}
            };
        }
        async function load(){
            if(disposed||loading)return;loading=true;
            try{
                const [result,record]=await Promise.all([request(pid+'/followup'+(run?'?run_id='+encodeURIComponent(run.id):''),null,controller.signal),run?Promise.resolve(null):request(pid+'/record',null,controller.signal).catch(()=>null)]);
                if(disposed)return;
                if(!run)get('tracking').textContent=record?record.trigger.subjects.map(s=>s.name||s.mmsi).join(' ↔ ')+' · 추적 기록 상태: '+(window.InvestigationView?.cases[record.status]||record.status):'추적 기록 상태를 확인하지 못했습니다.';
                get('state').textContent=stateNames[result.state]+(result.latest?' · 기록 '+new Date(result.latest.at).toLocaleTimeString():'');
                const latest=result.latest,approved=result.approval_evidence;
                get('latest').innerHTML=latest?`<div class="followup-metrics"><span>선박 간 거리 <b>${number(latest.distance_nm)} nm</b></span><span>최근 DCPA <b>${number(latest.dcpa_nm)} nm</b></span><span>최근 TCPA <b>${number(latest.tcpa_min)}분</b></span></div><p>${result.state==='fresh'?(latest.risk_state==='high'?'CPA 주의 조건 유지':'CPA 주의 조건 미충족 · 안전 확정 아님'):'과거 관측값입니다. 현재 위험 상태로 해석하지 마세요.'}${approved?' · 승인 당시 DCPA '+number(approved.dcpa_nm)+' nm':''}</p>`:'<p>아직 기록된 관측이 없습니다. 검토 기록 또는 집중 추적 승인 이후 새 AIS 수신을 기다립니다.</p>';
                const obs=result.observations;
                if(obs.length>1){
                    const vals=obs.map(o=>o.distance_nm),max=Math.max(.1,...vals),start=Date.parse(obs[0].at),duration=Math.max(1,Date.parse(obs[obs.length-1].at)-start);
                    const points=obs.map(o=>`${10+(Date.parse(o.at)-start)/duration*480},${75-o.distance_nm/max*60}`).join(' ');
                    get('trend').innerHTML=`<svg viewBox="0 0 500 92" role="img" aria-label="관측 기간의 두 선박 간 거리 변화"><path d="M10 15V75H490" stroke="#49617e" fill="none"/><polyline points="${points}" fill="none" stroke="#67dcb0" stroke-width="2"/><text x="12" y="12">${max.toFixed(2)} nm</text><text x="10" y="90">${escape(new Date(obs[0].at).toLocaleTimeString())}</text><text x="390" y="90">${escape(new Date(obs[obs.length-1].at).toLocaleTimeString())}</text></svg>`;
                } else get('trend').replaceChildren();
                if(result.prediction_comparison){
                    const tracks=result.prediction_comparison.tracks;
                    get('errors').innerHTML='<h4>수신 위치와 예측 위치의 차이</h4><table><thead><tr><th>선박</th><th>기준 예측</th><th>변경 예측</th></tr></thead><tbody>'+Object.entries(tracks).map(([m,ps])=>{const p=ps[ps.length-1],ship=run.snapshot.ships.find(s=>String(s.mmsi)===m);return `<tr><td>${escape(ship?.name||m)}${p?' · +'+(p.t_s/60).toFixed(1)+'분':''}</td><td>${p?number(p.errors_nm.baseline)+' nm':'관측 대기'}</td><td>${p?number(p.errors_nm.alternative)+' nm':'관측 대기'}</td></tr>`;}).join('')+'</tbody></table><p>지도 녹색: 기록된 관측 항적 전체 · 위치 차이는 각 AIS 수신 시각의 예측과 비교합니다.</p>';
                    onTracks?.(tracks);
                }
            }catch(e){if(!disposed)get('state').textContent='후속 상태 조회 실패 · '+e.message;}
            finally{loading=false;}
        }
        load();const timer=setInterval(load,5000);
        return ()=>{disposed=true;clearInterval(timer);controller.abort();};
    }
    function open(pid){
        const previous=document.activeElement;
        const dialog=document.createElement('dialog');dialog.className='scenario-dialog';dialog.setAttribute('aria-label','승인 후 상태 확인');
        const close=document.createElement('button');close.textContent='닫기 ×';dialog.appendChild(close);
        const host=document.createElement('div');dialog.appendChild(host);document.body.appendChild(dialog);dialog.showModal();
        const dispose=mount(host,pid);const finish=()=>{dispose();dialog.remove();const focus=previous?.isConnected?previous:document.querySelector('.proposal-card[data-id="'+CSS.escape(pid)+'"] [data-act="followup"]');focus?.focus();};const back=document.createElement('button');back.textContent='사건 검토·판단 기록 보기';back.onclick=()=>{finish();window.InvestigationUI.open(pid);};dialog.appendChild(back);close.onclick=finish;dialog.oncancel=e=>{e.preventDefault();finish();};
    }
    window.DecisionFollowup={mount,open,reviewNames};
})();
