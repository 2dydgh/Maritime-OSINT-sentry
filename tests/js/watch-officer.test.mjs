import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStore } = require('../../static/js/watch-officer.js');

function rec(id, over = {}) {
    return {
        id, created_at: '2026-09-10T03:12:00Z', updated_at: '2026-09-10T03:12:00Z',
        trigger: { kind: 'collision_risk', source: 'ml', risk_level: 3, risk_label: '위험', dcpa_nm: 0.5, tcpa_min: 8, encounter: 'crossing' },
        subjects: [{ mmsi: 111, name: 'ALPHA' }, { mmsi: 222, name: 'BRAVO' }],
        brief: 'b', brief_source: 'template',
        actions: [{ action: 'fly_to', lat: 35, lon: 129, zoom: 12 }, { action: 'highlight_pair', mmsi: [111, 222], risk_level: 3 }],
        status: 'open', decision: null, ...over,
    };
}

function mkFetch(responses) {
    const calls = [];
    const fn = (url, opts) => {
        calls.push({ url, opts });
        const r = responses.shift() || { ok: true, status: 200, body: {} };
        return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
    };
    return { fn, calls };
}

test('receive adds, updates, ignores stale', () => {
    const s = createStore({ fetchFn: () => {}, dispatchFn: () => {} });
    assert.equal(s.receive('proposal', rec('a')), 'added');
    assert.equal(s.receive('proposal_update', rec('a', { updated_at: '2026-09-10T03:13:00Z', brief: 'new' })), 'updated');
    assert.equal(s.get('a').brief, 'new');
    assert.equal(s.receive('proposal_update', rec('a', { updated_at: '2026-09-10T03:12:30Z', brief: 'old' })), 'ignored');
    assert.equal(s.get('a').brief, 'new');
    assert.equal(s.receive('proposal_update', rec('zzz')), 'added');   // 모르는 id의 update도 추가
});

test('open/history ordering and counts', () => {
    const s = createStore({ fetchFn: () => {}, dispatchFn: () => {} });
    s.receive('proposal', rec('a', { created_at: '2026-09-10T03:00:00Z' }));
    s.receive('proposal', rec('b', { created_at: '2026-09-10T03:05:00Z' }));
    s.receive('proposal', rec('c', { created_at: '2026-09-10T03:01:00Z', status: 'expired' }));
    assert.deepEqual(s.open().map(p => p.id), ['b', 'a']);
    assert.deepEqual(s.history().map(p => p.id), ['c']);
    assert.equal(s.openCount(), 2);
});

test('approve dispatches actions in order then POSTs', async () => {
    const dispatched = [];
    const f = mkFetch([{ ok: true, status: 200, body: rec('a', { status: 'approved' }) }]);
    const s = createStore({ fetchFn: f.fn, dispatchFn: a => dispatched.push(a.action) });
    s.receive('proposal', rec('a'));
    const out = await s.approve('a');
    assert.deepEqual(dispatched, ['fly_to', 'highlight_pair']);
    assert.equal(f.calls[0].url, '/api/v1/proposals/a/decision');
    assert.deepEqual(JSON.parse(f.calls[0].opts.body), { outcome: 'approved', reason: null });
    assert.equal(out.status, 'approved');
    assert.equal(s.openCount(), 0);
    assert.deepEqual(s.history().map(p => p.id), ['a']);
});

test('dismiss sends reason and does not dispatch', async () => {
    const dispatched = [];
    const f = mkFetch([{ ok: true, status: 200, body: rec('a', { status: 'dismissed' }) }]);
    const s = createStore({ fetchFn: f.fn, dispatchFn: a => dispatched.push(a) });
    s.receive('proposal', rec('a'));
    await s.dismiss('a', 'false_positive');
    assert.deepEqual(dispatched, []);
    assert.deepEqual(JSON.parse(f.calls[0].opts.body), { outcome: 'dismissed', reason: 'false_positive' });
});

test('failed POST restores open status and rejects', async () => {
    const f = mkFetch([{ ok: false, status: 409, body: { detail: 'not open' } }]);
    const s = createStore({ fetchFn: f.fn, dispatchFn: () => {} });
    s.receive('proposal', rec('a'));
    await assert.rejects(() => s.dismiss('a', 'monitor'));
    assert.equal(s.get('a').status, 'open');
});

test('load fetches list and notifies', async () => {
    const f = mkFetch([{ ok: true, status: 200, body: { proposals: [rec('x'), rec('y', { status: 'approved' })], total: 2 } }]);
    const s = createStore({ fetchFn: f.fn, dispatchFn: () => {} });
    let n = 0; s.onChange(() => n++);
    await s.load();
    assert.equal(f.calls[0].url, '/api/v1/proposals?limit=50');
    assert.equal(s.openCount(), 1);
    assert.ok(n >= 1);
});
