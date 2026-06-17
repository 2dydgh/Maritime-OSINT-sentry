# Gerstner Ocean + Ship Heave Coupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `THREE.Water` plane in the Roll viewer with Gerstner displacement waves and make the ship ride the actual wave surface (heave coupling), without touching the measured roll/pitch signal.

**Architecture:** A new `static/js/gerstner.js` module holds the wave field math shared by GPU and CPU: `buildWaves(weather)` derives wave specs, `heightAt(...)` samples surface height on the CPU (for ship heave), and `GLSL_SNIPPET` is the identical displacement injected into THREE.Water's vertex shader by string-patch. `roll-viewer.js` patches the water shader in `buildWater`, drives a `uTime` uniform from `simWaveTime`, and replaces the fake `sin` heave with a `heightAt` sample at the water-plane local origin.

**Tech Stack:** Plain ES5-style browser JS (matches `roll-prediction.js`), THREE.js r137 (`THREE.Water` from `examples/js/objects/Water.js`), `node:test` for unit tests.

## Global Constraints

- No `Math.random()` in wave generation — deterministic (matches `roll-prediction.js` convention).
- `gerstner.js` uses the UMD pattern: `module.exports = api` for node:test, else `root.Gerstner = api`. Same shape as `static/js/roll-prediction.js`.
- GPU and CPU MUST use identical wave math (same `k`, `A`, `omega`, `Q`, same phase formula) or the ship won't ride the visible waves.
- The measured roll/pitch (`smoothRoll`/`smoothPitch`) and capsize logic are NOT modified. Only `shipGroup.position.y` (heave) changes.
- Graceful degrade (per CLAUDE.md): if the shader patch throws, fall back to flat water; if `window.Gerstner` is absent, fall back to the original `sin` heave.
- `MAX_WAVES = 6` must be identical in `gerstner.js` (JS array padding) and in `GLSL_SNIPPET` (`#define MAX_WAVES 6`).
- Static asset cache: after editing JS, bump the `?v=` query in `static/index.html` (dev may run without `DEV_NO_CACHE`).

---

### Task 1: Gerstner wave module (`gerstner.js`) + unit tests

**Files:**
- Create: `static/js/gerstner.js`
- Test: `tests/js/gerstner.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (relied on by Task 3):
  - `Gerstner.buildWaves(weather)` → `Array<{ dirX:number, dirY:number, k:number, A:number, omega:number, Q:number }>`. `weather` = `{ waveHeight:number, wavePeriod:number, waveDirection:number }` (degrees).
  - `Gerstner.heightAt(waves, px, py, t)` → `number` (surface height; ship calls with `px=0, py=0`).
  - `Gerstner.GLSL_SNIPPET` → `string` (GLSL declaring `uTime`, `uWaveCount`, `uWaveDir[MAX_WAVES]`, `uWaveParams[MAX_WAVES]` where `uWaveParams[i] = vec4(k, A, omega, Q)`, and function `vec3 gerstnerDisplace(vec2 p)`).
  - `Gerstner.MAX_WAVES` → `6`.

- [ ] **Step 1: Write the failing test**

Create `tests/js/gerstner.test.mjs`:

```javascript
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

