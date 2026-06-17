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
