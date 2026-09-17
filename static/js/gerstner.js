// ── Gerstner wave field — shared GPU/CPU math ──
// GPU (GLSL_SNIPPET) and CPU (heightAt) use the SAME k/A/omega/Q and phase
// formula so the ship rides the visible waves. No Math.random — deterministic.
(function (root) {
  'use strict';

  var MAX_WAVES = 6;            // must equal #define MAX_WAVES in GLSL_SNIPPET
  var BASE_WAVELENGTH = 60;     // scene-unit wavelength of the primary swell at T=8s (visual tuning)
  var STEEPNESS = 0.95;         // crest sharpness, 0..1. Higher = pointier crests; >1 loops/pinches. Visual tuning.

  // Component table: [angleOffsetDeg, wavelengthScale, amplitudeScale, periodScale]
  // 2-스웰 체계 — 한 방향 스웰을 옥타브로 쪼개는 대신, 주 스웰(primary)과 다른
  // 방향에서 오는 별개의 긴 교차 스웰(secondary, ~58°)을 함께 둔다. 두 긴 파열의
  // 주기가 달라 맥놀이(beat)하며 수면이 불규칙한 "혼란 바다(confused sea)"로 읽힌다.
  // 진폭 합(≈2.2)은 종전과 맞춰 횡요 물리(heightAt 롤 계산)의 크기를 보존한다.
  // MAX_WAVES=6 와 동수. CPU(heightAt)·GPU(snippet) 가 같은 표를 공유.
  var COMPONENTS = [
    // ── 주 스웰 계열(dominant direction) ──
    [0,    1.00, 1.00,  1.00],   // primary swell — period == wavePeriod
    [16,   0.55, 0.34,  0.64],   // primary 풍성파(wind chop)
    // ── 교차 스웰 계열(다른 사분면, 별개 주기) ──
    [58,   0.80, 0.42,  0.86],   // secondary swell — 긴 파열, 주기 달라 주 스웰과 맥놀이
    [74,   0.36, 0.20,  0.52],   // secondary 풍성파
    // ── 미세 교차 잔물결 ──
    [-30,  0.30, 0.16,  0.46],
    [-66,  0.20, 0.10,  0.36]
  ];

  function buildWaves(weather) {
    var waveHeight = Math.max(0, (weather && weather.waveHeight) || 0);
    var T = Math.max(1, (weather && weather.wavePeriod) || 8);
    var dirDeg = (weather && weather.waveDirection != null) ? weather.waveDirection : 0;
    var dirRad = dirDeg * Math.PI / 180;
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

    // Steepness clamp: keep sum(Q*k*A) <= STEEPNESS (<=1) so crests don't loop/pinch.
    var denom = 0;
    for (var j = 0; j < waves.length; j++) denom += waves[j].k * waves[j].A;
    var Q = denom > 0 ? (STEEPNESS / denom) : 0;
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
    '}',
    '// Analytic surface normal — exact derivative of the Gerstner sum. Lets lighting',
    '// follow the real wave shape instead of a flat normal-map texture.',
    'vec3 gerstnerNormal( vec2 p ) {',
    '  float nx = 0.0;',
    '  float ny = 0.0;',
    '  float nz = 1.0;',
    '  for ( int i = 0; i < MAX_WAVES; i++ ) {',
    '    if ( i >= uWaveCount ) break;',
    '    vec2 d = uWaveDir[ i ];',
    '    float k = uWaveParams[ i ].x;',
    '    float A = uWaveParams[ i ].y;',
    '    float w = uWaveParams[ i ].z;',
    '    float Q = uWaveParams[ i ].w;',
    '    float phase = k * dot( d, p ) - w * uTime;',
    '    float C = cos( phase );',
    '    float S = sin( phase );',
    '    float WA = k * A;',
    '    nx -= d.x * WA * C;',
    '    ny -= d.y * WA * C;',
    '    nz -= Q * WA * S;',
    '  }',
    '  // local plane normal (z-up) -> world via the mesh model rotation',
    '  return normalize( mat3( modelMatrix ) * vec3( nx, ny, nz ) );',
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
