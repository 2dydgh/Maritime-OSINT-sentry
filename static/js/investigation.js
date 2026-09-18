/* Event-scoped investigation, readable evidence, and operator follow-through. */
(function () {
    'use strict';
    const view=window.InvestigationView;
    const statuses={queued:'조사 준비',running:'조사 중',completed:'조사 완료',failed:'조사 실패',cancelled:'취소됨',interrupted:'중단됨',timed_out:'시간 초과'};
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let activeClose;
    const drafts=new Map();
    function open(pid){
        activeClose?.();
        const previous=document.activeElement,dialog=document.createElement('dialog');
        dialog.className='investigation-dialog';dialog.setAttribute('aria-label','사건 검토');
        dialog.innerHTML=`<header><div><h2>사건 검토</h2><p data-i="pair"></p><p data-i="case"></p></div><button data-i="close">제안 목록으로 ×</button></header>
        <ol class="decision-steps" aria-label="사건 처리 순서"><li aria-current="step">사건 검토</li><li>승인·기각</li><li>승인 후 확인</li></ol>
        <p class="investigation-intro">먼저 AI로 현재 관측과 근거를 확인하세요. 결과를 읽고 집중 추적 여부를 판단합니다.</p>
        <div class="investigation-controls"><button data-i="start">AI로 현재 상태 확인</button><button data-i="cancel" hidden>조사 취소</button><label>이전 조사 <select data-i="history" aria-label="저장된 조사 선택"><option value="">기록 없음</option></select></label></div>
        <p data-i="status" role="status">저장된 조사를 확인합니다.</p><p data-i="error" role="alert"></p><p data-i="connection" role="status"></p>
        <section data-i="result"><h3>조사 결과</h3><p>조사를 시작하면 권장 조치와 확인된 근거가 여기에 표시됩니다.</p></section>
        <aside class="investigation-optional" data-i="comparison" hidden><div><h3>다른 조건도 비교하고 싶다면 <small>선택</small></h3><p>한 선박의 속력·침로를 바꿨다고 가정해 거리와 주변 영향을 비교합니다. 비교 없이도 조사 결과를 검토할 수 있습니다.</p></div><button data-i="compare">속력·침로 조건 비교</button></aside>
        <section data-i="source" hidden tabindex="-1"><h3 data-i="source-title"></h3><p class="investigation-hint">아래 내용은 선택한 조사의 저장 기록입니다.</p><div data-i="summary"></div><details><summary>원본 데이터 보기</summary><pre data-i="raw"></pre></details></section>
        <section class="investigation-activity"><h3>실행한 확인 작업</h3><p class="investigation-hint">AI가 결론을 내리기 전에 서버에서 실제로 실행한 확인입니다. 권장 조치는 이 결과에만 근거하며, 각 항목의 <strong>확인 결과</strong>에서 그때 본 원자료를 볼 수 있습니다. 창을 닫아도 조사는 계속되고, 중단하려면 조사 취소를 누르세요.</p><ol data-i="events" class="investigation-events"></ol><p data-i="skipped" class="investigation-skipped" hidden></p></section>`;
        document.body.appendChild(dialog);dialog.showModal();
        const $=name=>dialog.querySelector('[data-i="'+name+'"]');
        let disposed=false,current=null,proposal=null,timer,busy=false,signature='',eventSignature='',generation=0;
        const controllers=new Set();
        const ticker=setInterval(()=>{if(!disposed&&current?.result)actions();},1000);
        function close(){if(current&&$('reason'))drafts.set(pid,{id:current.id,reason:$('reason').value});disposed=true;generation++;clearTimeout(timer);clearInterval(ticker);controllers.forEach(c=>c.abort());dialog.remove();const focus=previous?.isConnected?previous:document.querySelector('.proposal-card[data-id="'+CSS.escape(pid)+'"] [data-act="investigate"]');focus?.focus();if(activeClose===close)activeClose=null;}
        activeClose=close;$('close').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
        async function request(path,method='GET'){
            const controller=new AbortController();controllers.add(controller);
            const timeout=setTimeout(()=>controller.abort(),12000);
            try{const response=await fetch('/api/v1/'+path,{method,signal:controller.signal});const body=await response.json();if(!response.ok)throw Error(typeof body.detail==='string'?body.detail:'요청을 처리하지 못했습니다.');return body;}
            finally{clearTimeout(timeout);controllers.delete(controller);}
        }
        function actions(){
            const running=current&&['queued','running'].includes(current.status);
            $('start').disabled=busy||running;$('start').textContent=running?'AI가 확인 중입니다':current?'최신 상태 다시 조사':'AI로 현재 상태 확인';
            $('comparison').hidden=(current?.case?.status||proposal?.status)!=='open';
            $('compare').disabled=busy||!(current?.pair||proposal?.pair);
            $('cancel').hidden=!running;$('cancel').disabled=busy;$('history').disabled=busy;
            const c=current?.case||proposal;
            dialog.querySelector('.investigation-intro').textContent=c?.decision?.outcome==='approved'?'집중 추적을 승인한 사건입니다. 판단 기록과 이후 관측·추적 상태를 확인하세요.':current?.result?'조사 결과와 근거를 읽고 다음 행동을 확인하세요. 조건 비교는 필요할 때 선택합니다.':'먼저 AI로 현재 관측과 근거를 확인하세요. 결과를 읽고 집중 추적 여부를 판단합니다.';
            // 승인 창은 확인 후 60초. 남은 시간을 보여주지 않으면 이유를 타이핑하는 도중
            // 버튼이 말없이 죽는다 — ticker 가 1초마다 actions() 를 다시 돌려 카운트다운한다.
            const remain=Math.ceil(60-(Date.now()/1000-(current?.result?.validated_at||0)));
            const expired=!!c?.approval_expired||remain<=0;
            $('start').classList.toggle('is-primary',!c?.decision?.at&&(!current?.result||current.result.action!=='focus_tracking'||expired));
            for(const outcome of ['approved','dismissed']){
                const b=dialog.querySelector('[data-decision="'+outcome+'"]');
                if(b)b.disabled=busy||!(outcome==='approved'?c?.can_approve:c?.can_dismiss)||(outcome==='approved'&&expired);
            }
            const expiry=$('expiry');
            if(expiry){
                expiry.classList.toggle('is-expired',expired);
                expiry.textContent=expired?'승인 유효 시간이 지났습니다. 최신 상태 다시 조사를 눌러 확인하세요. 기각은 계속 기록할 수 있습니다.'
                    :`승인 가능 시간 ${remain}초 남음 · 승인 시 최신 위험을 다시 확인합니다.`;
            }
        }
        function render(r){
            if(current?.id!==r.id){$('source').hidden=true;$('raw').textContent='';signature='';eventSignature='';}
            current=r;
            const c=r.case||{},result=r.result;
            const stage=c.decision?.outcome==='approved'?2:result?.action==='focus_tracking'&&c.status==='open'?1:0;
            dialog.querySelectorAll('.decision-steps li').forEach((el,i)=>{if(i===stage)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
            $('pair').textContent=(c.names||r.pair).join(' ↔ ');
            $('case').textContent='현재 사건 · '+(view.cases[c.status]||'확인 중');
            const option=Array.from($('history').options).find(o=>o.value===r.id);if(option)option.textContent=view.time(r.created_at)+' · '+(statuses[r.status]||r.status);
            $('status').textContent=`${statuses[r.status]||r.status} · ${view.time(r.created_at)} 시작 · ${r.message}`;
            const eventsKey=JSON.stringify(r.events);
            if(eventSignature!==eventsKey){eventSignature=eventsKey;const skip=view.skipped(r.events,r.result);$('skipped').textContent=skip;$('skipped').hidden=!skip;$('events').innerHTML=view.timeline(r.events).map(e=>`<li class="${e.state==='completed'?'is-done':''}"><span>${esc(view.tools[e.tool]||e.tool)}</span><small>${esc(view.time(e.at))} · ${e.state==='completed'?'완료':'진행 중'}</small>${e.evidence_id?`<button data-source="${esc(e.evidence_id)}">확인 결과</button>`:''}</li>`).join('')||'<li>아직 실행한 확인 작업이 없습니다.</li>';}
            const key=[r.id,r.status,c.status,c.decision?.at,c.decision_investigation_id].join(':');
            if(signature===key){actions();return;}signature=key;
            if(!result){$('result').innerHTML=`<h3>조사 결과</h3><p>${esc(r.message)}</p>${['failed','cancelled','interrupted','timed_out'].includes(r.status)?'<p>완료된 확인 작업의 근거는 아래에 남아 있습니다. 필요한 경우 다시 조사하세요.</p>':''}`;actions();return;}
            const facts=result.facts.data,check=facts.approval_check,evidence=result.evidence_ids.map(id=>r.evidence[id]).filter(Boolean);
            const next=nextAction(r);
            $('result').innerHTML=`<div class="investigation-conclusion"><h3>조사 당시 권장 조치</h3><p class="investigation-action">${esc(result.action_label)}</p><p>${esc(result.explanation)}</p><small>${esc(view.time(result.validated_at))} 확인 · 현재 사건 상태는 상단에 표시합니다.</small></div>
              <div class="investigation-facts"><strong>확인한 사실</strong><p>${check?`예상 최근접거리 ${view.number(check.dcpa_nm)} nm · ${view.number(check.tcpa_min)}분 뒤` : esc(view.errors[facts.error]||'현재 집중 추적 조건을 추가로 확인해야 합니다.')}</p><button data-source="${esc(result.facts.id)}">관측·분석 상태 확인</button></div>
              <section class="investigation-next"><h3>${c.decision?.at?'기록된 판단과 다음 행동':'집중 추적 여부 판단'}</h3>${next}</section>
              <h3>이 제안의 근거</h3><div class="investigation-links">${evidence.map(e=>`<button data-source="${esc(e.id)}">${esc(view.tools[e.tool]||e.tool)}</button>`).join('')}<button data-knowledge>연결된 판단 기록</button></div>
              ${result.gaps.length?'<details class="investigation-gaps"><summary>확인할 점 '+result.gaps.length+'건</summary><ul>'+result.gaps.map(g=>'<li>'+esc(g)+'</li>').join('')+'</ul></details>':''}`;
            const draft=drafts.get(pid);if(draft?.id===r.id&&$('reason'))$('reason').value=draft.reason;
            actions();
        }
        function nextAction(r){
            const c=r.case||{},d=c.decision||{},result=r.result;
            if(d.at){return `<p><strong>${d.outcome==='approved'?'승인':'기각'} 기록</strong> · ${esc(view.time(d.at))}</p><p>${esc(d.reason)}</p><p class="investigation-hint">${c.decision_investigation_id===r.id?'이 조사를 참고해 내린 판단입니다.':'다른 조사 또는 제안 화면에서 기록된 판단입니다.'}</p>${d.outcome==='approved'?'<button data-followup>이후 관측·추적 상태 확인</button>':'<p>필요한 경우 다시 조사해 상황 변화를 확인하세요.</p>'}`;}
            if(c.status!=='open')return '<p>현재 사건은 '+esc(view.cases[c.status]||'추가 확인 상태')+'입니다. 과거 조사 결과로 새 추적을 승인할 수 없습니다. 제안 목록에서 현재 검토 가능한 사건을 확인하세요.</p>';
            if(result.action==='focus_tracking')return `<div class="investigation-decision"><p>승인하면 지도에서 두 선박을 집중 추적합니다. 시나리오의 감속·선회를 실제 선박에 지시하는 기능은 아닙니다.</p><label>판단 이유<textarea data-i="reason" maxlength="500" placeholder="근거를 검토한 뒤 판단 이유를 입력하세요."></textarea></label><button data-decision="approved">집중 추적 승인</button><button data-decision="dismissed">기각</button><p data-i="expiry" class="investigation-hint"></p></div>`;
            if(result.action==='check_observations')return '<p>새 관측이나 분석이 들어온 뒤 <strong>최신 상태 다시 조사</strong>를 누르세요. 아래 근거에서 어떤 자료가 지연됐는지 확인할 수 있습니다.</p>';
            if(result.action==='continue_monitoring')return '<button data-followup>기존 추적의 후속 상태 확인</button>';
            return '<p>근거와 사건 상태를 검토하세요. 새로운 관측이 들어오면 최신 상태를 다시 조사할 수 있습니다.</p>';
        }
        function schedule(){clearTimeout(timer);if(!disposed)timer=setTimeout(poll,2000);}
        async function poll(){
            if(disposed)return;
            if(!current||busy){schedule();return;}
            const id=current.id,g=generation;
            try{const r=await request('investigations/'+encodeURIComponent(id));if(!disposed&&g===generation){render(r);$('connection').textContent='';}}
            catch(e){if(!disposed&&g===generation)$('connection').textContent='상태 갱신 실패: '+e.message;}
            finally{schedule();}
        }
        async function history(selected){
            const g=generation,data=await request('investigations/proposals/'+encodeURIComponent(pid));if(disposed||g!==generation)return;
            $('history').innerHTML=data.investigations.map(r=>`<option value="${esc(r.id)}">${esc(view.time(r.created_at))} · ${esc(statuses[r.status])}</option>`).join('')||'<option value="">기록 없음</option>';
            const r=data.investigations.find(r=>r.id===selected)||data.investigations[0];
            if(r){$('history').value=r.id;render(r);schedule();}else $('status').textContent='아직 조사 기록이 없습니다. AI로 현재 상태 확인을 눌러주세요.';
        }
        async function action(fn){if(busy)return;busy=true;generation++;actions();$('error').textContent='';try{await fn();}catch(e){if(!disposed)$('error').textContent=e.message;}finally{busy=false;if(!disposed){actions();schedule();}}}
        $('start').onclick=()=>action(async()=>{clearTimeout(timer);const r=await request('investigations/proposals/'+encodeURIComponent(pid),'POST');if(disposed)return;render(r);await history(r.id);});
        $('cancel').onclick=()=>action(async()=>{if(!current)return;const r=await request('investigations/'+encodeURIComponent(current.id)+'/cancel','POST');if(!disposed)render(r);});
        $('history').onchange=()=>action(async()=>{const r=await request('investigations/'+encodeURIComponent($('history').value));if(!disposed)render(r);});
        $('compare').onclick=()=>{const pair=current?.pair||proposal?.pair;if(!pair)return;close();window.CollisionScenarios.open(pair[0],pair[1],pid);};
        dialog.addEventListener('click',e=>{
            const source=e.target.closest('[data-source]');
            if(source){const item=current?.evidence[source.dataset.source]||(current?.result?.facts?.id===source.dataset.source?current.result.facts:null);if(!item)return;
                const s=view.summary(item);$('source-title').textContent=s.title;$('summary').innerHTML='<dl>'+s.rows.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl>'+s.notes.map(n=>'<p>'+esc(n)+'</p>').join('')+(s.runId?`<button data-run="${esc(s.runId)}">비교 재생</button>`:'');
                $('raw').textContent=JSON.stringify(item,null,2);$('source').hidden=false;$('source').scrollIntoView({block:'start'});$('source').focus({preventScroll:true});return;}
            const run=e.target.closest('[data-run]');if(run){close();window.CollisionScenarios.openSaved(run.dataset.run);return;}
            if(e.target.closest('[data-knowledge]')){close();window.KnowledgeEvidence.open(pid,'basis');return;}
            if(e.target.closest('[data-followup]')){close();window.DecisionFollowup.open(pid);return;}
            const decision=e.target.closest('[data-decision]');if(decision)action(async()=>{
                const reason=$('reason').value.trim();if(!reason)throw Error('판단 이유를 입력하세요.');
                const store=window.WatchOfficerUI?.store;if(!store)throw Error('제안 화면을 먼저 불러와 주세요.');
                await store[decision.dataset.decision==='approved'?'approve':'dismiss'](pid,reason,current.id);
                const r=await request('investigations/'+encodeURIComponent(current.id));if(!disposed)render(r);
            });
        });
        request('proposals/'+encodeURIComponent(pid)+'/record').then(p=>{if(disposed)return;proposal=p;if(!current){$('pair').textContent=p.trigger.subjects.map(s=>s.name||s.mmsi).join(' ↔ ');$('case').textContent='현재 사건 · '+(view.cases[p.status]||p.status);}actions();}).catch(e=>{if(!disposed)$('connection').textContent='사건 상태 확인 실패: '+e.message;});
        history().catch(e=>{if(!disposed)$('error').textContent=e.message;});
    }
    window.InvestigationUI={open};
})();
