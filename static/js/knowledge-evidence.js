/* Fixed questions backed by RDF/SPARQL, with source records and explicit gaps. */
(function () {
    'use strict';
    const labels={why:'왜 추적 대상으로 판단했나?',basis:'판단 근거는 무엇인가?',after:'판단 이후 무엇이 달라졌나?'};
    const types={AgentInvestigation:'AI 조사',Proposal:'제안',Vessel:'선박',AISObservation:'수신 관측',AnalysisInputState:'과거 분석 입력',ProjectedState:'투영 상태',RiskAnalysis:'위험 분석',ScenarioComparison:'시나리오',Prediction:'가정 예측',Review:'검토',Decision:'판단',TrackingExecution:'실행 요청',ExecutionReceipt:'실행 영수증',FollowupAssessment:'후속 평가'};
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const descriptions={Vessel:'이 사건에 연결된 AIS 식별 대상입니다.',AISObservation:'선박의 위치·속력과 시스템이 수신한 시각을 기록했습니다.',AnalysisInputState:'분석에 사용했던 값입니다. 수신 시각이 없어 당시 AIS 관측으로 확인할 수 없습니다.',ProjectedState:'시뮬레이션의 시작 시점을 맞추기 위해 계산한 위치입니다.',RiskAnalysis:'제안 또는 승인 재확인에 사용된 분석 결과입니다.',Proposal:'위험 분석을 바탕으로 생성한 집중 추적 제안입니다.',ScenarioComparison:'가정한 침로·속력 조건을 비교한 기록입니다.',Prediction:'가정한 조건에서 계산한 예측이며 실제 관측이 아닙니다.',Review:'운용자가 시나리오 비교를 검토한 기록입니다.',Decision:'운용자가 남긴 승인·기각 결과와 이유입니다.',TrackingExecution:'승인에 따라 화면에서 집중 추적을 요청한 기록입니다.',ExecutionReceipt:'브라우저가 지도 추적의 시작·종료 등을 확인한 기록입니다.',FollowupAssessment:'판단 이후 수신된 관측을 바탕으로 확인한 상태입니다.',AgentInvestigation:'운용자가 판단할 때 참고한 AI 조사 결과입니다.'};
    const values={open:'검토 대기',approved:'승인됨',tracking:'추적 중',dismissed:'기각됨',expired:'제안 만료',failed:'실패',unknown:'확인 필요',completed:'완료',reference:'참고함',deferred:'보류',rejected:'채택하지 않음',high:'주의 조건 충족',focus_tracking:'집중 추적 제안',check_observations:'관측·분석 갱신 확인',continue_monitoring:'기존 추적 확인',operator_review:'운용자 검토 필요',no_new_action:'새 조치 제안 없음'};
    function displayValue(p){
        if(['저장 상태','판단·검토 결과'].includes(p.label))return values[p.value]||p.value;
        if(p.label.includes('시각')&&/^\d{4}-\d{2}-\d{2}T/.test(p.value))return new Date(p.value).toLocaleString();
        if(/\((해리|분|kt|도|초)\)$/.test(p.label)&&p.value!==''&&Number.isFinite(Number(p.value)))return Number(p.value).toLocaleString(undefined,{maximumFractionDigits:2});
        return p.value;
    }
    function properties(node){return node.properties.filter(p=>!['원본 제안 버전','비교 기록 ID','브라우저 세션 식별값 (미인증)'].includes(p.label));}
    const propertyList=items=>'<dl>'+items.map(p=>`<dt>${esc(p.label)}</dt><dd>${esc(displayValue(p))}</dd>`).join('')+'</dl>';
    let activeClose;
    function open(pid,initial='why') {
        activeClose?.();
        const previous=document.activeElement,dialog=document.createElement('dialog');
        dialog.className='knowledge-dialog';dialog.setAttribute('aria-label','사건 판단 근거');
        dialog.innerHTML=`<header><div><h2>판단의 근거를 따라가기</h2><p data-ke="case" class="knowledge-case"></p></div><button data-ke="close" aria-label="근거 화면 닫기">닫기 ×</button></header>
            <p class="knowledge-intro">어떤 분석에서 제안이 나왔고, 운용자가 무엇을 근거로 판단했는지 확인하세요.</p>
            <nav aria-label="근거 질문">${Object.entries(labels).map(([key,label])=>`<button data-question="${key}" aria-pressed="false">${label}</button>`).join('')}</nav>
            <div class="knowledge-tools"><p data-ke="status" role="status">저장된 근거를 조회합니다…</p><button data-ke="refresh">다시 조회</button></div>
            <section data-ke="answer" aria-label="질문에 대한 답변"></section><section data-ke="gaps" aria-label="확인할 점"></section>
            <section data-ke="relations" aria-label="근거의 연결"><h3>이 판단에 연결된 기록</h3><p class="knowledge-note">양쪽 기록을 누르면 내용을 확인할 수 있습니다. 화살표는 기록 사이의 관계를 뜻합니다.</p><div data-ke="edges"></div><button data-ke="moreEdges" hidden>연결 더 보기</button></section>
            <section data-ke="source" hidden tabindex="-1"><h3 data-ke="sourceTitle">근거 상세</h3><p data-ke="sourceDescription"></p><div data-ke="sourceSummary" class="knowledge-source-summary"></div><p data-ke="sourceStatus" role="status"></p><details data-ke="raw"><summary>원본 데이터 보기 · 기술 정보</summary><p data-ke="sourcePath"></p><pre data-ke="sourceBody"></pre></details></section>
            <h3>관련 근거 목록</h3><div data-ke="nodes" class="knowledge-nodes"></div><button data-ke="more" hidden>근거 더 보기</button>
            <p class="knowledge-note">선택한 사건의 저장 기록입니다. 현재 선박 상태는 지도와 최신 관측에서 확인하세요. DCPA는 예상 최근접 거리, TCPA는 그 지점까지 남은 시간입니다.</p>
            <details class="knowledge-technical"><summary>개발·연동용 기술 정보</summary><p>온톨로지는 선박·관측·분석·판단의 의미와 관계를 정의합니다. 위 화면은 그 관계로 연결한 사건 기록을 보여줍니다.</p><p>검증 규칙은 기록의 형식·연결·시간 순서를 검사합니다. 관측값이나 충돌 예측의 정확성을 보증하지는 않습니다.</p><div class="knowledge-tools"><a href="/api/v1/knowledge/proposals/${encodeURIComponent(pid)}/graph.ttl" download>이 사건의 관계 데이터 (RDF)</a><a href="/api/v1/knowledge/schema.ttl" download>온톨로지 정의 파일 (TTL)</a><a href="/api/v1/knowledge/shapes.ttl" download>검증 규칙 파일 (TTL)</a></div><p>답변은 저장된 관계 조회(SPARQL)와 정해진 설명 문장으로 구성합니다.</p></details>`;
        document.body.appendChild(dialog);dialog.showModal();
        const $=name=>dialog.querySelector('[data-ke="'+name+'"]');
        let disposed=false,requestId=0,controller,sourceController,question=initial,result,shown=20,expandedEdges=false;
        // 제안 목록은 주기적으로 리렌더되므로 previous 가 떨어져 나갔을 수 있다.
        // 그 경우 포커스가 body 로 날아가지 않도록 원래 카드의 버튼으로 되돌린다.
        function close(){disposed=true;controller?.abort();sourceController?.abort();dialog.remove();
            (previous?.isConnected?previous:document.querySelector('.proposal-card[data-id="'+CSS.escape(pid)+'"] [data-act="knowledge"]'))?.focus();
            if(activeClose===close)activeClose=null;}
        activeClose=close;$('close').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
        async function json(url,signal){const response=await fetch(url,{signal});const body=await response.json();if(!response.ok){const e=Error(body.detail||'근거 조회 실패');e.status=response.status;throw e;}return body;}
        /* 같은 선박의 관측이 여러 건이면 라벨이 전부 같아 목록에서 구분되지 않는다
           (수신 관측 · 412478080 …). 시각을 붙여야 "속력이 언제 떨어졌는지" 가 보인다.
           서버가 아니라 여기서 찍는다 — 속성값도 브라우저 로컬시로 표시하므로
           서버 시간대로 찍으면 같은 카드 안에서 두 시각이 어긋난다. */
        function nodeTime(n){
            for(const label of ['로컬 수신 시각','기록·계산 시각']){
                const p=n?.properties?.find(p=>p.label===label);
                if(p&&p.value){const d=new Date(p.value);if(!isNaN(d))return d.toLocaleTimeString();}
            }
            return '';
        }
        const timeTag=n=>{const t=nodeTime(n);return t?`<span class="knowledge-node-time">${esc(t)}</span>`:'';};
        function renderNodes(){
            const relevant=result.graph.nodes.filter(n=>n.relevant);
            const ordered=relevant.concat(result.graph.nodes.filter(n=>!n.relevant));
            $('nodes').innerHTML=ordered.slice(0,shown).map(n=>`<article id="ke-${esc(n.id.split(':').pop())}" class="knowledge-node ${n.relevant?'is-relevant':''}"><span class="knowledge-type">${esc(types[n.type]||n.type)}${n.relevant?' · 이번 질문 관련':' · 기타 저장 기록'}</span><h4>${esc(n.label)}${timeTag(n)}</h4>${propertyList(properties(n).slice(0,8))}<button data-source="${esc(n.id)}">내용 확인</button>${n.run_id?`<button data-run="${esc(n.run_id)}">비교 재생</button>`:''}</article>`).join('');
            $('more').hidden=ordered.length<=shown;$('more').textContent=`근거 더 보기 (${Math.min(shown,ordered.length)} / ${ordered.length})`;
        }
        function renderEdges(){
            const byId=new Map(result.graph.nodes.map(n=>[n.id,n]));
            const edges=result.graph.edges.filter(e=>byId.get(e.from)?.relevant||byId.get(e.to)?.relevant);
            const visible=expandedEdges?edges:edges.slice(0,6);
            $('edges').innerHTML=edges.length?'<div class="knowledge-edge-list">'+visible.map(e=>`<div class="knowledge-edge"><button data-source="${esc(e.from)}"><small>${esc(types[byId.get(e.from)?.type]||'기록')}</small>${esc(byId.get(e.from)?.label||'연결 기록')}${timeTag(byId.get(e.from))}</button><span>${esc(e.label)} →</span><button data-source="${esc(e.to)}"><small>${esc(types[byId.get(e.to)?.type]||'기록')}</small>${esc(byId.get(e.to)?.label||'연결 기록')}${timeTag(byId.get(e.to))}</button></div>`).join('')+'</div>':'<p>이 질문과 연결된 기록이 없습니다.</p>';
            $('moreEdges').hidden=edges.length<=6;$('moreEdges').textContent=expandedEdges?'연결 접기':`연결 더 보기 (${edges.length-6}개)`;
        }
        async function load(next=question){
            question=next;const id=++requestId;controller?.abort();sourceController?.abort();controller=new AbortController();
            $('answer').replaceChildren();$('gaps').replaceChildren();$('nodes').replaceChildren();$('edges').replaceChildren();$('case').textContent='';$('source').hidden=true;$('more').hidden=true;$('moreEdges').hidden=true;
            dialog.querySelectorAll('[data-question]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.question===question)));
            $('status').textContent='저장된 근거를 조회하고 검증합니다…';
            try{
                const data=await json('/api/v1/knowledge/proposals/'+encodeURIComponent(pid)+'?question='+encodeURIComponent(question),controller.signal);
                if(disposed||id!==requestId)return;
                result=data;shown=20;expandedEdges=false;
                $('case').textContent=data.graph.nodes.filter(n=>n.type==='Vessel').map(n=>n.label).join(' ↔ ')||'선택한 사건';
                $('status').textContent=`${new Date(data.generated_at).toLocaleString()} 조회 · ${data.validation.conforms?'기록의 형식·연결 확인 완료':'기록 연결·형식에 확인이 필요한 항목 '+data.validation.count+'건'}`;
                $('answer').innerHTML='<h3>'+esc(data.question_label)+'</h3>'+data.claims.map(c=>'<p>'+esc(c.text)+'</p><div class="knowledge-citations">'+c.evidence.map(nid=>`<button data-source="${esc(nid)}">${esc(types[data.graph.nodes.find(n=>n.id===nid)?.type]||'근거')} 확인</button>`).join('')+'</div>').join('');
                const gaps=data.gaps.concat(data.validation.violations.map(v=>{const n=data.graph.nodes.find(n=>n.id===v.node);return (n?.label||v.node)+' · '+v.message;}));
                $('gaps').innerHTML=gaps.length?'<h3>확인할 점</h3><ul>'+gaps.map(g=>'<li>'+esc(g)+'</li>').join('')+'</ul>':'';
                renderNodes();
                renderEdges();
            }catch(e){if(!disposed&&id===requestId&&e.name!=='AbortError')$('status').textContent='근거 조회 실패: '+e.message;}
        }
        /* retried: 409 재시도인지. 서버는 그래프 응답에 박아 보낸 fingerprint 와
           저장된 레코드의 다이제스트를 대조한다. 그런데 제안이 '추적 중'이면 당직사관이
           10초마다 save() 하며 revision 을 올리므로, 화면을 연 지 몇 초 만에 지문이
           낡는다. 즉 409 는 정상 운용 중에 늘 나는 것이지 예외 상황이 아니다.
           사용자에게 "다시 조회하세요" 라고 떠넘기지 말고 스스로 새로 읽고 한 번 재시도한다. */
        async function source(nid,retried){
            sourceController?.abort();sourceController=new AbortController();
            const signal=sourceController.signal,id=requestId;
            $('source').hidden=false;$('raw').open=false;$('raw').hidden=true;$('sourceTitle').textContent='근거 상세';$('sourceDescription').textContent='';$('sourceSummary').replaceChildren();$('sourceStatus').textContent='연결된 기록을 확인합니다…';$('sourcePath').textContent='';$('sourceBody').textContent='';$('source').scrollIntoView({block:'start',behavior:'auto'});
            try{
                const node=result?.graph.nodes.find(n=>n.id===nid);if(!node)throw Error('이 응답에 포함되지 않은 근거입니다. 다시 조회하세요.');
                let value;
                try{value=await json(node.source_url,signal);}
                catch(e){
                    if(e.status!==409||retried||disposed||signal.aborted)throw e;
                    $('sourceStatus').textContent='기록이 갱신되어 근거를 다시 읽는 중입니다…';
                    // 추적 중에는 10초마다 나므로, 다시 읽는다고 펼쳐둔 목록을 접으면 안 된다.
                    const keepShown=shown,keepEdges=expandedEdges;
                    await load(question);              // 새 지문으로 그래프를 다시 받는다
                    if(disposed)return;
                    shown=keepShown;expandedEdges=keepEdges;renderNodes();renderEdges();
                    return source(nid,true);
                }
                if(disposed||signal.aborted||id!==requestId)return;
                $('sourceTitle').textContent=node.label;$('sourceDescription').textContent=descriptions[node.type]||'이 사건에 연결된 저장 기록입니다.';
                $('sourceSummary').innerHTML=propertyList(properties(node));$('sourceStatus').textContent='조회한 근거와 저장된 원본이 일치합니다.';$('raw').hidden=false;
                $('sourcePath').textContent=value.path+' · '+(value.pointer||'전체 기록')+' · 제안 버전 '+value.proposal_revision;
                $('sourceBody').textContent=JSON.stringify(value.record,null,2);$('source').focus({preventScroll:true});
            }catch(e){if(!disposed&&!signal.aborted&&id===requestId)$('sourceStatus').textContent='기록 확인 실패: '+e.message;}
        }
        dialog.addEventListener('click',e=>{
            const q=e.target.closest('[data-question]');if(q){load(q.dataset.question);return;}
            const node=e.target.closest('[data-source]');if(node){source(node.dataset.source);return;}
            const run=e.target.closest('[data-run]');if(run){close();window.CollisionScenarios.openSaved(run.dataset.run);}
        });
        $('refresh').onclick=()=>load();$('more').onclick=()=>{shown+=20;renderNodes();};$('moreEdges').onclick=()=>{expandedEdges=!expandedEdges;renderEdges();};load();
    }
    window.KnowledgeEvidence={open};
})();
