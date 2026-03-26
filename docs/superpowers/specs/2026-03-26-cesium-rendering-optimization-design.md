# Cesium 3D 렌더링 성능 최적화 설계

## 문제

라이브 모드에서 ~20,000척의 AIS 선박 데이터가 수신되고, 뷰포트 컬링 후에도 최대 2,800척이 Cesium Entity API로 렌더링됨. Entity는 매 프레임 속성을 평가하므로 10~20 FPS로 저하. 선박 선택 시 proximity.js의 CallbackProperty 16개가 추가로 60FPS 실행되어 더욱 악화.

## 목표

- 라이브 모드 3D Cesium 렌더링을 50~60 FPS로 개선
- 선박 선택/근접 시각화 시 프레임 드랍 제거
- 기능, UI, 데이터 흐름은 동일하게 유지

## 범위

### 수정 대상
| 파일 | 변경 내용 |
|------|-----------|
| `static/js/websocket.js` | 선박 렌더링: Entity → BillboardCollection + LabelCollection |
| `static/js/proximity.js` | 근접 시각화: Entity + CallbackProperty → PolylineCollection + LabelCollection, 이벤트 기반 갱신 |
| `static/js/map-cesium.js` | 클릭 처리: selectedEntityChanged → ScreenSpaceEventHandler + scene.pick() |
| `static/js/charts.js` | 차트 업데이트 5초 스로틀, resize 300ms 디바운스 |

### 변경 없음
- `static/js/satellite.js` — 수십 개 Entity, 병목 아님
- `static/js/collision.js` — 10초 간격 DOM 업데이트, 병목 아님
- `static/js/map-leaflet.js` — 현재 미사용
- `static/js/app.js` — 전역 상태, 변경 불필요
- `static/js/ui-controls.js` — UI 로직, 변경 불필요
- 백엔드 전체 — 데이터 흐름 동일

## 설계

### 1. 선박 렌더링 전환 (websocket.js)

**현재 구조:**
```
shipDataSources = { cargo: DataSource, tanker: DataSource, ... }
→ ds.entities.add({ billboard, label, position, description })
→ 매 프레임 Property 평가 × 2,800척 = 11,200~16,800회/프레임
```

**새 구조:**
```
shipBillboards = { cargo: BillboardCollection, tanker: BillboardCollection, ... }
shipLabels = { cargo: LabelCollection, tanker: LabelCollection, ... }
shipBillboardMap = { mmsi: Billboard }   // 빠른 참조용
shipLabelMap = { mmsi: Label }
```

**updateShipsLayer() 변경:**
1. `shipDataMap` 갱신 — 기존과 동일
2. 뷰포트 컬링 — 기존과 동일
3. 렌더링 로직 변경:
   - 이미 있는 billboard → `b.position`, `b.rotation` 직접 세팅
   - 새 선박 → `collection.add()`, `shipBillboardMap[mmsi] = b`
   - 사라진 선박 → `collection.remove(b)`, `delete shipBillboardMap[mmsi]`
4. 타입별 토글: `collection.show = true/false`

**아이콘 생성:**
- 기존 `_shipIconCache` SVG 캐시 로직 그대로 활용
- billboard.image에 data URI 할당 (기존과 동일)

**MAX_SHIPS_PER_TYPE:**
- 라이브 모드 400 유지 (Primitive에서는 더 올려도 됨, 추후 조절 가능)

### 2. 근접/충돌 시각화 전환 (proximity.js)

**현재 구조:**
```
proximityDataSource = DataSource
→ Entity + CallbackProperty 16개/쌍
→ 10쌍 × 16콜백 × 60FPS = 9,600회/초
```

**새 구조:**
```
proximityLines = PolylineCollection      // 근접 라인
proximityLabels = LabelCollection        // 거리 라벨
cogLines = PolylineCollection            // COG 프로젝션
cpaMarkers = BillboardCollection         // CPA 마커
proximityMap = { targetMmsi: { line, label, cogLine, cpaMarker } }
```

