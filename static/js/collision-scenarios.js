/* Frozen comparison: both renderers consume the same persisted track samples. */
(function () {
    'use strict';
    let dialog, snapshot, run, map, layer, actualLayer, disposeFollowup, three, frame, last, playing = false, seconds = 0, generation = 0, previousFocus, openedFor, playbackRate = 30;
    const $ = id => dialog.querySelector('[data-sc="' + id + '"]');
    const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    async function api(path, body) {
        const response = await fetch('/api/v1/collision/scenarios/' + path, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
        const data = await response.json();
        if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : '입력 범위를 확인하세요.');
        return data;
    }
    function error(e) { $('message').textContent = e.message; }
    /* 기록 목록 한 줄. 같은 쌍을 조건만 바꿔 여러 번 돌리는 일이 잦아서
       시각·쌍·변경 대상 셋이 다 있어야 구분된다. 옛 기록엔 ships/changed 가
       없을 수 있으므로 있는 것만 붙인다. */
    function runLabel(r) {
        const when = new Date(r.created_at).toLocaleString('ko-KR',
            { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const parts = [when];
        if (r.ships && r.ships.length === 2) parts.push(r.ships.join(' ↔ '));
        if (r.changed) parts.push('변경: ' + r.changed);
        return parts.join(' · ');
    }
    /* 입력이 바뀐 뒤 아직 재계산하지 않은 결과를 시각적으로 죽인다 — 문구만으로는
       화면의 지표·항적이 여전히 살아있는 값처럼 읽힌다. */
    function markStale(on) { dialog?.querySelectorAll('.scenario-metrics, .scenario-stage').forEach(el => el.classList.toggle('is-stale', on)); }
    /* 지도/3D 는 배타 선택이므로 어느 쪽인지 보여야 한다 — 전에는 두 버튼 다
       눌린 티가 없어 현재 보기를 알 수 없었다. 숨김/표시 로직도 한 곳으로 모은다. */
    function setView(mode) {
        const is3d = mode === 'three';
        $('map').hidden = is3d; $('three').hidden = !is3d;
        $('oceanControls').hidden = !is3d; $('oceanNote').hidden = !is3d;
        $('mapButton').setAttribute('aria-pressed', String(!is3d));
        $('threeButton').setAttribute('aria-pressed', String(is3d));
        if (!is3d) { map.invalidateSize(); paint(); return; }
        if (!three) buildThree();
        resize(); paint();
    }
    function close() {
        generation++; disposeFollowup?.();disposeFollowup=null; playing = false; cancelAnimationFrame(frame);
        if (map) { map.remove(); map = null; }
        disposeThree();
        dialog?.remove(); dialog = null; window.removeEventListener('resize', resize);
        // 제안 목록이 리렌더되면 previousFocus 가 떨어져 나간다. 포커스를 body 로
        // 흘리지 않도록 이 비교를 연 버튼 → 전역 비교 버튼 순으로 되돌린다.
        const card = openedFor && document.querySelector('.proposal-card[data-id="' + CSS.escape(openedFor) + '"] [data-act="compare"]');
        // 목록의 비교 버튼은 선택된 행에서만 보이므로 숨겨진 것에 포커스를 주지 않는다.
        const fallback = card
            || document.querySelector('.collision-row.selected .cr-compare')
            || document.querySelector('.right-panel-action');
        (previousFocus?.isConnected ? previousFocus : fallback)?.focus();
    }
    function shell() {
        if (dialog) close(); previousFocus = document.activeElement;
        snapshot = null; run = null; seconds = 0; last = null; openedFor = null; playbackRate = 30;
        // is-empty: 아직 스냅샷이 없는 상태. 입력 폼·무대·재생은 이때 전부 죽은
        // 컨트롤이므로 감춘다 — 특히 '변경할 선박' 은 옵션이 0개라 열어도 빈
        // 목록이 나온다. setSnapshot() 이 데이터를 넣을 때 풀린다.
        dialog = document.createElement('dialog'); dialog.className = 'scenario-dialog is-empty'; dialog.setAttribute('aria-label','항적 시나리오 비교');
        dialog.innerHTML = `<header><div><h2>속력·침로 조건 비교</h2></div><div class="scenario-header-actions"><button data-sc="back" hidden>사건 검토로 돌아가기</button><button data-sc="close" aria-label="비교 화면 닫기">닫기 ×</button></div></header>
        <p class="scenario-intro">선택 검토 · 한 척의 속력·침로를 바꿨다고 가정해 비교합니다. 결과는 자동 저장되며 실제 선박에는 적용되지 않습니다.</p>
        <ol class="decision-steps" aria-label="조건 비교 순서"><li data-sc="stepInput" aria-current="step">조건 선택</li><li data-sc="stepResult">거리·주변 영향 확인</li><li>사건 검토로 복귀</li></ol><p data-sc="message" role="status">선박 수신 상태를 확인하고 있습니다.</p>
        <form data-sc="form">
          <fieldset class="sf-group"><legend>무엇을 바꾸나</legend><div class="sf-row"><label>변경할 선박<select data-sc="target" required></select></label><label>속력 (kt)<input data-sc="speed" type="number" min="0" max="50" step="0.1" required></label><label>침로 (°)<input data-sc="course" type="number" min="0" max="359.9" step="0.1" required></label></div><div class="sf-presets" role="group" aria-label="자주 쓰는 회피 기동"><span>회피 기동</span><button type="button" data-preset data-turn="20">우현 20°</button><button type="button" data-preset data-turn="-20">좌현 20°</button><button type="button" data-preset data-slow="0.5">감속 50%</button><button type="button" data-preset data-reset="1">현재 값으로</button></div></fieldset>
          <fieldset class="sf-group"><legend>얼마나 내다보나</legend><div class="sf-row"><label>예측 시간 (분)<input data-sc="minutes" type="number" min="5" max="30" value="15" required></label></div></fieldset>
          <fieldset class="sf-group is-secondary"><legend>얼마나 빨리 반응하나</legend><div class="sf-row"><label>선회 (초)<input data-sc="turnSeconds" type="number" min="0" max="300" value="60" required></label><label>속력 변경 (초)<input data-sc="speedSeconds" type="number" min="0" max="300" value="120" required></label></div></fieldset>
          <button data-sc="calculate" class="sf-submit" disabled>조건 비교하기</button>
          <p data-sc="inputHint" class="sf-hint"></p>
        </form>
        <div class="scenario-stagebar">
          <div class="scenario-viewswitch" role="group" aria-label="보기 전환"><button data-sc="mapButton" aria-pressed="true">지도</button><button data-sc="threeButton" aria-pressed="false" disabled>3D 재생</button></div>
          <div class="scenario-records"><button data-sc="history">저장한 비교</button><select data-sc="saved" aria-label="저장한 비교 선택"><option value="">최근 비교 선택</option></select></div>
        </div>
        <section data-sc="resultGuide" class="scenario-result-guide" hidden tabindex="-1"><h3>비교 결과 · 두 가지를 함께 확인하세요</h3><p><strong>두 선박 최소 거리</strong>가 벌어지는지, <strong>주변 선박과의 근접</strong>이 늘지는 않는지 확인하세요. 지도·3D는 그 차이가 생기는 경로를 보여줍니다.</p><p>가장 가까워지는 순간은 아래 <strong>변경안 최접근 시점으로</strong> 버튼으로 확인할 수 있습니다.</p></section><div data-sc="metrics" class="scenario-metrics"></div><div class="scenario-stage"><div data-sc="map" class="scenario-map"></div><div data-sc="three" class="scenario-three" hidden></div><div data-sc="oceanControls" class="scenario-ocean-controls" hidden><button data-sc="overview">전체 항적</button><button data-sc="follow">변경 선박 가까이</button><button data-sc="fixed" aria-pressed="false">시점 고정</button><button data-sc="motion" aria-pressed="true">선체 동요</button><span>드래그: 시점 회전 · 휠: 확대</span></div><div data-sc="oceanNote" class="scenario-ocean-note" hidden>바다·선체 동요는 시각 효과 · 실제 기상 미연동 · 항적에 파도·해류 영향 미계산 · 선박 확대 표시</div></div>
        <div class="scenario-playback"><div class="sp-transport"><button data-sc="play" disabled>재생</button><input data-sc="time" aria-label="예측 경과 시간" type="range" min="0" max="900" value="0" step="1"><output data-sc="clock">00:00</output></div><label class="scenario-rate">재생 속도 <select data-sc="rate"><option value="1">1배속</option><option value="3">3배속</option><option value="10">10배속</option><option value="30" selected>30배속</option></select></label><button data-sc="cpa" class="sp-jump" disabled>변경안 최접근 시점으로</button></div>
        <div class="scenario-legend"><span><i class="sw sw-base"></i>기준</span><span><i class="sw sw-alt"></i>변경안</span><span><i class="sw sw-subject"></i>상대 선박</span><span><i class="sw sw-nearby"></i>주변 선박</span><span class="sl-note" data-sc="rateNote">재생 30배속</span></div><div data-sc="details" class="scenario-details">정속·직선 가정 비교입니다. 실제 운항 지시나 안전 판정이 아닙니다.</div><div data-sc="followup"></div><section data-sc="returnGuide" class="scenario-return-guide" hidden><h3>비교를 확인했다면 사건 검토로 돌아가세요</h3><p>필요하면 위에서 비교 검토 이유를 남긴 뒤, 집중 추적 여부를 판단하세요. 비교 결과 저장만으로 추적이 승인되지는 않습니다.</p><button data-sc="backBottom">사건 검토로 돌아가기 →</button></section>`;
        document.body.appendChild(dialog); dialog.showModal();
        $('close').onclick = close;
        $('back').onclick=$('backBottom').onclick=()=>{const pid=openedFor;if(!pid)return;close();window.InvestigationUI.open(pid);}; dialog.oncancel = e => { e.preventDefault(); close(); };
        $('target').onchange = fillInputs;
        $('form').oninput = markInputChanged;
        $('form').addEventListener('click', e => { const p=e.target.closest('[data-preset]'); if(p) applyPreset(p); });
        $('form').onsubmit = async e => {
            e.preventDefault(); const token = generation; $('calculate').disabled = true; $('message').textContent = '동일한 시작 조건으로 계산하고 저장합니다…';
            try { const result = await api('runs',{snapshot_id:snapshot.id,target:Number($('target').value),speed:Number($('speed').value),course:Number($('course').value),minutes:Number($('minutes').value),turn_seconds:Number($('turnSeconds').value),speed_seconds:Number($('speedSeconds').value)}); if(token===generation){show(result);$('resultGuide').scrollIntoView({block:'start'});$('resultGuide').focus({preventScroll:true});} }
            catch(e){if(token===generation)error(e);} finally {if(token===generation)syncCalculate();}
        };
        $('history').onclick = async () => {
            const token = generation;
            try {
                const data = await api('runs');
                if (token !== generation) return;
                // 시각만으로는 어느 비교인지 알 수 없다. 선박 쌍과 변경 대상을 함께 싣는다.
                // (UUID 조각은 운용자에게 의미가 없어 뺐다.)
                $('saved').innerHTML = '<option value="">비교 기록 선택…</option>'
                    + data.runs.map(r => `<option value="${esc(r.id)}">${esc(runLabel(r))}</option>`).join('');
                $('message').textContent = data.runs.length
                    ? `저장된 비교 ${data.runs.length}건. 하나를 고르면 그때의 시작 조건과 항적을 그대로 다시 봅니다.`
                    : '저장된 비교가 없습니다. 충돌 목록의 행이나 제안 카드에서 시나리오 비교를 먼저 실행하세요.';
            } catch (e) { if (token === generation) error(e); }
        };
        $('saved').onchange = async () => {if(!$('saved').value)return; const token=++generation;try {const result=await api('runs/'+encodeURIComponent($('saved').value));if(token===generation){openedFor=result.snapshot?.proposal_id||null;setSnapshot(result.snapshot);show(result);}}catch(e){if(token===generation)error(e);}};
        $('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'일시정지':'재생';last=null;if(playing&&seconds>=run.horizon_s){seconds=0;paint();}};
        $('time').oninput=()=>{seconds=Number($('time').value);paint();};
        $('cpa').onclick=()=>{seconds=run.scenarios.alternative.pair.closest_time_s;paint();};
        $('mapButton').onclick=()=>setView('map');
        $('threeButton').onclick=()=>{try{setView('three');}catch(e){disposeThree();error(e);setView('map');}};
        $('overview').onclick=()=>setOceanCamera(false);
        $('follow').onclick=()=>setOceanCamera(true);
        $('fixed').onclick=()=>{if(!three)return;three.follow=false;cameraButtons('fixed');};
        $('rate').onchange=()=>setPlaybackRate(Number($('rate').value));
        $('motion').onclick=()=>{if(!three)return;three.motionEnabled=!three.motionEnabled;$('motion').setAttribute('aria-pressed',String(three.motionEnabled));animateBodies(0,true);};
        map=L.map($('map')).setView([30,130],5); L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Tiles &copy; Esri',maxZoom:19}).addTo(map); layer=L.layerGroup().addTo(map);actualLayer=L.layerGroup().addTo(map);
        window.addEventListener('resize',resize); frame=requestAnimationFrame(tick);
    }
    function setSnapshot(value) {
        snapshot=value;
        $('target').innerHTML=value.ships.slice(0,2).map(s=>`<option value="${s.mmsi}">${esc(s.name)}</option>`).join('');
        fillInputs();   // 안에서 syncCalculate() 가 '바뀐 게 없으면 잠금' 을 건다
        // 데이터가 들어왔으니 폼·무대를 연다. 지도는 숨겨진 동안 크기가 0이었으므로
        // fitBounds 전에 다시 재어야 한다.
        dialog.classList.remove('is-empty');
        map.invalidateSize();
    }
    // 변경 대상 선박의 '현재' 값. 프리셋과 '바뀐 게 있나' 판정의 기준점이다.
    function baseline(){ return snapshot?.ships.find(s=>s.mmsi===Number($('target').value)); }
    function fillInputs(){const s=baseline();if(!s)return;$('speed').value=Math.min(50,s.sog).toFixed(1);$('course').value=s.cog.toFixed(1);syncCalculate();}
    /* 폼 기본값이 '현재 값' 이라 아무것도 바꾸지 않고 누르면 기준 = 변경안이 되어
       결과가 전부 '변화 없음 · 0.00' 으로 나온다. 도구가 고장 난 것처럼 읽히거나
       '회피해도 소용없다' 로 오독되므로, 바뀐 게 없으면 계산 자체를 막는다. */
    function unchanged(){
        const s=baseline(); if(!s) return false;
        const same=(a,b)=>Math.abs(Number(a)-Number(b))<0.05;
        return same($('speed').value,Math.min(50,s.sog)) && same($('course').value,s.cog);
    }
    function syncCalculate(){
        if(!dialog||!snapshot) return;
        const idle=unchanged();
        $('calculate').disabled=idle;
        $('inputHint').textContent=idle?'속력이나 침로를 바꿔야 비교가 됩니다. 회피 기동 버튼으로 시작해도 됩니다.':'';
    }
    function markInputChanged(){
        syncCalculate();
        if(!run)return;
        $('stepInput').setAttribute('aria-current','step');$('stepResult').removeAttribute('aria-current');
        $('message').textContent='입력 조건이 변경되었습니다. 아래는 이전 계산 결과입니다. 비교 계산을 눌러 갱신하세요.';
        markStale(true);
    }
    // 무엇을 넣어야 할지 모르는 상태를 없앤다. 값은 '현재 값 기준 상대 변경' 이다.
    function applyPreset(el){
        const s=baseline(); if(!s) return;
        if(el.dataset.reset) fillInputs();
        else if(el.dataset.turn) $('course').value=(((s.cog+Number(el.dataset.turn))%360+360)%360).toFixed(1);
        else if(el.dataset.slow) $('speed').value=Math.min(50,s.sog*Number(el.dataset.slow)).toFixed(1);
        markInputChanged();
    }
    function tracks() {
        const target=String(run.change.mmsi), pair=run.snapshot.pair.map(String);
        return Object.entries(run.scenarios.baseline.tracks).map(([id,t])=>({id,...t,color:id===target?'#58a6ff':pair.includes(id)?'#eef3fc':'#7d899e',dashed:id===target})).concat([{id:target,...run.scenarios.alternative.tracks[target],color:'#ffb454',dashed:false}]);
    }
    function position(t) { const i=Math.min(Math.floor(seconds/10),t.points.length-1),a=t.points[i],b=t.points[Math.min(i+1,t.points.length-1)],f=b.t_s===a.t_s?0:(seconds-a.t_s)/(b.t_s-a.t_s); const start=a.cog??t.ship.cog,end=b.cog??t.ship.cog;return {x_nm:a.x_nm+(b.x_nm-a.x_nm)*f,y_nm:a.y_nm+(b.y_nm-a.y_nm)*f,cog:start+((end-start+540)%360-180)*f}; }
    function latlng(p){const o=run.snapshot.origin;return [o.lat+p.y_nm/60,o.lng+p.x_nm/(60*Math.cos(o.lat*Math.PI/180))];}
    /* 이 도구의 답은 "얼마나 벌어졌나"다. 기준값과 변경값만 나란히 두면 운용자가
       암산으로 빼야 하므로 차이를 먼저 말한다.
       색은 주의가 필요한 방향에만 쓴다 — 벌어졌다고 초록으로 칠하면 "이렇게 해도
       안전하다"로 읽히는데 이 계산은 안전 판정이 아니다(해안·수심·항법규칙 미계산). */
    function svRow(label, base, alt, unit, delta, digits, attention, word) {
        const moved = delta !== 0;
        const belowPrecision = moved && Number(Math.abs(delta).toFixed(digits))===0;
        const sign = delta > 0 ? '+' : '−';
        return `<div class="sv-row${attention ? ' is-attention' : ''}">
            <span class="sv-label">${esc(label)}</span>
            <span class="sv-pair"><span class="sv-from">${base}</span><span class="sv-arrow" aria-hidden="true">→</span><span class="sv-to">${alt}</span><span class="sv-unit">${esc(unit)}</span></span>
            <span class="sv-delta">${belowPrecision?'차이 '+Math.pow(10,-digits).toFixed(digits)+' '+esc(unit)+' 미만':(moved ? sign + Math.abs(delta).toFixed(digits) + ' ' : '')+esc(word)}</span>
        </div>`;
    }
    function verdict() {
        const b = run.scenarios.baseline, a = run.scenarios.alternative;
        const dist = a.pair.closest_distance_nm - b.pair.closest_distance_nm;
        const near = a.nearby_under_05nm - b.nearby_under_05nm;
        return '<div class="scenario-verdict">'
            + svRow('두 선박 최소 거리', b.pair.closest_distance_nm.toFixed(2), a.pair.closest_distance_nm.toFixed(2), 'nm',
                    dist, 2, dist < 0, dist > 0 ? '벌어짐' : dist < 0 ? '가까워짐' : '변화 없음')
            + svRow('주변 선박 0.5 nm 미만', b.nearby_under_05nm, a.nearby_under_05nm, '쌍',
                    near, 0, near > 0, near > 0 ? '늘어남' : near < 0 ? '줄어듦' : '변화 없음')
            + '</div>';
    }
    function breakdown() {
        return '<div class="scenario-breakdown">' + ['baseline', 'alternative'].map((key, i) => {
            const s = run.scenarios[key], p = s.pair;
            const method = p.metric_method ? '선회·속력 변화 구간 내 최소값' : p.within_horizon ? '기간 내 CPA' : 'CPA가 기간 밖이거나 상대 속도 없음';
            return `<article class="sb-${key}"><h4>${i ? '변경안' : '기준 유지'}</h4><dl>
                <dt>최소 거리</dt><dd>${p.closest_distance_nm.toFixed(2)} nm</dd>
                <dt>발생 시점</dt><dd>${(p.closest_time_s / 60).toFixed(1)}분</dd>
                <dt>주변 0.5 nm 미만</dt><dd>${s.nearby_under_05nm}쌍</dd>
                <dt>산출</dt><dd>${esc(method)}</dd></dl></article>`;
        }).join('') + '</div>';
    }
    function show(value) {
        disposeFollowup?.();disposeFollowup=null;actualLayer.clearLayers();$('followup').replaceChildren();markStale(false);
        run=value; playing=false;seconds=0;$('play').textContent='재생';$('time').max=run.horizon_s;
        $('target').value=run.change.mmsi;$('speed').value=run.change.sog;$('course').value=run.change.cog;$('minutes').value=run.horizon_s/60;$('turnSeconds').value=run.change.turn_seconds||0;$('speedSeconds').value=run.change.speed_seconds||0;
        ['play','cpa','threeButton'].forEach(k=>$(k).disabled=false);
        $('message').textContent=run.snapshot.ships.slice(0,2).map(s=>s.name).join(' ↔ ')+' · 저장 완료 · 기준 시각 '+new Date(run.snapshot.created_at).toLocaleString();
        $('metrics').innerHTML=verdict()+breakdown();
        $('resultGuide').hidden=false;$('stepInput').removeAttribute('aria-current');$('stepResult').setAttribute('aria-current','step');$('calculate').textContent='조건 다시 비교하기';$('returnGuide').hidden=!openedFor;$('back').hidden=!openedFor;
        const c=run.snapshot.coverage;
        $('details').innerHTML=`<p><strong>가정 비교 · 운항 지시나 안전 판정이 아닙니다.</strong> ${run.change.turn_seconds||run.change.speed_seconds?'선회 '+(run.change.turn_seconds||0)+'초 · 속력 변경 '+(run.change.speed_seconds||0)+'초 가정. 선박별 실제 성능과 다를 수 있습니다.':'속력·침로 즉시 변경 가정.'} 해안·수심·항법규칙·기상은 계산하지 않습니다.</p><p>주변 ${c.included}척 포함 · 오래되거나 잘못된 수신 ${c.stale_or_invalid}척 제외 · 수량 제한 제외 ${c.capacity_omitted}척. ${esc(c.note)}</p><details><summary>주변 선박 근접 결과 · 모델 가정</summary>${['baseline','alternative'].map((key,i)=>`<p>${i?'변경안':'기준'} · ${run.scenarios[key].nearby.length?run.scenarios[key].nearby.map(n=>`${n.subject} ↔ ${esc(n.name)}: ${n.distance_nm.toFixed(2)} nm / ${(n.time_s/60).toFixed(1)}분`).join('<br>'):'평가 가능한 주변 선박 없음'}</p>`).join('')}<p>${(run.assumptions||run.snapshot.assumptions).map(esc).join('<br>')}</p><p>모델 ${esc(run.model)} · 선박 크기는 가독성을 위해 확대 표시합니다.</p></details>`;
        layer.clearLayers(); run.visuals=tracks().map(t=>{L.polyline(t.points.map(latlng),{color:t.color,weight:2,opacity:t.dashed?.65:.9,dashArray:t.dashed?'6 6':null}).addTo(layer);const marker=L.circleMarker(latlng(t.points[0]),{radius:run.snapshot.pair.includes(Number(t.id))?6:3,color:t.color,fillOpacity:1}).bindTooltip(esc(t.ship.name)+(t.dashed?' · 기준':'')).addTo(layer);return {...t,marker};});
        map.fitBounds(L.latLngBounds(run.visuals.filter(t=>run.snapshot.pair.includes(Number(t.id))).flatMap(t=>t.points.map(latlng))).pad(.15),{maxZoom:14});
        if(three){disposeThree();if(!$('three').hidden)buildThree();}paint();
        syncCalculate();   // 입력을 저장된 조건으로 채웠으니 '바뀐 게 없음' 잠금·안내를 다시 판정한다
        if(run.snapshot.proposal_id)disposeFollowup=DecisionFollowup.mount($('followup'),run.snapshot.proposal_id,run,tracks=>{
            actualLayer.clearLayers();Object.entries(tracks).forEach(([m,ps])=>{if(!ps.length)return;const coordinates=ps.map(latlng);L.polyline(coordinates,{color:'#67dcb0',weight:3}).addTo(actualLayer);L.circleMarker(coordinates[coordinates.length-1],{color:'#67dcb0',radius:5}).bindTooltip(esc(m)+' · 관측').addTo(actualLayer);});
        });
    }
    function disposeThree(){if(!three)return;three.ocean?.dispose();three.controls.dispose();three.scene.traverse(o=>{o.geometry?.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());});three.renderer.dispose();$('three').replaceChildren();three=null;}
    function buildThree(){
        const host=$('three'),scene=new THREE.Scene();scene.background=new THREE.Color('#a9c5d4');
        const scale=100; // Render units per nautical mile; calculations stay unchanged.
        const points=run.visuals.filter(t=>run.snapshot.pair.includes(Number(t.id))).flatMap(t=>t.points);
        const bounds=new THREE.Box3().setFromPoints(points.map(p=>new THREE.Vector3(p.x_nm*scale,0,-p.y_nm*scale)));
        const center=bounds.getCenter(new THREE.Vector3()),span=bounds.getSize(new THREE.Vector3());
        const size=Math.max(2*scale,span.x,span.z)*1.3;
        const camera=new THREE.PerspectiveCamera(45,1,.1,size*500);
        const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.75;host.appendChild(renderer.domElement);
        const controls=new THREE.OrbitControls(camera,renderer.domElement);controls.maxPolarAngle=Math.PI*.47;controls.minDistance=size*.08;controls.maxDistance=size*4;
        scene.add(new THREE.HemisphereLight(0xdcefff,0x355866,1.5));
        three={scene,camera,renderer,controls,scale,size,center,meshes:[],follow:false,followAnchor:new THREE.Vector3(),oceanSeconds:0,motionEnabled:true};
        three.ocean=ScenarioOcean.create(scene,renderer,size);
        const meshes=run.visuals.map(t=>{
            const geometry=new THREE.BufferGeometry().setFromPoints(t.points.map(p=>new THREE.Vector3(p.x_nm*scale,size*.002,-p.y_nm*scale)));
            const line=new THREE.Line(geometry,t.dashed?new THREE.LineDashedMaterial({color:t.color,dashSize:size/100,gapSize:size/150}):new THREE.LineBasicMaterial({color:t.color}));line.computeLineDistances();line.material.depthTest=false;line.material.transparent=true;line.material.opacity=t.dashed?.65:.9;line.renderOrder=2;scene.add(line);
            let ship;
            if (run.snapshot.pair.includes(Number(t.id)) && window.ShipBuilders) {
                ship=ShipBuilders.buildShipModel(ShipBuilders.getShipTypeKey({type:String(t.ship.type)}),t.color);
                // Own buffers/materials for safe disposal. DecalGeometry.clone() calls its
                // constructor without the required mesh/orientation in Three.js r137.
                ship.traverse(o=>{if(o.geometry)o.geometry=new THREE.BufferGeometry().copy(o.geometry);if(o.material)o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();});
                const bounds=new THREE.Box3().setFromObject(ship),extent=bounds.getSize(new THREE.Vector3());
                ship.scale.setScalar(size/22/Math.max(extent.x,extent.z));ship.userData.waterline=-bounds.min.y*ship.scale.x*.65;ship.userData.headingOffset=Math.PI/2;ship.rotation.y=Math.PI/2-t.ship.cog*Math.PI/180;
                // Heading/track belong to the outer group. Only the inner body rocks,
                // so local roll axes stay correct after a turn and the camera stays level.
                const body=new THREE.Group(),anchor=new THREE.Group();
                anchor.userData={waterline:ship.userData.waterline,headingOffset:Math.PI/2,body};
                ship.rotation.set(0,0,0);body.add(ship);anchor.add(body);ship=anchor;
            } else {
                ship=new THREE.Mesh(new THREE.ConeGeometry(size/200,size/80,3),new THREE.MeshStandardMaterial({color:t.color}));
                ship.geometry.rotateX(-Math.PI/2);ship.rotation.y=-t.ship.cog*Math.PI/180;
            }
            scene.add(ship);return ship;
        });
        three.meshes=meshes;$('motion').setAttribute('aria-pressed','true');paint();setOceanCamera(false);resize();
    }
    function setOceanCamera(follow) {
        if(!three)return;
        three.follow=follow;
        setPlaybackRate(follow?3:30);
        const target=follow ? three.meshes[three.meshes.length-1].position.clone() : three.center.clone();
        const distance=three.size*(follow?.2:.85);
        three.followAnchor.copy(target);
        three.controls.target.copy(target);
        three.camera.position.copy(target).add(new THREE.Vector3(distance*.3,distance*(follow?.28:.7),distance));
        three.controls.update();
        cameraButtons(follow?'follow':'overview');
    }
    function resize(){if(!dialog)return;map?.invalidateSize();if(three){const host=$('three');if(host.clientWidth&&host.clientHeight){three.renderer.setSize(host.clientWidth,host.clientHeight);three.camera.aspect=host.clientWidth/host.clientHeight;three.camera.updateProjectionMatrix();}}}
    function cameraButtons(mode){['overview','follow','fixed'].forEach(name=>$(name).setAttribute('aria-pressed',String(name===mode)));}
    function setPlaybackRate(rate){playbackRate=rate;$('rate').value=String(rate);$('rateNote').textContent='재생 '+rate+'배속';}
    // Translate camera and orbit target together: keep the user's bearing, height and zoom.
    // Dampen using wall time, so low frame rates do not change the camera response.
    function followCamera(dt, snap=false){
        if(!three?.follow)return;
        const goal=three.meshes[three.meshes.length-1].position;
        const delta=goal.clone().sub(three.followAnchor).multiplyScalar(snap?1:1-Math.exp(-dt/.3));
        three.followAnchor.add(delta);three.camera.position.add(delta);three.controls.target.add(delta);
    }
    function paint(snapCamera=true){
        if(!run)return;
        $('time').value=seconds;$('clock').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(Math.floor(seconds%60)).padStart(2,'0');
        run.visuals.forEach((t,i)=>{
            const p=position(t);
            // A hidden Leaflet map need not update every marker during a 3D frame.
            if(!$('map').hidden)t.marker.setLatLng(latlng(p));
            if(three){const mesh=three.meshes[i];mesh.position.set(p.x_nm*three.scale,mesh.userData.waterline||three.size*.001,-p.y_nm*three.scale);mesh.rotation.y=(mesh.userData.headingOffset||0)-p.cog*Math.PI/180;}
        });
        if(snapCamera)followCamera(0,true);
        if(snapCamera)animateBodies(0,true);
    }
    function animateBodies(dt,snap=false){
        if(!three)return;
        const blend=snap?1:1-Math.exp(-dt/.3);
        for(const mesh of three.meshes){
            const body=mesh.userData.body;if(!body)continue;
            const pose=three.motionEnabled?three.ocean.attitude(mesh.position,mesh.rotation.y,three.oceanSeconds):{roll:0,pitch:0,heave:0};
            body.rotation.x+=(pose.roll-body.rotation.x)*blend;
            body.rotation.z+=(pose.pitch-body.rotation.z)*blend;
            body.position.y+=(pose.heave-body.position.y)*blend;
        }
    }
    function tick(now){
        const elapsed=last===null?0:(now-last)/1000;
        // Pause across a suspended tab or a long rendering stall instead of jumping ahead.
        const dt=elapsed<=.25?Math.max(0,elapsed):0;last=now;
        if(playing&&run){seconds=Math.min(run.horizon_s,seconds+dt*playbackRate);paint(false);if(seconds>=run.horizon_s){playing=false;$('play').textContent='재생';}}
        if(three&&!$('three').hidden){
            if(playing){followCamera(dt);three.oceanSeconds+=dt;animateBodies(dt);}
            three.ocean.update(three.oceanSeconds);three.controls.update();three.renderer.render(three.scene,three.camera);
        }
        frame=requestAnimationFrame(tick);
    }
    window.CollisionScenarios={open:async(a,b,proposalId)=>{shell();openedFor=proposalId||null;$('back').hidden=!openedFor;const token=generation;try{const value=await api('snapshots',{mmsi_a:Number(a),mmsi_b:Number(b),proposal_id:proposalId||null});if(token!==generation)return;setSnapshot(value);$('message').textContent='시작 조건 저장 완료. 속력·침로를 입력해 비교하세요.';}catch(e){if(token===generation)error(e);}},openSaved:async id=>{shell();const token=generation;try{const value=await api('runs/'+encodeURIComponent(id));if(token!==generation)return;openedFor=value.snapshot?.proposal_id||null;setSnapshot(value.snapshot);show(value);}catch(e){if(token===generation)error(e);}},history:()=>{shell();$('history').click();}};
})();
