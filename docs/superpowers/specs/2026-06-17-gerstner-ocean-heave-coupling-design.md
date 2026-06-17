# Gerstner 바다 + 배 heave 연동 — 설계

날짜: 2026-06-17
대상: `static/js/roll-viewer.js` (Roll 뷰어 3D 바다)
브랜치: `feat/aircraft-tracking`

## 배경 / 문제

Roll 뷰어의 현재 바다는 three.js 공식 예제 `THREE.Water`를 **평면 1장 + 노멀맵**으로만
쓴다 (`buildWater`, roll-viewer.js:2844). 파도의 실제 높이가 없고 빛 반사만 일렁인다.

그 결과 배는 `weather.waveHeight*0.1*sin(elapsed*0.8)` 라는 **가짜 heave**로만 까딱이며
(roll-viewer.js:3991), 화면에 보이는 파도가 배 움직임의 원인이 아니다. "진짜 바다 위에
떠 있는" 느낌이 나지 않는다.

목표: 정점을 실제로 변위시키는 **Gerstner 파도**로 바꾸고, 배가 그 파면을 실제로 타도록
(heave 연동) 만든다. 단, 이 뷰어의 핵심 기능인 **실측 roll vs 예측 roll 비교**의 의미는
그대로 보존한다.

## 핵심 결정 사항 (확정)

1. **연동 범위 = heave만.** 배의 상하 운동(`position.y`)만 파면 높이에 연동한다.
   배의 자세(`smoothRoll`/`smoothPitch`)는 기존 해석적 물리(공진 증폭·선회 heel·capsize)를
   **변경하지 않는다**. 이유: 화면에 표시되는 측정 roll = `smoothRoll`이므로, 파면 기울기를
   여기 더하면 "숫자는 5°인데 배는 6° 기울어" 불일치가 생기고 예측 비교가 오염된다.
   surface 기울기는 넣지 않는다.
2. **물 구현 = THREE.Water 셰이더 확장.** 기존 THREE.Water의 반사/굴절/태양 반짝임을 살리고,
   그 정점 셰이더를 패치해 Gerstner 변위를 주입한다. 자체 셰이더로 갈아엎지 않는다.
3. **Gerstner 로직은 별도 모듈로 분리** (`static/js/gerstner.js`). roll-viewer.js는 이미
   ~5,000줄이라 더 키우지 않고, CPU 샘플러를 독립 테스트 가능하게 한다.

## 아키텍처

### 신규 모듈: `static/js/gerstner.js`

GPU 변위와 CPU 높이 샘플링이 **동일한 파형 수식**을 공유하는 것이 정확성의 핵심이다.
어긋나면 배가 시각적 파도를 타지 못한다. 한 모듈에 격리한다.

```
window.Gerstner = {
  buildWaves(weather)        // weather → 파동 스펙 배열
  heightAt(waves, x, z, t)   // CPU: 파면 높이 y (배 heave용). 스칼라 반환.
  GLSL_SNIPPET               // GPU 정점 셰이더에 주입할 동일 수식 (문자열)
}
```

`roll-prediction.js`와 동일한 UMD 패턴(IIFE: `module.exports` 또는 `window` 전역)으로
작성해 `node:test`에서 import 가능하게 한다.

#### 파동 스펙 도출 — `buildWaves(weather)`

입력: `{ waveHeight, wavePeriod, waveDirection }`.

씬은 실제 축척이 압축돼 있어(선체 길이 ~16 유닛) 물리 분산식을 그대로 쓰면 시각 파장이
안 맞는다. 대신 **시간 주기는 `wavePeriod`에 고정**(heave 주기 = 파주기 → roll 모델의 공진
로직과 일관), **공간 파장은 씬 유닛 기준 튜닝값**으로 분리한다:

- 주 진폭 `A = waveHeight / 2`  (waveHeight는 파고=마루-골 전체이므로 진폭은 절반)
- 주 공간 파장 `L0 = BASE_WAVELENGTH · (T/8)`  (BASE_WAVELENGTH=시각 튜닝 상수, 긴 주기→긴 스웰)
- 각 파동: 파수 `k = 2π/L`, 각진동수 `ω = 2π/T_i`. 위상 `φ = k·(dir·p) − ω·t`.
- 주 스웰의 `T_i = wavePeriod` → (0,0)에서 heave 주기 = 파주기.

3~4개 파동을 합성:
- **주 스웰 1개**: `waveDirection` 방향, 파장 L, 진폭 A.
- **교차 chop 2~3개**: 주 방향에서 ±(20~50°) 틀고, 파장은 주 파장의 0.5~0.35배,
  진폭은 주 진폭의 0.4~0.2배. 결정론적(시드 고정, `Math.random` 금지).

각 파동 스펙: `{ dirX, dirZ, L, A, c, Q }`. `Q`(steepness)는 파마루가 꼬이지/루프되지
않도록 `Q ≤ 1/(k·A·numWaves)` 로 클램프 (k = 2π/L).

#### 높이 샘플링 — `heightAt(waves, x, z, t)`

표준 Gerstner 합(수직 성분):

```
y = Σ_i  A_i · cos( k_i·(dir_i · p) - ω_i·t )
```

(변위 중 수직 성분만; 수평 변위는 시각 효과라 heave엔 불필요.)
**물 평면이 항상 배 중심에 위치**(`waterMesh.position = shipWorldPos`)하므로 배는 물 평면의
로컬 원점 (0,0)에 있다 → heave는 `heightAt(waves, 0, 0, simWaveTime)` 한 점만 매 프레임 샘플.
CPU 비용 무시 가능.