**갱신 방식:**
- CallbackProperty 완전 제거
- WebSocket 메시지 수신 시 `updateProximityPositions()` 호출
- 기존 2초 스로틀(`PROXIMITY_THROTTLE_MS`) 유지
- 선박 선택 변경 시: 각 Collection에서 `removeAll()` 후 새로 추가

**renderProximityLines() 변경:**
- Entity 생성 대신 Collection.add()
- positions, colors, width는 정적 값으로 세팅
- 다음 업데이트 사이클에서 새 위치로 갱신

### 3. 클릭/인터랙션 처리 (map-cesium.js)

**현재:**
```javascript
viewer.selectedEntityChanged.addEventListener(function(entity) { ... });
```

**변경:**
```javascript
var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(function(click) {
    var picked = viewer.scene.pick(click.position);
    if (Cesium.defined(picked) && picked.primitive._mmsi) {
        var mmsi = picked.primitive._mmsi;
        var ship = shipDataMap[mmsi];
        // 기존 선택 로직 실행
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

**billboard 생성 시:**
```javascript
var b = collection.add({ ... });
b._mmsi = ship.mmsi;  // 커스텀 속성으로 식별
```

**위성 클릭:**
- 위성은 Entity 방식 유지 (수십 개, 성능 이슈 없음)
- `scene.pick()` 결과가 Entity이면 기존 로직, Primitive이면 선박 로직으로 분기

### 4. 부가 최적화 (charts.js)

**차트 업데이트 스로틀링:**
```javascript
var lastChartUpdate = 0;
function throttledChartUpdate(data) {
    var now = Date.now();
    if (now - lastChartUpdate < 5000) return;
    lastChartUpdate = now;
    // 기존 차트 업데이트 로직
}
```

**resize 디바운스:**
```javascript
var resizeTimer;
window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
        if (gaugeChart) gaugeChart.resize();
        if (radarChart) radarChart.resize();
        if (shipTypeBarChart) shipTypeBarChart.resize();
    }, 300);
});
```

## 성능 기대치

| 항목 | 현재 | 개선 후 |
|------|------|---------|
| 드로우콜 (2,800척) | ~2,800/프레임 | 1~2/프레임 |
| 속성 평가 | 11,200~16,800/프레임 | 0 (직접 세팅) |
| 근접 콜백 | 9,600/초 | 0 (이벤트 기반) |
| 예상 FPS | 10~20 | 50~60 |
| 선박 선택 시 추가 부하 | CallbackProperty 16개 추가 | 없음 |

### 5. shipDataSources 참조 마이그레이션

`shipDataSources`를 직접 참조하는 파일들도 수정 필요:

**collision.js (라인 243-245):**
- `shipDataSources[type].entities.getById(mmsi)` → `shipBillboardMap[mmsi]`로 교체
- 충돌 카드에서 선박 위치 조회 시 `shipDataMap[mmsi]`에서 직접 가져옴

**ui-controls.js (라인 228, 277-278, 374-375, 405-406, 577-578):**
- `.entities.removeAll()` → `collection.removeAll()` + `shipBillboardMap` 초기화
- 히스토리 모드 전환/리셋 시 Collection 클리어 로직으로 교체

**websocket.js (라인 93-94):**
- 체크박스 토글: `shipDataSources[type].show` → `shipBillboards[type].show` + `shipLabels[type].show`

**map-leaflet.js (라인 113):**
- 2D 동기화에서 참조 — 현재 미사용이므로 변경 불필요, 호환성 위해 `shipDataSources` 변수는 유지

**전역 변수 전환 (app.js):**
- `shipDataSources` 유지 (하위 호환) + `shipBillboards`, `shipLabels`, `shipBillboardMap`, `shipLabelMap` 추가

## 리스크

- **scene.pick() 정확도**: BillboardCollection에서 pick은 잘 작동하지만, 밀집 영역에서 최상단 billboard만 선택됨 (기존 Entity도 동일한 한계)
- **아이콘 업데이트**: billboard.image 변경 시 텍스처 재업로드 발생 — 기존 캐시 활용으로 최소화
