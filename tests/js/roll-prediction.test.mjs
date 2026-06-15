import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RP = require('../../static/js/roll-prediction.js');

test('predictRoll is deterministic for same inputs', () => {
  const actual = { roll: 12, pitch: 3 };
  const ctx = { seed: 'cargo', t: 5.0 };
  const a = RP.predictRoll(actual, ctx);
  const b = RP.predictRoll(actual, ctx);
  assert.deepEqual(a, b);
});

test('predictRoll stays near actual (gain 0.8~1.0, bounded offset)', () => {
  const actual = { roll: 10, pitch: 2 };
  for (let t = 0; t < 20; t += 0.5) {
    const p = RP.predictRoll(actual, { seed: 'tanker', t });
    assert.ok(Math.abs(p.roll - actual.roll) <= 4, `roll off too far at t=${t}: ${p.roll}`);
    assert.ok(Math.abs(p.pitch - actual.pitch) <= 2, `pitch off too far at t=${t}`);
  }
});

test('different seeds produce different predictions', () => {
  const actual = { roll: 10, pitch: 2 };
  const a = RP.predictRoll(actual, { seed: 'cargo', t: 3 });
  const b = RP.predictRoll(actual, { seed: 'fishing', t: 3 });
  assert.notDeepEqual(a, b);
});

test('computeDelta returns signed differences', () => {
  const d = RP.computeDelta({ roll: 12, pitch: 3 }, { roll: 9, pitch: 2 });
  assert.equal(d.dRoll, 3);
  assert.equal(d.dPitch, 1);
});

test('computeRMSE of identical series is 0', () => {
  assert.equal(RP.computeRMSE([1, 2, 3], [1, 2, 3]), 0);
});

test('computeRMSE matches known value', () => {
  // errors: [0, 2, 0] -> mean(sq)=4/3 -> sqrt
  const v = RP.computeRMSE([1, 2, 3], [1, 4, 3]);
  assert.ok(Math.abs(v - Math.sqrt(4 / 3)) < 1e-9);
});

test('computeRMSE handles empty / mismatched length safely', () => {
  assert.equal(RP.computeRMSE([], []), 0);
  assert.equal(RP.computeRMSE([1, 2], [1]), 0); // length mismatch -> 0, no throw
});