#### GPU 스니펫 — `GLSL_SNIPPET`

정점별로 수평(`x,z` 방향 오프셋) + 수직(`y`) Gerstner 변위를 전부 적용해 마루가
뾰족한 진짜 파형을 만든다. CPU `heightAt`과 **동일한 k/c/A/Q 수식**을 사용한다.
유니폼으로 `uTime`, 파동 배열(`uWaveDir[N]`, `uWaveParams[N]` = (k, A, c, Q))을 받는다.

### 물 빌드 변경 — `buildWater()` (roll-viewer.js:2844)

- `PlaneGeometry(2000, 2000)` → `PlaneGeometry(2000, 2000, 200, 200)` (변위용 세그먼트).
- 기존 `new THREE.Water(...)` 호출은 유지(반사/색/태양 유니폼 배선 그대로).
- 생성 후 `waterMesh.material`의 **정점 셰이더 문자열을 패치**:
  - 유니폼 선언 + `GLSL_SNIPPET` 함수 본문 삽입,
  - 정점 위치 계산 직후(미러 좌표 계산 전) Gerstner 오프셋을 정점에 더함.
  - `material.uniforms`에 `uTime`, `uWaveDir`, `uWaveParams`, `uWaveCount` 추가.
- 파동 스펙은 `Gerstner.buildWaves(weather)`로 만들어 유니폼에 채운다.
- **Graceful degrade**: 셰이더 패치 중 예외/마커 미발견 시 패치를 건너뛰고 기존 평면
  THREE.Water로 동작 (CLAUDE.md의 try/except degrade 패턴). 콘솔 1회 경고.

### 애니메이션 루프 변경 (roll-viewer.js:3894, 3991)

- `animateWater(time)`: 반사용 `time` 유니폼 갱신은 유지하고, `uTime` = `simWaveTime`을
  추가로 갱신 → **시간배속 슬라이더(`_timeScale`)가 파도·heave·roll에 일관 적용**.
- 배 heave 교체 (roll-viewer.js:3991):
  ```
  // 기존: -0.8 + weather.waveHeight*0.1*Math.sin(elapsed*0.8) + capsizeSinkY
  shipGroup.position.y = BASE_Y + Gerstner.heightAt(_waves, shipX, shipZ, simWaveTime) + capsizeSinkY
  ```
  `shipX/shipZ`는 `shipWorldPos`. `BASE_Y`는 기존 -0.8 흘수 오프셋.
- 예측 선체(`shipGroupPred`)는 기존대로 실제 선체 position을 copy → 같은 파면을 탄다.
- `smoothRoll`/`smoothPitch` 및 capsize 로직은 손대지 않는다.
- 파동 스펙 `_waves`는 weather가 바뀔 때만 재생성. 기존 weather override 경로
  (`setScenarioOverride` → effective weather 갱신)에 재계산 훅을 건다.

## 데이터 흐름

```
weather (waveHeight/period/direction)
   │  buildWaves()
   ▼
_waves 스펙 배열 ──┬─→ GPU 유니폼(uWaveDir/uWaveParams) → 정점 변위(시각 파도)
                   └─→ CPU heightAt(shipX,shipZ,simWaveTime) → 배 position.y (heave)
simWaveTime (timeScale 반영) ──→ uTime + heightAt t 인자  (둘이 동일 시간축)
```

시각 파도와 배가 같은 스펙·같은 시간축을 쓰므로 항상 일치한다.

## 에러 / 폴백

- **폴백 heave 정책(통일)**: `window.Gerstner`가 있으면 패치 성공/실패와 무관하게 배 heave는
  항상 `Gerstner.heightAt`을 쓴다(시각 파도가 평면이어도 배는 같은 파면 높이로 움직이므로
  무해하고 일관적). `window.Gerstner` 자체가 부재할 때만 기존 `sin` heave로 폴백.
- 셰이더 패치 실패 → 평면 THREE.Water로 graceful degrade(시각 파도만 평평), 콘솔 1회 경고.
- 진폭/파장 0 또는 음수 입력 방어 (`heightAt`은 빈 배열/0 진폭 시 0 반환).

## 테스트

- `tests/js/gerstner.test.mjs` (`node --test`):
  - `buildWaves`: 정상 weather → N개 스펙, 진폭/파장 양수, 결정론적(동일 입력 동일 출력).
  - `heightAt`: 진폭0 또는 빈 배열 → 0; 시간 진행 시 주기성; 동일 (x,z,t) 재현성.
  - steepness 클램프가 `Q·k·A·N ≤ 1` 불변식 유지.
- GLSL 스니펫은 단위 테스트 불가 → CPU 샘플러와 **같은 상수/수식**을 쓰는 것으로 일치 보장.
- 시각 확인: 개발 서버 `:12081`에서 파고/주기/파향 슬라이더 변화 시 파도·배 라이딩 확인.

## 변경 파일

- **신규**: `static/js/gerstner.js`, `tests/js/gerstner.test.mjs`
- **수정**: `static/js/roll-viewer.js` (`buildWater`, `animateWater`, 루프 heave), 
  `static/index.html` (gerstner.js 스크립트 로드 + roll-viewer/roll-prediction `?v=` 범프)

## 비범위 (YAGNI)

- 배 자세(roll/pitch)의 파면 연동 — 의도적으로 제외 (측정 roll 오염 방지).
- 수평 변위 기반 부유물 표류, 거품/포말(foam), FFT 바다 — 이번 범위 아님.
- 무한 타일링 바다 — 기존 2000×2000 단일 평면 유지.
