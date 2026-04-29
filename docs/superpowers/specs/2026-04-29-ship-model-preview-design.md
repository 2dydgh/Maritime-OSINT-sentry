# Ship Model Preview in Spec Panel

## Summary

선박 선택 시 제원정보 패널(`#rightView-ship`)에 3D 모델 프리뷰를 추가한다.
제원 상세 카드 아래에 인라인으로 배치하여 "이 선박이 이렇게 생겼다"를 직관적으로 보여준다.

## Design

### Layout
- 위치: `.ship-detail-card` 아래, 모델 카드 그리드(`.model-cards-grid`) 위
- 캔버스: 패널 폭 full (약 320px), 높이 160-180px
- 컨테이너에 border-radius, 배경 그라데이션 적용

### 3D Scene
- 배경: 단색 그라데이션 (`#0a1628` → `#1a3050`)
- 모델: `roll-viewer.js`의 `buildCodeShip` 계열 함수 재활용 (buildTanker, buildCargo, buildPassenger, buildFishing, buildMilitary, buildTug, buildGenericShip)
- 선종(ship type)에 따라 적절한 모델 빌더 호출
- 조명: DirectionalLight + AmbientLight (심플)
- 카메라: PerspectiveCamera, 선박을 비스듬히 내려다보는 각도 (약 30도 elevation)

### Interaction
- OrbitControls: 드래그 회전만 허용
- 줌 비활성화 (패널 스크롤 충돌 방지)
- 자동 회전 없음

### Dimension Lines (치수선)
- 호버 시 표시, 마우스 벗어나면 fade out
- 도면 스타일: 점선 + 양쪽 화살표 + 수치 라벨
- 표시 항목: Length (L), Beam (B), Draught (D)
- CSS overlay 또는 Three.js Line + Sprite 텍스트로 구현
- 제원 데이터 없는 경우: 모델은 보여주되 치수선 영역에 "제원 정보 없음" 텍스트 표시

### Performance
- 별도 렌더러 인스턴스 (roll-viewer와 독립)
- 패널이 닫히거나 다른 뷰로 전환 시 renderer.dispose() 호출
- requestAnimationFrame은 패널이 보일 때만 동작
- 안티앨리어싱 활성, devicePixelRatio cap 2

### Integration
- `showShipInfo()` 함수 (ui-controls.js:1065) 내에서 제원 카드 렌더 후 프리뷰 초기화
- 새 파일 `static/js/ship-preview-3d.js` 생성 — 프리뷰 전용 모듈
- ship-models-3d 빌더 함수를 공통 모듈로 분리하거나, roll-viewer에서 export하여 재활용

## Out of Scope
- Water/Sky 이펙트
- 블룸/포스트프로세싱
- GLTF 외부 모델 로드
- 터치 줌/핀치
