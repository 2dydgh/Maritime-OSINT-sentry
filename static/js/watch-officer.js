// Operator approval first; map execution only after the committed response.
(function (root) {
    'use strict';
    var API = '/api/v1/proposals';
    var FORMAT_ERROR = '서버의 제안 데이터 형식이 현재 화면과 다릅니다. 백엔드를 재시작한 뒤 새로고침해 주세요.';
    function validateProposal(p) {
        var subjects = p && p.trigger && p.trigger.subjects;
        if (!p || typeof p.id !== 'string' || !Number.isInteger(p.revision) ||
            typeof p.updated_at !== 'string' || !Array.isArray(p.pair) || p.pair.length !== 2 ||
            !Array.isArray(subjects) || subjects.length !== 2 || subjects.some(function(s){return !s || typeof s !== 'object';}) ||
            !p.rule || typeof p.rule.version !== 'string' || !Array.isArray(p.events)) {
            throw new Error(FORMAT_ERROR);
        }
        return p;
    }
    function createStore(opts) {
        var records = {}, busy = {}, listeners = [], active = null;
        function notify() { listeners.forEach(function (fn) { fn(); }); }
        function receive(p) {
            validateProposal(p);
            if (!records[p.id] || p.revision >= records[p.id].revision) records[p.id] = p;
            p = records[p.id];
            if (active && active.id === p.id && ['approved','tracking'].indexOf(p.status) < 0) {
                active = null; opts.stopFn();
            }
            notify();
        }
        async function request(path, body) {
            var controller = new AbortController();
            var timer = setTimeout(function(){controller.abort();}, 8000);
            var res;
            try {
                res = await opts.fetchFn(API + path, Object.assign({signal:controller.signal}, body ? {
                    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
                } : {}));
            } finally { clearTimeout(timer); }
            if (!res.ok) {
                var detail;
                try { detail=(await res.json()).detail; } catch (_) {}
                throw new Error(typeof detail==='string'?detail:'요청 실패 (' + res.status + ')');
            }
            return res.json();
        }
        async function report(p, outcome, reason) {
            var rec = await request('/' + p.id + '/execution', {
                client_id: opts.clientId, execution_id: p.execution.id, outcome: outcome, reason: reason || ''
            });
            receive(rec); return rec;
        }
        async function approve(id, reason, investigationId) {
            if (busy[id]) return;
            if (active || Object.keys(busy).length) throw new Error('진행 중인 추적 또는 승인 요청을 먼저 마쳐주세요.');
            busy[id] = true; notify();
            try {
                var result = await request('/' + id + '/decision', {outcome:'approved', reason:reason || '집중 추적 필요', client_id:opts.clientId, investigation_id:investigationId || null});
                if (!result || !result.proposal) throw new Error(FORMAT_ERROR);
                receive(result.proposal);
                if (!result.execute) throw new Error('승인할 수 없습니다. 최신 제안 상태와 근거를 확인하세요.');
                var p = records[result.proposal.id];
                if (!p.execution || !p.execution.id) throw new Error(FORMAT_ERROR);
                if (p.status !== 'approved') throw new Error('제안 상태가 변경되어 실행하지 않았습니다.');
                try {
                    if (await opts.dispatchFn(p) !== true) throw new Error('지도 추적을 시작하지 못했습니다.');
                } catch (e) {
                    opts.stopFn();
                    await report(p, 'failed', String(e.message).slice(0,500));
                    throw e;
                }
                active = p;
                // A lost receipt is retried by heartbeat, never by redispatching the action.
                await report(p, 'tracking', 'map_tracking_started');
            } finally { delete busy[id]; notify(); }
        }
        async function dismiss(id, reason, investigationId) {
            if (busy[id]) return;
            busy[id] = true; notify();
            try {
                var result = await request('/' + id + '/decision', {outcome:'dismissed',reason:reason || '관망',client_id:opts.clientId, investigation_id:investigationId || null});
                receive(result.proposal);
            } finally { delete busy[id]; notify(); }
        }
        async function stop() {
            if (!active) return;
            var p = active; active = null; opts.stopFn();
            await report(p, 'completed', 'operator_stopped_tracking');
        }
        async function load() {
            if (active) {
                if (opts.isTrackingFn(active)) await report(active, 'tracking', 'map_tracking_active');
                else {
                    var p = active; active = null; opts.stopFn();
                    await report(p, 'completed', 'map_tracking_stopped');
                }
            }
            var data = await request('?limit=100');
            if (!data || !Array.isArray(data.proposals)) throw new Error(FORMAT_ERROR);
            // Validate the full response before notifying/rendering any cards.
            data.proposals.forEach(validateProposal);
            data.proposals.forEach(receive);
            return data;
        }
        return {approve:approve,dismiss:dismiss,stop:stop,load:load,receive:receive,
            all:function(){return Object.values(records).sort(function(a,b){return b.updated_at.localeCompare(a.updated_at);});},
            isBusy:function(id){return !!busy[id];}, activeId:function(){return active && active.id;},
            onChange:function(fn){listeners.push(fn);}};
    }
    // ── 브라우저 알림 판정 ────────────────────────────────────────────
    // 무엇을 알릴지가 핵심이다. 제안은 시간당 수백 건씩 바뀌므로(운영 기록 551건/h) 전부
    // 알리면 소음이다. 알리는 것은 두 가지뿐이다:
    //   imminent  최근접까지(TCPA) IMMINENT_TCPA_MIN 분 이하로 임박한 사건
    //   top       새로 가장 위험한 순위에 오른 사건
    // 관측 지연(stale) 사건은 알리지 않는다 — 승인할 수 없는 상태라 와서 봐도 할 일이 없다.
    // 같은 선박쌍·같은 종류는 NOTIFY_REPEAT_MS 안에 다시 알리지 않는다(순위가 A↔B 로
    // 오가며 깜빡여도 한 번만 울린다).
    var IMMINENT_TCPA_MIN = 5, NOTIFY_REPEAT_MS = 10 * 60 * 1000;
    // 서버 watch_officer.rank_key 와 같은 순서여야 한다: ML 고위험 → DCPA 작은 순 → TCPA 임박한 순.
    function rankKey(p) { var t = p.trigger || {}; return [t.source === 'ml' ? 0 : 1, Number(t.dcpa_nm), Number(t.tcpa_min)]; }
    function compareRank(a, b) { var x = rankKey(a), y = rankKey(b); for (var i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; }
    function pairName(p) { var s = p.trigger.subjects; return (s[0].name || s[0].mmsi) + ' ↔ ' + (s[1].name || s[1].mmsi); }
    // 담당 해역 표시. 제안이 수신 범위 전체가 아니라 이 범위에서만 나온다는 걸 알려야,
    // 홍콩·일본 근해 사건이 안 보일 때 운용자가 고장으로 읽지 않는다.
    function aorText(box) {
        if (!box) return '담당 해역 제한 없음 · 수신 범위 전체에서 제안';
        return '담당 해역 위도 ' + box[0] + '~' + box[2] + '° · 경도 ' + box[1] + '~' + box[3] + '°';
    }
    function notableAlerts(proposals, seen, nowMs) {
        var next = Object.assign({}, seen), alerts = [];
        var open = proposals.filter(function (p) { return p.status === 'open' && !p.stale && p.trigger; }).sort(compareRank);
        function consider(p, kind, title, body) {
            var key = p.pair.join(':') + '|' + kind;
            // 시각을 참/거짓으로 보면 0 이 '본 적 없음' 이 된다 — 존재 여부로 판단한다.
            if (next[key] !== undefined && nowMs - next[key] < NOTIFY_REPEAT_MS) return;
            next[key] = nowMs;
            alerts.push({ id: p.id, kind: kind, title: title, body: body });
        }
        // 임박이 순위 변동보다 급하므로 먼저 모은다 — 알림창에는 첫 항목이 제목으로 뜬다.
        open.forEach(function (p) {
            var t = p.trigger;
            if (Number(t.tcpa_min) <= IMMINENT_TCPA_MIN) {
                consider(p, 'imminent', '최근접까지 ' + Number(t.tcpa_min).toFixed(1) + '분', pairName(p) + ' · DCPA ' + Number(t.dcpa_nm).toFixed(2) + ' nm');
            }
        });
        if (open[0]) {
            var t = open[0].trigger;
            consider(open[0], 'top', '가장 위험한 사건이 바뀌었습니다', pairName(open[0]) + ' · DCPA ' + Number(t.dcpa_nm).toFixed(2) + ' nm · TCPA ' + Number(t.tcpa_min).toFixed(1) + '분');
        }
        return { alerts: alerts, seen: next };
    }

    function initUI() {
        var panel = document.getElementById('proposalSection');
        if (!panel) return;
        var list = document.getElementById('proposalList'), hist = document.getElementById('proposalHistory');
        var message = document.getElementById('proposalMessage');
        var clientId=root.crypto.randomUUID();
        var store = createStore({fetchFn:root.fetch.bind(root),clientId:clientId,
            dispatchFn:function(p){return root.focusApprovedCollisionPair(p.pair[0],p.pair[1]);},
            stopFn:function(){root.stopApprovedPairTracking();},
            isTrackingFn:function(p){return root.isApprovedPairTracking(p.pair[0],p.pair[1]);}});
        var statuses = {open:'검토 대기',approved:'승인됨 · 실행 확인 대기',tracking:'추적 중',dismissed:'기각',expired:'만료',failed:'실행 실패',unknown:'실행·관측 상태 확인 불가',completed:'종료'};
        var reasons = {scenario_review_recorded:'시나리오 검토 기록',collision_rule:'충돌 위험 규칙',operator_decision:'운용자 판단',analysis_stale:'분석 데이터 갱신 지연',vessel_missing:'선박 데이터 없음',vessel_stale:'선박 수신 지연',vessel_invalid:'선박 데이터 오류',risk_changed:'제안 조건 변경·해소',risk_no_longer_listed:'최신 위험 목록에서 제외됨',execution_receipt_timeout:'추적 시작 확인 시간 초과',browser_heartbeat_timeout:'추적 화면 응답 끊김',map_tracking_started:'지도 추적 시작 확인',operator_stopped_tracking:'운용자가 추적 종료',map_tracking_stopped:'지도 추적 종료·대상 변경'};
        // 관측 공백은 위험 해소가 아니다. 제안은 열린 채로 남고 승인만 막히므로,
        // 왜 지금 승인할 수 없는지 카드에서 바로 말해준다.
        var staleNotes = {vessel_stale:'두 선박 중 한 척의 AIS 수신이 지연되고 있습니다.',
                          vessel_missing:'선박 관측을 일시적으로 찾지 못했습니다.',
                          analysis_stale:'충돌 분석 갱신이 지연되고 있습니다.'};
        function esc(v){return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
        function card(p) {
            var t=p.trigger, a=t.subjects[0], b=t.subjects[1], disabled=store.isBusy(p.id)?' disabled':'';
            // 관측이 지연된 동안 승인은 서버에서 어차피 거부된다. 누를 수 있게 두면
            // 거부 응답을 본 뒤에야 알게 되므로 미리 잠근다. 기각은 언제든 가능하다.
            // 지연 표시는 '검토 대기' 일 때만 뜻이 있다. 만료된 기록에도 stale 필드가
            // 남아 있어 '만료 · 관측 지연' 처럼 모순되게 읽히던 것을 막는다.
            var stale = p.status === 'open' ? p.stale : null;
            var approveOff = (disabled || stale) ? ' disabled' : '';
            var evidence=p.approval_evidence;
            var reviews=p.scenario_reviews || [];
            var approved=p.decision && p.decision.outcome==='approved';
            var latest=p.followup && p.followup.latest;
            var fresh=latest && latest.subjects.every(function(v){return Date.now()/1000-v._updated<=60;}) && p.followup.until>Date.now()/1000;
            return '<article class="proposal-card" data-id="'+esc(p.id)+'"><strong>'+esc(a.name || a.mmsi)+' ↔ '+esc(b.name || b.mmsi)+'</strong>'+
                '<div class="pc-status">'+esc(statuses[p.status])+(stale?'<span class="pc-stale">관측 지연</span>':'')+'</div>'+
                (stale?'<p class="pc-stale-note">'+esc(staleNotes[stale] || '관측 자료를 기다리는 중입니다.')+' 수신이 돌아오면 승인할 수 있습니다.</p>':'')+
                '<p>두 선박의 위치와 충돌 위험을 지도에서 집중 추적할 것을 제안합니다.</p>'+
                '<div>DCPA '+Number(t.dcpa_nm).toFixed(2)+' nm · TCPA '+Number(t.tcpa_min).toFixed(1)+'분</div>'+
                '<details data-pc="evidence"><summary>판단 근거·이력</summary><p>출처: '+(t.source==='ml'?'충돌 ML 분석':'CPA 거리 분석')+'<br>분석 시각: '+esc(t.analysis_at)+'<br>규칙: '+esc(p.rule.version)+' (프로젝트 내부 기준)</p>'+
                (evidence?'<p>승인 시 재계산: '+Number(evidence.dcpa_nm).toFixed(2)+' nm / '+Number(evidence.tcpa_min).toFixed(1)+'분<br>확인 시각: '+esc(evidence.checked_at)+'</p>':'')+
                (p.decision?'<p>판단 이유: '+esc(p.decision.reason)+' · 당시 검토 기록 '+(p.decision.scenario_review_ids || []).length+'건</p>':'')+
                reviews.map(function(r){return '<p>시나리오 '+esc(({reference:'참고안',deferred:'보류',rejected:'미채택'})[r.outcome])+' · '+esc(r.reason)+'<br>기간 내 최소 거리 '+Number(r.baseline_min_nm).toFixed(2)+' → '+Number(r.alternative_min_nm).toFixed(2)+' nm <button data-act="saved" data-run="'+esc(r.run_id)+'">비교 다시 보기</button></p>';}).join('')+
                '<ol>'+p.events.map(function(e){return '<li>'+esc(e.at)+' · '+esc(statuses[e.status])+' · '+esc(reasons[e.reason] || e.reason)+'</li>';}).join('')+'</ol></details>'+
                '<div class="pc-next"><p>'+ (p.status==='open'?'먼저 사건을 검토하고, 집중 추적이 필요한지 판단하세요.':approved?'승인 이후 관측과 지도 추적 상태를 확인하세요.':'저장된 사건 상태와 판단 기록을 확인하세요.')+'</p><button class="pc-primary" data-act="'+(approved?'followup':'investigate')+'">'+(approved?'승인 후 상태 확인':p.status==='open'?'사건 검토':'사건 기록 확인')+' →</button></div>'+
                (store.activeId()===p.id?'<div class="pc-actions"><button data-act="stop">추적 종료</button></div>':'')+
                (approved?'<div class="pc-tools"><button data-act="investigate">조사·판단 기록 보기</button></div>':'')+
                (p.status==='open'?'<details data-pc="manual" class="pc-manual"><summary>AI 조사 없이 직접 판단</summary><p>현재 근거를 직접 확인한 경우에 사용하세요. 승인은 지도 집중 추적을 시작합니다.</p><label>판단 이유 <input data-reason maxlength="500" placeholder="확인한 근거와 판단 이유" aria-label="판단 이유"></label><div class="pc-actions"><button data-act="approve"'+approveOff+'>집중 추적 승인</button><button data-act="dismiss"'+disabled+'>기각</button></div></details>':'')+
                '<div class="pc-knowledge"><button data-act="knowledge" data-question="basis">연결된 판단 근거 보기</button></div>'+
                (latest?'<p>관측 거리 '+Number(latest.distance_nm).toFixed(2)+' nm · '+(fresh?(latest.risk_state==='high'?'CPA 주의 조건 유지':'CPA 주의 조건 미충족'):'과거 기록 · 현재 위험 확인 불가')+'</p>':'')+'</article>';
        }
        // Preserve typed reasons and expanded evidence across polling renders.
        function render() {
            var inputs={}, opened={};
            var focused=document.activeElement;
            var focusedCard=focused && focused.closest('.proposal-card');
            var focusId=focusedCard && focused.tagName==='INPUT' ? focusedCard.dataset.id : null;
            var focusAction=focusedCard && focused.dataset.act;
            var focusDetails=focusedCard && focused.tagName==='SUMMARY' && focused.parentElement.dataset.pc;
            var caret=focusId ? [focused.selectionStart,focused.selectionEnd] : null;
            panel.querySelectorAll('.proposal-card').forEach(function(el){var i=el.querySelector('input');if(i)inputs[el.dataset.id]=i.value;el.querySelectorAll('details[data-pc]').forEach(function(d){opened[el.dataset.id+':'+d.dataset.pc]=d.open;});});
            var all=store.all(), active=all.filter(function(p){return ['open','approved','tracking'].indexOf(p.status)>=0;});
            list.innerHTML=active.length?active.map(card).join(''):'<div class="collision-empty">검토할 제안이 없습니다.</div>';
            hist.innerHTML=all.filter(function(p){return ['open','approved','tracking'].indexOf(p.status)<0;}).slice(0,30).map(card).join('');
            panel.querySelectorAll('.proposal-card').forEach(function(el){var i=el.querySelector('input');if(i){i.value=inputs[el.dataset.id] || '';if(el.dataset.id===focusId){i.focus();i.setSelectionRange(caret[0],caret[1]);}}el.querySelectorAll('details[data-pc]').forEach(function(d){d.open=!!opened[el.dataset.id+':'+d.dataset.pc];});});
            if(focusedCard && (focusAction||focusDetails)){
                var replacement=Array.from(panel.querySelectorAll('.proposal-card')).find(function(el){return el.dataset.id===focusedCard.dataset.id;});
                var target=replacement && (focusAction?replacement.querySelector('[data-act="'+focusAction+'"]'):replacement.querySelector('[data-pc="'+focusDetails+'"] > summary'));
                if(target)target.focus({preventScroll:true});
            }
            var badge=document.getElementById('proposalTabBadge');badge.textContent=active.length;badge.hidden=!active.length;
        }
        panel.addEventListener('click',function(e){var btn=e.target.closest('[data-act]');if(!btn)return;var el=btn.closest('[data-id]'),input=el.querySelector('input');message.textContent='';
            if(btn.dataset.act==='compare'){var p=store.all().find(function(p){return p.id===el.dataset.id;});root.CollisionScenarios.open(p.trigger.subjects[0].mmsi,p.trigger.subjects[1].mmsi,p.id);return;}
            if(btn.dataset.act==='knowledge'){root.KnowledgeEvidence.open(el.dataset.id,btn.dataset.question);return;}
            if(btn.dataset.act==='investigate'){root.InvestigationUI.open(el.dataset.id);return;}
            if(btn.dataset.act==='saved'){root.CollisionScenarios.openSaved(btn.dataset.run);return;}
            if(btn.dataset.act==='followup'){root.DecisionFollowup.open(el.dataset.id);return;}
            var action=btn.dataset.act==='approve'?store.approve(el.dataset.id,input.value):btn.dataset.act==='dismiss'?store.dismiss(el.dataset.id,input.value):store.stop();
            action.catch(function(err){message.textContent=err.message;});});
        // ── 브라우저 알림 ─────────────────────────────────────────────
        var NOTIFY_PREF = 'watchOfficer.notify';
        var notifyBtn = document.getElementById('proposalNotify'), notifyStatus = document.getElementById('proposalNotifyStatus');
        var notifySeen = {}, notifySeeded = false;
        function notifyWanted() { try { return root.localStorage.getItem(NOTIFY_PREF) === 'on'; } catch (_) { return false; } }
        function setNotifyWanted(on) { try { root.localStorage.setItem(NOTIFY_PREF, on ? 'on' : 'off'); } catch (_) {} }
        function syncNotifyControl() {
            if (!notifyBtn) return;
            // 브라우저 알림은 https 나 localhost 에서만 동작한다. 사내 IP 로 http 접속하면 API 자체가
            // 없으므로 버튼을 숨기고 이유를 말한다 — 눌러도 아무 일이 안 생기는 버튼을 두지 않는다.
            if (!('Notification' in root)) { notifyBtn.hidden = true; notifyStatus.textContent = '이 브라우저는 알림을 지원하지 않습니다.'; return; }
            if (!root.isSecureContext) { notifyBtn.hidden = true; notifyStatus.textContent = '알림은 https 또는 localhost 주소로 접속했을 때만 켤 수 있습니다.'; return; }
            var perm = root.Notification.permission, on = perm === 'granted' && notifyWanted();
            notifyBtn.hidden = false;
            notifyBtn.disabled = perm === 'denied';
            notifyBtn.setAttribute('aria-pressed', String(on));
            notifyBtn.textContent = on ? '알림 끄기' : '알림 켜기';
            notifyStatus.textContent = perm === 'denied' ? '브라우저에서 알림이 차단됐습니다. 사이트 설정에서 허용하세요.'
                : on ? '가장 위험한 사건이 바뀌거나 최근접 ' + IMMINENT_TCPA_MIN + '분 이내가 되면 알립니다.' : '';
        }
        if (notifyBtn) notifyBtn.addEventListener('click', function () {
            if (root.Notification.permission === 'granted') { setNotifyWanted(!notifyWanted()); syncNotifyControl(); return; }
            root.Notification.requestPermission().then(function (perm) { setNotifyWanted(perm === 'granted'); syncNotifyControl(); });
        });
        // 운용자가 이미 제안 탭을 보고 있으면 OS 알림은 소음이다.
        function proposalsInView() {
            var rp = document.getElementById('rightPanel'), view = document.getElementById('rightView-collision');
            return document.hasFocus() && !!rp && rp.classList.contains('open') && !!view && view.classList.contains('active') && !panel.hidden;
        }
        function maybeNotify() {
            var r = notableAlerts(store.all(), notifySeen, Date.now());
            notifySeen = r.seen;
            // 화면을 연 순간 쌓여 있던 사건을 한꺼번에 울리지 않는다 — 첫 조회는 기준만 잡는다.
            if (!notifySeeded) { notifySeeded = true; return; }
            if (!r.alerts.length || !('Notification' in root) || root.Notification.permission !== 'granted' || !notifyWanted() || proposalsInView()) return;
            var ids = r.alerts.map(function (a) { return a.id; }).filter(function (id, i, all) { return all.indexOf(id) === i; });
            var first = r.alerts[0];
            try {
                // tag 가 같으면 이전 알림을 대체한다 — 알림창이 쌓이지 않는다.
                var n = new root.Notification(ids.length > 1 ? first.title + ' 외 ' + (ids.length - 1) + '건' : first.title,
                                              {body: first.body, tag: 'watch-officer', renotify: true});
                n.onclick = function () {
                    root.focus();
                    if (root.LayoutManager) root.LayoutManager.openRightPanel('collision');
                    if (root.switchCollisionTab) root.switchCollisionTab('proposals');
                    if (root.InvestigationUI) root.InvestigationUI.open(first.id);
                    n.close();
                };
            } catch (_) { /* 일부 모바일 브라우저는 생성자 알림을 막는다 — 앱 안 배지로 충분하다 */ }
        }
        syncNotifyControl();

        // ── 당직 인계 ─────────────────────────────────────────────────
        var HANDOFF_NAME = 'watchOfficer.operator';
        // 404·405 는 화면(JS)은 새것인데 백엔드는 인계 기능이 들어오기 전에 띄운 경우다. 정적 파일은
        // 디스크에서 바로 읽히지만 API 라우트는 서버를 띄운 시점의 코드로 고정된다. 'Method Not Allowed'
        // 같은 원문 대신 무슨 일인지와 할 일을 말한다.
        var STALE_BACKEND = '이 백엔드는 인계 기능이 들어오기 전에 띄운 서버입니다. 백엔드를 재시작한 뒤 새로고침하세요.';
        function isStaleBackend(res) { return res.status === 404 || res.status === 405; }
        function shortTime(v) {
            var d = new Date(v);
            return isNaN(d) ? '' : d.toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
        }
        function namesOf(p) { var s = p.trigger.subjects; return esc(s[0].name || s[0].mmsi) + ' ↔ ' + esc(s[1].name || s[1].mmsi); }
        function openHandoff() {
            var previous = document.activeElement, dialog = document.createElement('dialog');
            dialog.className = 'handoff-dialog';
            dialog.setAttribute('aria-label', '당직 인계');
            dialog.innerHTML =
                '<header><div><h2>당직 인계</h2><p class="handoff-last" data-h="last">인계 기록을 불러오는 중입니다…</p></div><button type="button" data-h="close">닫기 ×</button></header>' +
                '<p class="handoff-intro">지난 인계 이후 어떤 판단이 있었고 지금 무엇을 넘겨받는지 확인한 뒤 이어받으세요.</p>' +
                '<section><h3>지금 판단이 필요한 사건 <span data-h="openCount"></span></h3><ol class="handoff-list" data-h="open"></ol></section>' +
                '<section><h3>추적 중인 사건 <span data-h="activeCount"></span></h3><ol class="handoff-list" data-h="active"></ol></section>' +
                '<section><h3>지난 인계 이후 판단 <span data-h="decisionCount"></span></h3><ol class="handoff-list" data-h="decisions"></ol></section>' +
                '<form class="handoff-form" data-h="form"><label>당직자 이름<input data-h="operator" maxlength="40" required autocomplete="name"></label>' +
                '<label>인계 메모 <small>선택</small><textarea data-h="note" maxlength="500" placeholder="다음 당직자가 알아야 할 것"></textarea></label>' +
                '<p class="pc-note">이름은 로그인으로 확인하지 않는 자기 기재 값입니다. 이어받는 순간 열려 있던 사건 목록이 인계 기록에 함께 남습니다.</p>' +
                '<div class="handoff-actions"><button type="submit" class="handoff-submit">이어받기</button><p data-h="message" role="status"></p></div></form>';
            document.body.appendChild(dialog); dialog.showModal();
            var $ = function (name) { return dialog.querySelector('[data-h="' + name + '"]'); };
            function close() { dialog.remove(); if (previous && previous.isConnected) previous.focus(); }
            $('close').onclick = close;
            dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
            try { $('operator').value = root.localStorage.getItem(HANDOFF_NAME) || ''; } catch (_) {}

            function fill(listName, countName, items, row, empty) {
                $(countName).textContent = items.length ? items.length + '건' : '';
                $(listName).innerHTML = items.length ? items.map(row).join('') : '<li class="handoff-empty">' + empty + '</li>';
            }
            async function load() {
                try {
                    var res = await root.fetch(API + '/handoff');
                    if (isStaleBackend(res)) throw new Error(STALE_BACKEND);
                    if (!res.ok) throw new Error('요청 실패 (' + res.status + ')');
                    var d = await res.json();
                    var last = d.last_handoff;
                    $('last').textContent = (last
                        ? '마지막 인계 · ' + shortTime(last.at) + ' · ' + last.operator + (last.note ? ' · “' + last.note + '”' : '')
                        : '아직 인계 기록이 없어 최근 12시간을 보여줍니다.') + ' · 기준 ' + shortTime(d.generated_at) + ' · ' + aorText(d.aor);
                    fill('open', 'openCount', d.open, function (p) {
                        var stale = p.stale ? '<span class="pc-stale">관측 지연</span>' : '';
                        return '<li><div><strong>' + namesOf(p) + '</strong>' + stale + '<small>DCPA ' + Number(p.trigger.dcpa_nm).toFixed(2) + ' nm · TCPA ' + Number(p.trigger.tcpa_min).toFixed(1) + '분</small></div>' +
                               '<button type="button" data-h-review="' + esc(p.id) + '">사건 검토</button></li>';
                    }, '지금 판단을 기다리는 사건이 없습니다.');
                    fill('active', 'activeCount', d.active, function (p) {
                        return '<li><div><strong>' + namesOf(p) + '</strong><small>' + esc(statuses[p.status] || p.status) + '</small></div>' +
                               '<button type="button" data-h-followup="' + esc(p.id) + '">후속 확인</button></li>';
                    }, '추적 중인 사건이 없습니다.');
                    fill('decisions', 'decisionCount', d.decisions, function (x) {
                        return '<li><div><strong>' + esc(x.names.join(' ↔ ')) + '</strong><small>' + (x.outcome === 'approved' ? '승인' : '기각') + ' · ' + esc(shortTime(x.at)) + ' · ' + esc(x.reason) + '</small></div></li>';
                    }, '지난 인계 이후 기록된 판단이 없습니다.');
                } catch (e) {
                    $('last').textContent = '인계 정보를 불러오지 못했습니다: ' + e.message;
                    // 기록할 수 없는 서버에서 이어받기를 누르게 두지 않는다.
                    if (e.message === STALE_BACKEND) { dialog.querySelector('.handoff-submit').disabled = true; $('message').textContent = STALE_BACKEND; }
                }
            }
            dialog.addEventListener('click', function (e) {
                var review = e.target.closest('[data-h-review]'), follow = e.target.closest('[data-h-followup]');
                if (review) { close(); root.InvestigationUI.open(review.dataset.hReview); }
                else if (follow) { close(); root.DecisionFollowup.open(follow.dataset.hFollowup); }
            });
            $('form').addEventListener('submit', async function (e) {
                e.preventDefault();
                var btn = dialog.querySelector('.handoff-submit'), operator = $('operator').value.trim();
                if (!operator) { $('message').textContent = '당직자 이름을 입력하세요.'; return; }
                btn.disabled = true; $('message').textContent = '';
                try {
                    var res = await root.fetch(API + '/handoffs', {method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({operator: operator, note: $('note').value, client_id: clientId})});
                    if (isStaleBackend(res)) throw new Error(STALE_BACKEND);
                    var body = await res.json();
                    if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : '입력을 확인하세요.');
                    try { root.localStorage.setItem(HANDOFF_NAME, body.operator); } catch (_) {}
                    $('note').value = '';
                    $('message').textContent = '이어받기를 기록했습니다 · ' + shortTime(body.at) + ' · ' + body.operator;
                    await load();
                } catch (err) {
                    $('message').textContent = '기록하지 못했습니다: ' + err.message;
                } finally { btn.disabled = false; }
            });
            load();
        }
        var handoffBtn = document.getElementById('proposalHandoff');
        if (handoffBtn) handoffBtn.addEventListener('click', openHandoff);

        store.onChange(render);
        var polling=false, pollError='';
        async function poll(){
            if(polling)return; polling=true;
            try {
                var loaded = await store.load();
                var aorEl = document.getElementById('proposalAor');
                if (aorEl && loaded && 'aor' in loaded) aorEl.textContent = aorText(loaded.aor);
                maybeNotify();
                if(message.textContent===pollError) message.textContent='';
                pollError=''; render();
            } catch(e) {
                pollError='상태 갱신 실패: '+e.message; message.textContent=pollError;
                if(!store.all().length) list.innerHTML='<div class="collision-empty">제안 정보를 불러오지 못했습니다.</div>';
            } finally {polling=false;}
        }
        poll(); root.setInterval(poll,5000); render();
        return {store:store,clientId:clientId,openHandoff:openHandoff};
    }
    if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded',function(){root.WatchOfficerUI=initUI();});
    if (typeof module !== 'undefined' && module.exports) module.exports={createStore:createStore,validateProposal:validateProposal,notableAlerts:notableAlerts,aorText:aorText,compareRank:compareRank,IMMINENT_TCPA_MIN:IMMINENT_TCPA_MIN,NOTIFY_REPEAT_MS:NOTIFY_REPEAT_MS};
})(typeof window !== 'undefined'?window:globalThis);
