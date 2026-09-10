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

    var api = { createStore: createStore };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WatchOfficer = api;
})(typeof window !== 'undefined' ? window : globalThis);
