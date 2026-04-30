# EventBus Modularization Design

**Date:** 2026-04-30
**Scope:** Phase 1 - Core infrastructure (EventBus + DataService) + websocket/collision/proximity 분리
**Approach:** 점진적 전환 (C안) - 핵심 인프라 먼저, 나머지 파일은 추후 전환

---

## 1. 문제 정의

현재 코드는 파일 분리는 되어 있지만 모듈 시스템 없이 전역 스코프를 공유한다.

- `websocket.js`가 데이터 수신 + 상태 저장 + Cesium 렌더링 + UI 카운트 업데이트를 모두 직접 수행
- `collision.js` <-> `proximity.js`가 서로 함수를 직접 호출하는 순환 의존
- 60개 이상의 전역 변수가 어디서든 읽고 쓰임
- 한 파일 수정 시 다른 파일이 깨질 위험이 높음

## 2. 목표

- 데이터(수신/저장)와 렌더링(UI/지도)을 분리
- 파일 간 직접 호출을 이벤트 기반 통신으로 전환
- AI agent 연동을 위한 깔끔한 인터페이스 확보
- 기존 동작을 깨뜨리지 않는 점진적 전환

## 3. 신규 파일

### 3.1 event-bus.js (~20줄)

이벤트 발행/구독 시스템. 모든 파일보다 먼저 로드.

```js
window.EventBus = {
    _handlers: {},
    on: function(event, fn) {
        (this._handlers[event] = this._handlers[event] || []).push(fn);
    },
    off: function(event, fn) {
        var list = this._handlers[event];
        if (list) this._handlers[event] = list.filter(function(f) { return f !== fn; });
    },
    emit: function(event, data) {
        (this._handlers[event] || []).forEach(function(fn) { fn(data); });
    }
};
```

### 3.2 data-service.js (~80줄)

상태 관리 + 이벤트 발행. event-bus.js 다음에 로드.

```js
window.DataService = {
    ships: {},
    aircraft: {},
    collision: { distance: { risks: [] }, ml: { risks: [] } },
    latestShipMmsis: new Set(),

    updateShips: function(ships) {
        var counts = {};
        ships.forEach(function(s) {
            DataService.ships[s.mmsi] = s;
            counts[s.type] = (counts[s.type] || 0) + 1;
        });
        DataService.latestShipMmsis = new Set(ships.map(function(s) { return s.mmsi; }));
        EventBus.emit('ships:updated', { ships: ships, counts: counts });
    },

    updateAircraft: function(aircraft) {
        var counts = {};
        aircraft.forEach(function(ac) {
            DataService.aircraft[ac.icao24] = ac;
            counts[ac.type] = (counts[ac.type] || 0) + 1;
        });
        EventBus.emit('aircraft:updated', { aircraft: aircraft, counts: counts });
    },

    updateCollision: function(data) {
        DataService.collision = data;
        EventBus.emit('collision:updated', data);
    }
};
```

## 4. 이벤트 목록

| 이벤트 | 발행자 | 데이터 | 구독자 |
|---|---|---|---|
| `ships:updated` | DataService | `{ ships: [], counts: {} }` | map-cesium, map-leaflet, ui-controls, sparkline, proximity |
| `aircraft:updated` | DataService | `{ aircraft: [], counts: {} }` | map-cesium, map-leaflet, ui-controls, sparkline |
| `collision:updated` | DataService | `{ distance: {...}, ml: {...} }` | collision, sparkline |
| `ws:status` | websocket | `'connected'` / `'disconnected'` / `'connecting'` | ui-controls |
| `ship:selected` | ui-controls, collision | `{ mmsi, target? }` | proximity, map-cesium |
| `command:flyTo` | collision, proximity | `{ lat, lng, height? }` | map-cesium |
| `proximity:updated` | proximity | `{ selected, nearby: [] }` | map-cesium, map-leaflet |
| `proximity:cleared` | proximity | (없음) | collision |

## 5. 파일별 변경 사항

### 5.1 websocket.js (대규모 리팩토링)

**제거하는 코드:**
- `shipDataMap[s.mmsi] = s` 직접 저장 -> `DataService.updateShips(ships)` 호출
- Cesium 빌보드/라벨 생성/업데이트 코드 -> `map-cesium.js`로 이동
- `animateCount()` 호출 -> `ui-controls.js`에서 이벤트 구독
- `BottomBar.updateVesselTypes()` 호출 -> `sparkline.js`에서 이벤트 구독
- `viewer.scene.requestRender()` 호출 -> `map-cesium.js` 내부 처리
- `syncShipsToLeaflet()` 호출 -> `map-leaflet.js`에서 이벤트 구독
- Aircraft도 동일 패턴 적용

**남기는 코드:**
- WebSocket 연결 관리 (`initWebSocket`, 재연결 로직)
- `ws.onmessage` -> JSON 파싱 -> `DataService.updateShips()` / `DataService.updateAircraft()` 호출
- `EventBus.emit('ws:status', ...)` 상태 알림
- `getShipIcon()`, `getAircraftIcon()` 등 유틸 함수 (향후 별도 분리)
- `showShipInfo()`, `highlightShip()` 관련 코드 (향후 분리)

### 5.2 map-cesium.js (이벤트 구독 추가)

