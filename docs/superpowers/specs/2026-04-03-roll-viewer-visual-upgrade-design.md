# Roll Viewer 비주얼 업그레이드 설계

**날짜:** 2026-04-03
**범위:** `static/js/roll-viewer.js` + `static/css/main.css` (롤 뷰어 관련 섹션)

## 목적

현재 롤 뷰어의 3D 비주얼을 대폭 업그레이드한다. 레이아웃(70/30)과 패널 정보 구성은 유지하면서, 3D 씬의 바다/선박/효과를 시뮬레이터급으로 끌어올린다.

## 변경 범위

### 1. Water Shader

현재 `buildWater()`의 PlaneGeometry + MeshPhongMaterial을 Three.js Water 클래스로 교체한다.

- `THREE.Water` (examples/jsm/objects/Water.js) 사용
- 실시간 반사/굴절 렌더링
- 태양 방향에 따른 수면 반짝임 (sunDirection 파라미터)
- 기존 `animateWater()` 제거 — Water 셰이더가 자체적으로 파형 애니메이션 수행
- water.material.uniforms['time'].value를 매 프레임 업데이트
- 파고/파향 파라미터를 Water 셰이더의 distortionScale/size에 매핑

### 2. Post-Processing (Bloom + 색보정)

EffectComposer 파이프라인을 추가한다.

- `EffectComposer` + `RenderPass` + `UnrealBloomPass`
- Bloom 대상: 브릿지 창문 emissive, 수면 반사 하이라이트
- Bloom 파라미터: strength ~0.4, radius ~0.5, threshold ~0.7 (은은하게)
- 기존 `renderer.render(scene, camera)` → `composer.render()`로 교체
- 선택적으로 `ShaderPass`로 색보정 (약간의 블루 틴트, 콘트라스트)

### 3. Cinematic Camera Entry

뷰어 진입 시 카메라 줌인 애니메이션을 추가한다.

- 시작 위치: (80, 40, 80) — 멀리서 내려다보는 앵글
- 최종 위치: 현재와 동일 (30, 20, 40)
- 2초 이징 (easeOutCubic)
- 애니메이션 중 OrbitControls 비활성화 → 완료 후 활성화
- `startAnimation()` 시작 시 실행

### 4. Spray Particles (물보라)

선수 부근에 물보라 파티클을 추가한다.

- `THREE.Points` + `THREE.BufferGeometry`로 파티클 시스템 구현
- 파티클 수: 50~100개
- 선수(bow) 위치 기준으로 위로 튀어오르는 궤적
- 파고와 풍속에 비례하여 파티클 양/높이 조절
- 반투명 흰색, 크기 감소하며 소멸
- 매 프레임 position attribute 업데이트

### 5. 선종별 Ship Model (6종)

현재 `buildShip(type)`을 선종별 전용 함수로 분기한다. 모든 모델은 코드 기반 (ExtrudeGeometry, BoxGeometry, CylinderGeometry 등)이되, 각 선종의 특징적 구조물을 표현한다.

**공통:**
- 선종별 고유 색상 유지 (SHIP_COLORS)
- MeshStandardMaterial 사용 (Phong → Standard로 업그레이드, PBR 느낌)
- 선체 형상: 각 선종별 다른 Shape → ExtrudeGeometry

**Tanker (탱커):**
- 낮고 긴 선체, 완만한 선수
- 갑판 위 파이프라인 구조물 (가느다란 실린더 여러 개)
- 매니폴드 (갑판 중앙)
- 후미에 낮은 브릿지

**Cargo (화물선):**
- 중간 높이 선체
- 갑판 위 컨테이너 박스 적재 (2-3층, 색상 랜덤)
- 크레인 구조물 (선수 또는 중앙)
- 후미에 높은 브릿지

**Passenger (여객선):**
- 넓은 선체
- 다층 데크 (3-4층 상부구조)
- 각 층마다 창문 라인 (emissive)
- 큰 펀넬
- 유선형 선수

**Fishing (어선):**
- 작고 짧은 선체
- 높은 마스트 + 아웃리거/붐
- 소형 브릿지
- 그물/장비 느낌의 구조물

**Military (군함):**
- 날렵하고 뾰족한 선수 (V-shape)
- 낮은 상부구조 (스텔스 느낌 경사면)
- 전방에 포탑 형태 구조물
- 레이더 마스트
- 전체적으로 각진 형태

**Tug (예인선):**
- 짧고 넓고 높은 선체
- 큰 브릿지 (선체 대비 비율 크게)
- 후미에 예인 윈치/장비
- 굵은 펜더 (선체 측면)

### 6. Panel UI 리디자인

정보 구성은 현재와 동일하게 유지한다:
1. 선박 정보 (SHIP INFO)
2. 횡요각 (ROLL) — 틸트 인디케이터 + 게이지
3. 종요각 (PITCH) — 틸트 인디케이터 + 게이지
4. 기상 (WEATHER)
5. 이력 (HISTORY) — ECharts 차트

변경 사항:
- 섹션 간 구분선/여백 정리
- 게이지 바 그라디언트 개선
- 전체 스타일을 지구본 뷰의 패널과 통일
- 폰트 크기/간격 미세 조정

## 기술적 의존성

현재 Three.js는 CDN에서 로드 중. 추가로 필요한 모듈:
- `Water.js` (examples/jsm/objects/Water.js) — CDN에서 추가 로드 또는 인라인
- `EffectComposer.js`, `RenderPass.js`, `UnrealBloomPass.js` — CDN에서 추가 로드 또는 인라인
- waternormals.jpg 텍스처 — Water 셰이더에 필요한 노멀맵

현재 프로젝트는 vanilla JS + CDN 로드 방식이므로, 추가 모듈도 동일한 방식으로 로드한다. 번들러 불필요.

## 변경하지 않는 것

- 레이아웃 구조 (70/30 split)
- 패널 정보 구성 (5개 섹션, 동일 데이터)
- RollViewer 공개 API (load/dispose)
- 기상 데이터 연동 로직 (findNearestWeather)
- 롤/피치 시뮬레이션 파라미터 (ROLL_PARAMS)
- ECharts 차트 로직
- 뒤로가기 버튼 동작

## 파일 변경 목록

- `static/js/roll-viewer.js` — 주요 변경 (Water 셰이더, 포스트프로세싱, 카메라, 파티클, 선박 모델)
- `static/css/main.css` — 패널 스타일 리디자인 (롤 뷰어 관련 섹션만)
- `static/index.html` — Three.js 추가 모듈 CDN 스크립트 태그 (Water, EffectComposer 등)
