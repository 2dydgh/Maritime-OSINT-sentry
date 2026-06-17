import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../../static/js/gerstner.js');

const WX = { waveHeight: 3, wavePeriod: 8, waveDirection: 30 };

test('buildWaves returns 4 deterministic components with valid params', () => {
  const a = G.buildWaves(WX);
  const b = G.buildWaves(WX);
  assert.equal(a.length, 4);
  assert.deepEqual(a, b); // deterministic, no Math.random
  for (const w of a) {
    assert.ok(w.k > 0, 'k must be positive');
    assert.ok(w.A >= 0, 'A must be non-negative');
    assert.ok(w.omega > 0, 'omega must be positive');
    assert.ok(isFinite(w.dirX) && isFinite(w.dirY));
  }
});

test('primary swell amplitude is half the wave height', () => {
  const w = G.buildWaves(WX)[0];
  assert.ok(Math.abs(w.A - WX.waveHeight / 2) < 1e-9);
});

test('primary swell temporal period equals wavePeriod', () => {
  const w = G.buildWaves(WX)[0];
  // omega = 2*pi / T  =>  T = 2*pi / omega
  assert.ok(Math.abs((2 * Math.PI) / w.omega - WX.wavePeriod) < 1e-9);
});

test('zero wave height yields zero amplitudes and zero height', () => {
  const waves = G.buildWaves({ waveHeight: 0, wavePeriod: 8, waveDirection: 0 });
  for (const w of waves) assert.equal(w.A, 0);
  assert.equal(G.heightAt(waves, 0, 0, 3.21), 0);
});

test('heightAt is 0 for empty/missing waves and reproducible otherwise', () => {
  assert.equal(G.heightAt([], 0, 0, 1), 0);
  assert.equal(G.heightAt(null, 0, 0, 1), 0);
  const waves = G.buildWaves(WX);
  assert.equal(G.heightAt(waves, 0, 0, 2.5), G.heightAt(waves, 0, 0, 2.5));
});

test('heightAt at origin is bounded by sum of amplitudes', () => {
  const waves = G.buildWaves(WX);
  const sumA = waves.reduce((s, w) => s + w.A, 0);
  for (let t = 0; t < 20; t += 0.37) {
    const h = G.heightAt(waves, 0, 0, t);
    assert.ok(Math.abs(h) <= sumA + 1e-9, `|h|=${Math.abs(h)} exceeds sumA=${sumA} at t=${t}`);
  }
});

test('steepness invariant: sum(Q*k*A) <= 1 (no looping crests)', () => {
  const waves = G.buildWaves({ waveHeight: 9, wavePeriod: 12, waveDirection: 200 });
  const s = waves.reduce((acc, w) => acc + w.Q * w.k * w.A, 0);
  assert.ok(s <= 1 + 1e-9, `steepness sum ${s} > 1`);
});

test('non-zero wave height yields positive steepness Q on every component', () => {
  const waves = G.buildWaves(WX);
  for (const w of waves) assert.ok(w.Q > 0, `Q must be > 0, got ${w.Q}`);
});

test('GLSL_SNIPPET exposes the shared symbols', () => {
  assert.equal(typeof G.GLSL_SNIPPET, 'string');
  assert.match(G.GLSL_SNIPPET, /gerstnerDisplace/);
  assert.match(G.GLSL_SNIPPET, /#define MAX_WAVES 6/);
  assert.equal(G.MAX_WAVES, 6);
});
