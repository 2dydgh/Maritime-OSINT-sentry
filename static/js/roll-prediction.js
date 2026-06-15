// ── Roll Viewer — Prediction Seam ──
// 실제(actual) roll/pitch를 입력받아 "예측" roll/pitch를 만든다.
// 지금: 결정론적 mock 오차(게인 불일치 + 위상 시프트).
// 나중: predictRoll 본문만 모델 API 응답으로 교체. 시그니처는 고정.
(function (root) {
  'use strict';

  // 문자열 시드 → 0..1 결정론적 값 (Math.random 금지 대체)
  function seedToUnit(seed) {
    var s = String(seed || 'default');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // 0..1
    return ((h >>> 0) % 100000) / 100000;
  }

  // predictRoll(actual, ctx) -> { roll, pitch }
  //   actual: { roll, pitch }
  //   ctx:    { seed, t }   seed=선종키, t=경과초
  function predictRoll(actual, ctx) {
    var u = seedToUnit(ctx && ctx.seed);
    var t = (ctx && ctx.t) || 0;
    var gain = 0.85 + 0.1 * u;          // 0.85 ~ 0.95
    var omega = 0.4 + 0.3 * u;          // 위상 진동 각속도
    var phase = 6.28318 * u;            // 시드별 위상
    var rollOffset = 1.2 * Math.sin(t * omega + phase);   // ±1.2° 진동 오차
    var pitchOffset = 0.5 * Math.sin(t * omega * 0.7 + phase);
    return {
      roll: actual.roll * gain + rollOffset,
      pitch: actual.pitch * gain + pitchOffset
    };
  }

  // computeDelta(actual, pred) -> { dRoll, dPitch }  (실제 - 예측)
  function computeDelta(actual, pred) {
    return {
      dRoll: actual.roll - pred.roll,
      dPitch: actual.pitch - pred.pitch
    };
  }

  // computeRMSE(seriesA, seriesB) -> number
  function computeRMSE(a, b) {
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      var e = a[i] - b[i];
      sum += e * e;
    }
    return Math.sqrt(sum / a.length);
  }

  var api = { predictRoll: predictRoll, computeDelta: computeDelta, computeRMSE: computeRMSE };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // node:test
  } else {
    root.RollPrediction = api;       // 브라우저 글로벌
  }
})(typeof window !== 'undefined' ? window : globalThis);