test('GLSL_SNIPPET exposes the shared symbols', () => {
  assert.equal(typeof G.GLSL_SNIPPET, 'string');
  assert.match(G.GLSL_SNIPPET, /gerstnerDisplace/);
  assert.match(G.GLSL_SNIPPET, /#define MAX_WAVES 6/);
  assert.equal(G.MAX_WAVES, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/js/gerstner.test.mjs`
Expected: FAIL — `Cannot find module '../../static/js/gerstner.js'`.

- [ ] **Step 3: Write the module**

Create `static/js/gerstner.js`:

```javascript
// ── Gerstner wave field — shared GPU/CPU math ──
// GPU (GLSL_SNIPPET) and CPU (heightAt) use the SAME k/A/omega/Q and phase
// formula so the ship rides the visible waves. No Math.random — deterministic.
(function (root) {
  'use strict';

  var MAX_WAVES = 6;            // must equal #define MAX_WAVES in GLSL_SNIPPET
  var BASE_WAVELENGTH = 60;     // scene-unit wavelength of the primary swell at T=8s (visual tuning)

  // Component table: [angleOffsetDeg, wavelengthScale, amplitudeScale, periodScale]
  var COMPONENTS = [
    [0,    1.00, 1.00, 1.00],   // primary swell — period == wavePeriod
    [22,   0.55, 0.42, 0.65],
    [-38,  0.38, 0.28, 0.50],
    [58,   0.26, 0.16, 0.38]
  ];

  function buildWaves(weather) {
    var waveHeight = Math.max(0, (weather && weather.waveHeight) || 0);
    var T = Math.max(1, (weather && weather.wavePeriod) || 8);
    var dirRad = ((weather && weather.waveDirection) || 0) * Math.PI / 180;
    var A0 = waveHeight / 2;                 // amplitude = half of crest-to-trough
    var L0 = BASE_WAVELENGTH * (T / 8);      // longer period -> longer swell

    var waves = [];
    for (var i = 0; i < COMPONENTS.length; i++) {
      var c = COMPONENTS[i];
      var ang = dirRad + c[0] * Math.PI / 180;
      var L = Math.max(1, L0 * c[1]);
      var A = A0 * c[2];
      var Ti = T * c[3];
      waves.push({
        dirX: Math.cos(ang),
        dirY: Math.sin(ang),
        k: 2 * Math.PI / L,
        A: A,
        omega: 2 * Math.PI / Ti,
        Q: 0
      });
    }

    // Steepness clamp: keep sum(Q*k*A) <= 1 so crests don't loop/pinch.
    var denom = 0;
    for (var j = 0; j < waves.length; j++) denom += waves[j].k * waves[j].A;
    var Q = denom > 0 ? (0.75 / denom) : 0;
    for (var m = 0; m < waves.length; m++) waves[m].Q = Q;

    return waves;
  }

  // Surface height at plane-local (px, py) and time t. Ship samples (0, 0).
  function heightAt(waves, px, py, t) {
    if (!waves || !waves.length) return 0;
    var h = 0;
    for (var i = 0; i < waves.length; i++) {
      var w = waves[i];
      if (!(w.A > 0)) continue;
      var phase = w.k * (w.dirX * px + w.dirY * py) - w.omega * t;
      h += w.A * Math.cos(phase);
    }
    return h;
  }

  // GLSL injected into THREE.Water's vertex shader. Same math as heightAt,
  // plus horizontal (choppy) displacement. uWaveParams[i] = vec4(k, A, omega, Q).
  var GLSL_SNIPPET = [
    '#define MAX_WAVES 6',
    'uniform float uTime;',
    'uniform int uWaveCount;',
    'uniform vec2 uWaveDir[ MAX_WAVES ];',
    'uniform vec4 uWaveParams[ MAX_WAVES ];',
    'vec3 gerstnerDisplace( vec2 p ) {',
    '  vec3 acc = vec3( 0.0 );',
    '  for ( int i = 0; i < MAX_WAVES; i++ ) {',
    '    if ( i >= uWaveCount ) break;',
    '    vec2 d = uWaveDir[ i ];',
    '    float k = uWaveParams[ i ].x;',
    '    float A = uWaveParams[ i ].y;',
    '    float w = uWaveParams[ i ].z;',
    '    float Q = uWaveParams[ i ].w;',
    '    float phase = k * dot( d, p ) - w * uTime;',
    '    acc.xy += d * ( Q * A * sin( phase ) );',
    '    acc.z  += A * cos( phase );',
    '  }',
    '  return acc;',
    '}'
  ].join('\n');

  var api = {
    buildWaves: buildWaves,
    heightAt: heightAt,
    GLSL_SNIPPET: GLSL_SNIPPET,
    MAX_WAVES: MAX_WAVES
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // node:test
  } else {
    root.Gerstner = api;             // browser global
  }
})(typeof window !== 'undefined' ? window : globalThis);
```

Note: GLSL phase uses `w * uTime` (w = omega = ω), matching `heightAt`'s `w.omega * t`. Both omit the spatial term at the ship sample because ship samples `p = (0,0)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/js/gerstner.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add static/js/gerstner.js tests/js/gerstner.test.mjs
git commit -m "feat(roll): Gerstner wave field module (shared GPU/CPU math) + tests"
```

---

### Task 2: Load `gerstner.js` in the page

**Files:**
- Modify: `static/index.html:584` (script load order)

**Interfaces:**
- Consumes: `static/js/gerstner.js` from Task 1.
- Produces: `window.Gerstner` available before `roll-viewer.js` runs.

- [ ] **Step 1: Add the script tag before roll-viewer.js**

In `static/index.html`, find:

```html
    <script src="js/roll-prediction.js?v=1"></script>
    <script src="js/roll-viewer.js?v=65"></script>
```

Replace with:

```html
    <script src="js/roll-prediction.js?v=1"></script>
    <script src="js/gerstner.js?v=1"></script>
    <script src="js/roll-viewer.js?v=65"></script>
```

(roll-viewer.js `?v=` is bumped in Task 3, not here.)

- [ ] **Step 2: Verify load order**

Run: `grep -n "gerstner.js\|roll-viewer.js\|roll-prediction.js" static/index.html`
Expected: `gerstner.js` line appears AFTER `roll-prediction.js` and BEFORE `roll-viewer.js`.

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat(roll): load gerstner.js before roll-viewer"
```

---

### Task 3: Wire Gerstner into the water + ship heave (`roll-viewer.js`)

**Files:**
- Modify: `static/js/roll-viewer.js` — module-state vars (~line 21-47), `buildWater` (~2844-2870), `animateWater` (~2872-2877), animation loop heave (~3991) and `simWaveTime` advance (~3911), `setScenarioOverride`/`clearScenarioOverride` (~4964, 4974).
- Modify: `static/index.html:585` (`?v=` bump).

**Interfaces:**
- Consumes: `Gerstner.buildWaves`, `Gerstner.heightAt`, `Gerstner.GLSL_SNIPPET`, `Gerstner.MAX_WAVES` from Task 1.
- Produces: none (terminal integration; verified visually).

This task has no unit test (it's GPU/render wiring); it is verified by the existing test suite still passing plus a manual visual check. Make the edits, then run the verification steps.

- [ ] **Step 1: Add module-state vars**

In `roll-viewer.js`, near the other water state (the block around `var waterMesh = null;` line 21 and `var naturalRollPeriod = null;` line 47), add after `var waterNormals = null;` (line 27):

```javascript
    var _waves = [];               // current Gerstner wave specs (Gerstner.buildWaves)
    var _waterPatched = false;     // true once Water vertex shader has the Gerstner injection
```

- [ ] **Step 2: Patch `buildWater` — segments, shader injection, uniforms**

In `buildWater` (roll-viewer.js:2844), replace:

```javascript
        var waterGeometry = new THREE.PlaneGeometry(2000, 2000);
```

with:

```javascript
        var waterGeometry = new THREE.PlaneGeometry(2000, 2000, 200, 200);
```

Then, immediately after the existing `scene.add(waterMesh);` (roll-viewer.js:2869), add:

```javascript

        // ── Gerstner displacement injection ──
        // Reuse THREE.Water's reflection/refraction; patch its vertex shader to
        // displace vertices. Ship heave samples the same wave field (heightAt).
        _waves = (window.Gerstner) ? Gerstner.buildWaves(weather) : [];
        _waterPatched = false;
        if (window.Gerstner) {
            try {
                var wmat = waterMesh.material;
                var vs = wmat.vertexShader;
                if (vs.indexOf('gerstnerDisplace') === -1) {
                    vs = vs.replace(
                        'uniform float time;',
                        'uniform float time;\n' + Gerstner.GLSL_SNIPPET
                    );
                    vs = vs.replace(
                        'void main() {',
                        'void main() {\n\tvec3 gPos = position + gerstnerDisplace( position.xy );'
                    );
                    vs = vs.replace('modelMatrix * vec4( position, 1.0 )', 'modelMatrix * vec4( gPos, 1.0 )');
                    vs = vs.replace('modelViewMatrix * vec4( position, 1.0 )', 'modelViewMatrix * vec4( gPos, 1.0 )');
                    wmat.vertexShader = vs;

                    var dirArr = [], parArr = [];
                    for (var wi = 0; wi < Gerstner.MAX_WAVES; wi++) {
                        dirArr.push(new THREE.Vector2());
                        parArr.push(new THREE.Vector4());
                    }
                    wmat.uniforms.uTime = { value: 0 };
                    wmat.uniforms.uWaveCount = { value: 0 };
                    wmat.uniforms.uWaveDir = { value: dirArr };
                    wmat.uniforms.uWaveParams = { value: parArr };
                    wmat.needsUpdate = true;
                    _waterPatched = true;
                    _applyWavesToWater();
                }
            } catch (e) {
                console.warn('[roll-viewer] Gerstner water patch failed, using flat water:', e);
                _waterPatched = false;
            }
        }
```

- [ ] **Step 3: Add the `_applyWavesToWater` helper**

Immediately after the `buildWater` function's closing brace (roll-viewer.js, the `}` that ends `buildWater` — right before `// ── animateWater` at line 2871), add:

```javascript

    // Push current _waves into the patched Water shader uniforms.
    function _applyWavesToWater() {
        if (!_waterPatched || !waterMesh || !waterMesh.material) return;
        var u = waterMesh.material.uniforms;
        if (!u || !u.uWaveDir) return;
        var max = Gerstner.MAX_WAVES;
        for (var i = 0; i < max; i++) {
            var w = _waves[i];
            if (w) {
                u.uWaveDir.value[i].set(w.dirX, w.dirY);
                u.uWaveParams.value[i].set(w.k, w.A, w.omega, w.Q);
            } else {
                u.uWaveDir.value[i].set(0, 0);
                u.uWaveParams.value[i].set(0, 0, 0, 0);
            }
        }
        u.uWaveCount.value = Math.min(_waves.length, max);
    }
```

- [ ] **Step 4: Drive `uTime` from `simWaveTime`**

In the animation loop, find (roll-viewer.js:3911):

```javascript
            // Advance simulated wave time (separate from elapsed so timeScale only affects waves, not clouds/water)
            simWaveTime += dt * _timeScale;
```

Replace with:

```javascript
            // Advance simulated wave time (separate from elapsed so timeScale only affects waves, not clouds/water)
            simWaveTime += dt * _timeScale;

            // Gerstner surface time — same value the ship heave samples below (kept in sync)
            if (_waterPatched && waterMesh && waterMesh.material.uniforms.uTime) {
                waterMesh.material.uniforms.uTime.value = simWaveTime;
            }
```

- [ ] **Step 5: Replace the fake heave with a Gerstner surface sample**

Find (roll-viewer.js:3991):

```javascript
                shipGroup.position.y = -0.8 + weather.waveHeight * 0.1 * Math.sin(elapsed * 0.8) + capsizeSinkY;
```

Replace with:

```javascript
                // Heave: ride the actual wave surface. Water plane is centred on the
                // ship, so sample at its local origin (0,0). Falls back to the old
                // sin bob only when the Gerstner module is unavailable.
                var heaveY = (window.Gerstner && _waves.length)
                    ? Gerstner.heightAt(_waves, 0, 0, simWaveTime)
                    : weather.waveHeight * 0.1 * Math.sin(elapsed * 0.8);
                shipGroup.position.y = -0.8 + heaveY + capsizeSinkY;
```

- [ ] **Step 6: Rebuild waves when weather changes**

In `setScenarioOverride` (roll-viewer.js), find:

```javascript
        _refreshWeatherDisplay();
        return true;
    }

    function clearScenarioOverride() {
```

Replace with:

```javascript
        _refreshWeatherDisplay();
        if (window.Gerstner) { _waves = Gerstner.buildWaves(weather); _applyWavesToWater(); }
        return true;
    }

    function clearScenarioOverride() {
```

Then in `clearScenarioOverride`, find:

```javascript
        Object.assign(weather, _baseWeather);
        _refreshWeatherDisplay();
        return true;
    }
```

Replace with:

```javascript
        Object.assign(weather, _baseWeather);
        _refreshWeatherDisplay();
        if (window.Gerstner) { _waves = Gerstner.buildWaves(weather); _applyWavesToWater(); }
        return true;
    }
```

- [ ] **Step 7: Bump the cache version**

In `static/index.html`, change:

```html
    <script src="js/roll-viewer.js?v=65"></script>
```

to:

```html
    <script src="js/roll-viewer.js?v=66"></script>
```

- [ ] **Step 8: Verify the full test suite still passes**

Run: `node --test tests/js/*.test.mjs`
Expected: PASS (all JS tests, including the new `gerstner.test.mjs` and the existing `roll-prediction.test.mjs`).

Run: `uv run pytest -q`
Expected: PASS (no Python touched; confirms nothing broke).

- [ ] **Step 9: Manual visual verification**

Start the dev server (per CLAUDE.md, port 12081):

```bash
DEV_NO_CACHE=1 uv run uvicorn backend.main:app --host 0.0.0.0 --port 12081
```

In the browser, open a ship's Roll viewer and confirm:
- The sea has visible 3D wave crests (not a flat plane), with THREE.Water's sun/sky reflection still present.
- The ship rises and falls riding the wave surface (heave), instead of the old uniform bob.
- Dragging the 파고 (wave height) / 파주기 (wave period) / 파향 (wave direction) sliders changes wave size/speed/direction, and the ship's heave responds.
- The 실측/예측 roll numbers and metronome behave exactly as before (roll attitude unchanged).

Stop the server with `kill -9` on its PID when done.

- [ ] **Step 10: Commit**

```bash
git add static/js/roll-viewer.js static/index.html
git commit -m "feat(roll): ride Gerstner wave surface — displaced water + ship heave coupling"
```

---

## Self-Review

**Spec coverage:**
- gerstner.js module (buildWaves/heightAt/GLSL_SNIPPET) → Task 1. ✓
- THREE.Water shader extension + high-res plane → Task 3 Step 2. ✓
- CPU heave sample at local origin → Task 3 Step 5. ✓
- uTime from simWaveTime (timeScale coherence) → Task 3 Step 4. ✓
- measured roll/pitch unchanged → Task 3 only edits `position.y`; Steps 5 confirms. ✓
- weather-change wave rebuild → Task 3 Step 6. ✓
- graceful degrade (patch fail / module absent) → Task 3 Step 2 try/catch + Step 5 fallback. ✓
- script load order → Task 2. ✓
- tests → Task 1 Step 1; suite run → Task 3 Step 8. ✓
- cache `?v=` bump → Task 3 Step 7. ✓

**Placeholder scan:** none — all code shown in full.

**Type consistency:** `_applyWavesToWater` (defined Task 3 Step 3) is called in Task 3 Steps 2 and 6. `_waves`/`_waterPatched` declared Step 1, used Steps 2-6. `Gerstner.MAX_WAVES`/`buildWaves`/`heightAt`/`GLSL_SNIPPET` match the Task 1 module exports. `uWaveParams[i] = vec4(k, A, omega, Q)` order matches between `_applyWavesToWater` (`.set(w.k, w.A, w.omega, w.Q)`) and GLSL (`.x=k, .y=A, .z=w(omega), .w=Q`). ✓
