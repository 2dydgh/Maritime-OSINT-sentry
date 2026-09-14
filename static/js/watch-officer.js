// ── Maritime OSINT Sentry — 당직사관(Watch Officer) 제안 트레이 ──
// 서버 규칙이 만든 조치 제안을 카드로 보여주고, 승인 시 chat.js의 액션 디스패처로 실행한다.
// 위쪽 createStore는 DOM 없는 순수 상태라 node --test 로 검증한다.
(function (root) {
    'use strict';

    var API = '/api/v1/proposals';

    function createStore(opts) {
        var fetchFn = opts.fetchFn;
        var dispatchFn = opts.dispatchFn;
        var byId = {};
        var listeners = [];

        function notify() { listeners.forEach(function (fn) { fn(); }); }

        function receive(type, p) {
            if (!p || !p.id) return 'ignored';
            var cur = byId[p.id];
            if (!cur) { byId[p.id] = p; notify(); return 'added'; }
            if (p.updated_at < cur.updated_at) return 'ignored';
            byId[p.id] = p; notify(); return 'updated';
        }

        function all() { return Object.keys(byId).map(function (k) { return byId[k]; }); }
        function newestFirst(a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; }
        function open() { return all().filter(function (p) { return p.status === 'open'; }).sort(newestFirst); }
        function history(limit) {
            return all().filter(function (p) { return p.status !== 'open'; }).sort(newestFirst).slice(0, limit || 20);
        }

        function post(id, outcome, reason) {
            var p = byId[id];
            if (!p || p.status !== 'open') return Promise.reject(new Error('not open'));
            p.status = outcome;                       // 낙관적 갱신
            notify();
            return fetchFn(API + '/' + encodeURIComponent(id) + '/decision', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ outcome: outcome, reason: reason || null })
            }).then(function (res) {
                if (!res.ok) throw new Error('decision failed: ' + res.status);
                return res.json();
            }).then(function (rec) {
                byId[id] = rec; notify(); return rec;
            }).catch(function (err) {
                p.status = 'open'; notify(); throw err;
            });
        }

        function approve(id) {
            var p = byId[id];
            if (!p || p.status !== 'open') return Promise.reject(new Error('not open'));
            (p.actions || []).forEach(function (a) { dispatchFn(a); });
            return post(id, 'approved', null);
        }

        function dismiss(id, reason) { return post(id, 'dismissed', reason); }

        function load() {
            return fetchFn(API + '?limit=50').then(function (res) { return res.json(); }).then(function (data) {
                (data.proposals || []).forEach(function (p) { byId[p.id] = p; });
                notify();
            });
        }

        return {
            receive: receive, load: load, get: function (id) { return byId[id]; },
            open: open, history: history, openCount: function () { return open().length; },
            approve: approve, dismiss: dismiss, onChange: function (fn) { listeners.push(fn); }
        };
    }

    // ── DOM (브라우저 전용) ──
    function initUI() {
        if (typeof document === 'undefined') return null;
        var list = document.getElementById('proposalList');
        var hist = document.getElementById('proposalHistory');
        var badge = document.getElementById('proposalTabBadge');
        var drawer = document.getElementById('proposalDrawer');
        if (!list) return null;

        var store = createStore({
            fetchFn: function (u, o) { return fetch(u, o); },
            dispatchFn: function (a) { if (window.dispatchAgentAction) window.dispatchAgentAction(a); }
        });

        function sevHex(p) {
            var lvl = p.trigger.risk_level;
            if (typeof _mlHex === 'function') return _mlHex(lvl == null ? 3 : lvl);
            return '#e5484d';
        }
        function enc(p) { return { 'head-on': '정면', crossing: '횡단', overtaking: '추월' }[p.trigger.encounter] || '근접'; }
        function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
        function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toISOString().substring(11, 16) + 'Z'; }

        function card(p) {
            var a = p.subjects[0], b = p.subjects[1], t = p.trigger;
            var done = p.status !== 'open';
            var statusKo = { approved: '승인됨', dismissed: '기각됨', expired: '만료' }[p.status];
            return '<div class="collision-row proposal-card' + (done ? ' done' : '') + '" data-id="' + esc(p.id) + '" style="--row-sev:' + sevHex(p) + '">' +
                '<div class="cr-row1"><span class="cr-ship-a">' + esc(a.name) + '</span><small>↔</small><span class="cr-ship-b">' + esc(b.name) + '</span>' +
                '<span class="cr-sev" style="color:' + sevHex(p) + '">' + esc(t.risk_label) + '</span></div>' +
                '<div class="pc-brief">' + esc(p.brief) + (p.brief_source === 'ollama' ? ' <span class="pc-src">AI</span>' : '') + '</div>' +
                '<button type="button" class="pc-evidence" data-act="graph">DCPA ' + Number(t.dcpa_nm).toFixed(2) + ' nm · TCPA ' + Number(t.tcpa_min).toFixed(1) + '분 · ' + enc(p) + ' · 근거 ▸</button>' +
                (done
                    ? '<div class="pc-status">' + statusKo + ' ' + hhmm(p.updated_at) + (p.decision && p.decision.reason ? ' · ' + esc(p.decision.reason) : '') + '</div>'
                    : '<div class="pc-actions"><button type="button" class="pc-btn pc-approve" data-act="approve">승인</button>' +
                      '<select class="pc-reason" data-role="reason"><option value="false_positive">오탐</option><option value="already_handled">이미 조치</option><option value="monitor">관망</option></select>' +
                      '<button type="button" class="pc-btn pc-dismiss" data-act="dismiss">기각</button></div>') +
                '</div>';
        }

        function render() {
            var open = store.open();
            list.innerHTML = open.length ? open.map(card).join('') : '<div class="collision-empty">열린 제안 없음</div>';
            if (hist) hist.innerHTML = store.history(20).map(card).join('');
            if (badge) { badge.textContent = open.length; badge.hidden = open.length === 0; }
        }

        function showGraph(id) {
            var url = API + '/' + encodeURIComponent(id) + '/graph';
            document.getElementById('proposalTtlLink').href = url + '?format=turtle';
            fetch(url + '?format=json-ld').then(function (r) { return r.json(); }).then(function (nodes) {
                var order = ['Observation', 'RiskAssessment', 'Encounter', 'Proposal', 'Decision'];
                function short(iri) { return String(iri).split(/[#\/]/).slice(-2).join('/'); }
                function rank(n) { var t = (n['@type'] || []).map(short).join(' '); var i = order.findIndex(function (o) { return t.indexOf(o) >= 0; }); return i < 0 ? 99 : i; }
                var lines = nodes.filter(function (n) { return n['@type']; }).sort(function (x, y) { return rank(x) - rank(y); }).map(function (n) {
                    var head = '[' + (n['@type'] || []).map(short).join(',') + '] ' + short(n['@id']);
                    var edges = Object.keys(n).filter(function (k) { return k[0] !== '@'; }).map(function (k) {
                        var v = n[k].map(function (o) { return o['@id'] ? short(o['@id']) : String(o['@value']).slice(0, 60); }).join(', ');
                        return '    ' + short(k) + ' → ' + v;
                    });
                    return [head].concat(edges).join('\n');
                });
                document.getElementById('proposalDrawerBody').textContent = lines.join('\n\n');
                drawer.hidden = false;
            }).catch(function (e) { console.error('[WatchOfficer] graph fetch failed', e); });
        }

        list.parentElement.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-act]');
            if (!btn) return;
            var cardEl = btn.closest('.proposal-card');
            var id = cardEl && cardEl.dataset.id;
            if (!id) return;
            if (btn.dataset.act === 'approve') store.approve(id).catch(function (err) { console.error('[WatchOfficer]', err); });
            else if (btn.dataset.act === 'dismiss') {
                var sel = cardEl.querySelector('[data-role=reason]');
                store.dismiss(id, sel ? sel.value : null).catch(function (err) { console.error('[WatchOfficer]', err); });
            }
            else if (btn.dataset.act === 'graph') showGraph(id);
        });
        var closeBtn = document.getElementById('proposalDrawerClose');
        if (closeBtn) closeBtn.addEventListener('click', function () { drawer.hidden = true; });

        store.onChange(render);
        if (root.EventBus) root.EventBus.on('proposal:message', function (m) { store.receive(m.type, m.proposal); });
        store.load().catch(function (e) { console.warn('[WatchOfficer] initial load failed', e); });
        render();
        return { openCount: store.openCount, store: store };
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', function () { root.WatchOfficerUI = initUI(); });
    }

    var api = { createStore: createStore, initUI: initUI };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WatchOfficer = api;
})(typeof window !== 'undefined' ? window : globalThis);