```js
EventBus.on('ships:updated', function(data) {
    renderShipsToCesium(data.ships);  // websocket.js에서 이동한 렌더링 로직
    viewer.scene.requestRender();
});

EventBus.on('aircraft:updated', function(data) {
    renderAircraftToCesium(data.aircraft);
    viewer.scene.requestRender();
});

EventBus.on('command:flyTo', function(data) {
    smoothFlyTo({
        destination: Cesium.Cartesian3.fromDegrees(data.lng, data.lat, data.height || 50000)
    });
});
```

### 5.3 ui-controls.js (이벤트 구독 추가)

```js
EventBus.on('ships:updated', function(data) {
    var total = data.ships.length;
    var totalEl = document.getElementById('total-ships');
    if (totalEl) animateCount(totalEl, total.toLocaleString());
    // 타입별 카운트 업데이트
});

EventBus.on('ws:status', function(status) {
    setWsStatus(status);
});
```

### 5.4 sparkline.js (이벤트 구독 추가)

```js
EventBus.on('ships:updated', function(data) {
    BottomBar.updateVesselTypes(data.counts);
});

EventBus.on('collision:updated', function(data) {
    var d = data.distance ? data.distance.risks.length : 0;
    BottomBar.updateRiskLevels(d, 0, 0);
});
```

### 5.5 map-leaflet.js (이벤트 구독 추가)

```js
EventBus.on('ships:updated', function(data) {
    if (currentMapMode === '2d') syncShipsToLeaflet();
});

EventBus.on('proximity:updated', function(data) {
    if (currentMapMode === '2d') syncProximityToLeaflet();
});
```

### 5.6 collision.js (직접 호출 제거)

**Before:**
```js
function _handleCollisionCardClick(card) {
    updateProximity();           // proximity.js 직접 호출
    smoothFlyTo({...});          // map-cesium.js 직접 호출
    showShipInfo(mmsiA);         // websocket.js 직접 호출
}
```

**After:**
```js
function _handleCollisionCardClick(card) {
    EventBus.emit('command:flyTo', { lat: midLat, lng: midLng });
    EventBus.emit('ship:selected', { mmsi: mmsiA, target: mmsiB });
}
```

### 5.7 proximity.js (직접 호출 제거)

**구독:**
```js
EventBus.on('ship:selected', function(data) {
    selectedProximityMmsi = data.mmsi;
    collisionTargetMmsi = data.target || null;
    updateProximity();
});
```

**발행:**
```js
function clearProximity() {
    // 자기 상태만 정리
    EventBus.emit('proximity:cleared');
}
```

## 6. 호환성 전략

### 6.1 전역변수 브릿지 (app.js)

```js
var shipDataMap = DataService.ships;
var aircraftDataMap = DataService.aircraft;
var collisionData = DataService.collision;
var latestWsShipsMmsis = DataService.latestShipMmsis;
```

객체 참조이므로 `shipDataMap`을 **읽는** 기존 코드는 그대로 동작한다.
**쓰기만** `DataService.updateShips()` 를 통하도록 변경한다.

### 6.2 스크립트 로드 순서 (index.html)

```html
<!-- 1. 인프라 (최상단) -->
<script src="js/event-bus.js"></script>
<script src="js/data-service.js"></script>

<!-- 2. 기존 파일들 (순서 유지) -->
<script src="js/sparkline.js"></script>
<script src="js/layout-manager.js"></script>
<script src="js/model-registry.js"></script>
<script src="js/ship-builders.js"></script>
<script src="js/ship-preview-3d.js"></script>
<script src="js/roll-viewer.js"></script>
<script src="js/route-viewer.js"></script>
<script src="js/app.js"></script>
<script src="js/map-cesium.js"></script>
<script src="js/ship-models-3d.js"></script>
<script src="js/map-leaflet.js"></script>
<script src="js/weather-overlay.js"></script>
<script src="js/satellite.js"></script>
<script src="js/proximity.js"></script>
<script src="js/collision.js"></script>
<script src="js/websocket.js"></script>
<script src="js/ui-controls.js"></script>
<script src="js/charts.js"></script>
```

## 7. 1차 범위에서 제외

다음 파일은 이미 독립적이거나 규모가 크므로 1차에서는 건드리지 않는다:

- `roll-viewer.js` (3,799줄, 독립 도메인)
- `satellite.js` (비교적 독립적)
- `weather-overlay.js` (독립적)
- `ship-builders.js` (신규 파일)
- `ship-preview-3d.js` (신규 파일)
- `layout-manager.js` (UI 패널 관리, 독립적)
- `model-registry.js` (데이터 정의)
- `route-viewer.js` (독립 기능)

## 8. 검증 체크리스트

리팩토링 후 아래 동작이 동일하게 작동해야 한다:

- [ ] WebSocket 연결 -> 선박/항공기 지도에 표시
- [ ] 선박 타입별 필터 on/off
- [ ] 선박 클릭 -> 상세 정보 패널
- [ ] 충돌 카드 클릭 -> 카메라 이동 + 프록시미티 라인
- [ ] 프록시미티 해제 -> 라인/모달 제거
- [ ] 2D/3D 지도 모드 전환
- [ ] 하단바 카운트/스파크라인 업데이트
- [ ] WS 연결 상태 LED
- [ ] 충돌 위험 리스트 필터링 (ML/distance 탭)

## 9. 향후 확장 (2차 이후)

- `satellite.js` -> `EventBus.on('satellites:updated')` 전환
- `roll-viewer.js` -> 이벤트 기반 전환
- 전역 변수 브릿지 제거 (모든 파일 전환 완료 후)
- AI agent 연동: `EventBus.on('ships:updated')` 구독으로 데이터 수신
