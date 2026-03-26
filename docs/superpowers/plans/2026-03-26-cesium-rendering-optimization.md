# Cesium 렌더링 성능 최적화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브 모드 3D Cesium 선박 렌더링을 Entity API에서 Primitive Collection으로 전환하여 50~60 FPS 달성

**Architecture:** 선박 렌더링을 BillboardCollection + LabelCollection으로 교체하고, 근접/충돌 시각화를 PolylineCollection으로 전환하며, CallbackProperty를 완전히 제거하여 이벤트 기반 갱신으로 변경

**Tech Stack:** Cesium.js v1.114 (BillboardCollection, LabelCollection, PolylineCollection, PointPrimitiveCollection)

---

## 파일 구조

| 파일 | 변경 유형 | 역할 |
|------|-----------|------|
| `static/js/app.js` | 수정 | 전역 변수 추가 (Collection 참조, Map 참조) |
| `static/js/map-cesium.js` | 수정 | DataSource 초기화 → Collection 초기화로 교체 |
| `static/js/websocket.js` | 수정 | 선박 렌더링 Entity → BillboardCollection/LabelCollection |
| `static/js/proximity.js` | 수정 | 근접 시각화 Entity+CallbackProperty → Primitive Collection |
| `static/js/ui-controls.js` | 수정 | 클릭 핸들러 + 히스토리 모드 참조 교체 |
| `static/js/collision.js` | 수정 | shipDataSources 참조 → shipDataMap 직접 조회 |
| `static/js/charts.js` | 수정 | 차트 업데이트 스로틀링, resize 디바운스 |

---

### Task 1: 전역 변수 추가 (app.js)

**Files:**
- Modify: `static/js/app.js:8-9`

- [ ] **Step 1: 전역 변수 선언 추가**

`shipDataSources` 바로 아래에 Primitive Collection 참조용 변수를 추가한다.

```javascript
// 기존 유지
var shipDataSources = {};

// Primitive Collection 참조 (신규)
var shipBillboards = {};      // { type: BillboardCollection }
var shipLabels = {};           // { type: LabelCollection }
var shipBillboardMap = {};     // { mmsi: Billboard }
var shipLabelMap = {};         // { mmsi: Label }
```

`proximityDataSource` 아래에 근접 시각화용 Collection 변수를 추가한다.

```javascript
// 기존 유지
var proximityDataSource = null;

// Proximity Primitive Collections (신규)
var proximityLines = null;     // PolylineCollection
var proximityLabels = null;    // LabelCollection
var proximityCogLines = null;  // PolylineCollection
var proximityCpaPoints = null; // PointPrimitiveCollection
var proximityCpaLabels = null; // LabelCollection
var proximityMap = {};         // { targetMmsi: { line, label, cogSel, cogTgt, cpaPoint, cpaLabel } }
```

- [ ] **Step 2: 커밋**

```bash
git add static/js/app.js
git commit -m "refactor: add global variables for Primitive Collections"
```

---

### Task 2: Collection 초기화 (map-cesium.js)

**Files:**
- Modify: `static/js/map-cesium.js:421-433`

- [ ] **Step 1: 선박 DataSource 초기화를 Collection 초기화로 교체**

`map-cesium.js` 하단의 선박 DataSource 초기화 블록을 교체한다. 기존 `shipDataSources`는 2D Leaflet과 히스토리 모드 호환을 위해 유지하되, 라이브 3D에서는 사용하지 않는다.

기존 코드 (라인 429-433):
```javascript
SHIP_TYPES.forEach(async function(type) {
    var ds = new Cesium.CustomDataSource('Ships - ' + type);
    shipDataSources[type] = ds;
    await viewer.dataSources.add(ds);
});
```

새 코드:
```javascript
// Ship Primitive Collections (라이브 3D용)
SHIP_TYPES.forEach(function(type) {
    shipBillboards[type] = viewer.scene.primitives.add(new Cesium.BillboardCollection());
    shipLabels[type] = viewer.scene.primitives.add(new Cesium.LabelCollection());
});

// DataSource는 히스토리 모드용으로 유지
SHIP_TYPES.forEach(async function(type) {
    var ds = new Cesium.CustomDataSource('Ships - ' + type);
    shipDataSources[type] = ds;
    await viewer.dataSources.add(ds);
});
```

- [ ] **Step 2: Proximity Collection 초기화 추가**

기존 `proximityDataSource` 초기화(라인 426-427) 아래에 Collection을 추가한다.

기존:
```javascript
proximityDataSource = new Cesium.CustomDataSource('Proximity');
viewer.dataSources.add(proximityDataSource);
```

새 코드 (기존 아래에 추가):
```javascript
proximityDataSource = new Cesium.CustomDataSource('Proximity');
viewer.dataSources.add(proximityDataSource);

// Proximity Primitive Collections
proximityLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
proximityLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());
proximityCogLines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
proximityCpaPoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
proximityCpaLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());
```

- [ ] **Step 3: 커밋**

```bash
git add static/js/map-cesium.js
git commit -m "feat: initialize Primitive Collections for ships and proximity"
```

---

### Task 3: 선박 렌더링 전환 (websocket.js)

**Files:**
- Modify: `static/js/websocket.js:88-105` (체크박스 핸들러)
- Modify: `static/js/websocket.js:142-276` (updateShipsLayer)

- [ ] **Step 1: 체크박스 토글 핸들러 수정**

기존 (라인 88-105)의 `shipDataSources[type].show` 부분에 Collection 토글을 추가한다.

기존:
```javascript
SHIP_TYPES.forEach(function(type) {
    var checkbox = document.getElementById('filter-' + type);
    if (checkbox) {
        checkbox.addEventListener('change', function() {
            if (shipDataSources[type]) {
                shipDataSources[type].show = checkbox.checked;
            }
            if (currentMapMode === '2d' && leafletMap && leafletShipLayerGroups[type]) {
                if (checkbox.checked) {
                    leafletShipLayerGroups[type].addTo(leafletMap);
                } else {
                    leafletMap.removeLayer(leafletShipLayerGroups[type]);
                }
            }
        });
    }
});
```

새 코드:
```javascript
SHIP_TYPES.forEach(function(type) {
    var checkbox = document.getElementById('filter-' + type);
    if (checkbox) {
        checkbox.addEventListener('change', function() {
            // Primitive Collections (라이브 3D)
            if (shipBillboards[type]) shipBillboards[type].show = checkbox.checked;
            if (shipLabels[type]) shipLabels[type].show = checkbox.checked;
            // DataSource (히스토리 모드)
            if (shipDataSources[type]) {
                shipDataSources[type].show = checkbox.checked;
            }
            // Leaflet 2D
            if (currentMapMode === '2d' && leafletMap && leafletShipLayerGroups[type]) {
                if (checkbox.checked) {
                    leafletShipLayerGroups[type].addTo(leafletMap);
                } else {
                    leafletMap.removeLayer(leafletShipLayerGroups[type]);
                }
            }
        });
    }
});
```

- [ ] **Step 2: updateShipsLayer() 렌더링 로직 교체**

기존 `updateShipsLayer()` 함수(라인 142-276)의 Cesium Entity 로직을 BillboardCollection/LabelCollection으로 교체한다. 2D Leaflet 부분(라인 278-333)은 그대로 유지.

기존 SHIP_TYPES.forEach 블록 (라인 183-276) 전체를 다음으로 교체:

```javascript
    var MAX_SHIPS_PER_TYPE = (timeMode === 'history') ? 2000 : 400;
    var totalRendered = 0;

    // ── 히스토리 모드: 기존 Entity 방식 유지 ──
    if (timeMode === 'history') {
        SHIP_TYPES.forEach(function(type) {
            var ds = shipDataSources[type];
            if (!ds) return;

            var typeShips = byType[type];
            var existingIds = new Set();
            var typeRenderedCount = 0;

            typeShips.forEach(function(ship) {
                if (typeRenderedCount >= MAX_SHIPS_PER_TYPE) return;
                if (ship.lng < west || ship.lng > east || ship.lat < south || ship.lat > north) return;

                typeRenderedCount++;
                totalRendered++;
                existingIds.add(ship.mmsi);
                var entity = ds.entities.getById(ship.mmsi);
                var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);

                if (!entity) {
                    var shipSize = getShipSize(ship.length, ship.beam);
                    ds.entities.add({
                        id: ship.mmsi,
                        name: ship.name,
                        position: position,
                        billboard: {
                            image: getShipIcon(SHIP_COLORS[type], type),
                            width: shipSize.width,
                            height: shipSize.height,
                            scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                            disableDepthTestDistance: Number.POSITIVE_INFINITY
                        }
                    });
                } else {
                    entity.position = position;
                }
            });

            ds.entities.values.forEach(function(entity) {
                if (!existingIds.has(entity.id)) {
                    ds.entities.remove(entity);
                }
            });

            var countEl = document.getElementById('count-' + type);
            if (countEl) countEl.textContent = typeShips.length.toLocaleString();
        });
        return;
    }

    // ── 라이브 모드: Primitive Collection 방식 ──
    SHIP_TYPES.forEach(function(type) {
        var billboards = shipBillboards[type];
        var labels = shipLabels[type];
        if (!billboards || !labels) return;

        var typeShips = byType[type];
        var seenMmsis = new Set();
        var typeRenderedCount = 0;

        typeShips.forEach(function(ship) {
            if (typeRenderedCount >= MAX_SHIPS_PER_TYPE) return;
            if (ship.lng < west || ship.lng > east || ship.lat < south || ship.lat > north) return;

            typeRenderedCount++;
            totalRendered++;
            seenMmsis.add(ship.mmsi);

            var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);
            var heading = Cesium.Math.toRadians(-(ship.heading || 0));

            var existingBb = shipBillboardMap[ship.mmsi];
            if (existingBb) {
                // 기존 billboard 업데이트 — 직접 세팅, Property 평가 없음
                existingBb.position = position;
                existingBb.rotation = heading;
                // 라벨도 업데이트
                var existingLabel = shipLabelMap[ship.mmsi];
                if (existingLabel) {
                    existingLabel.position = position;
                }
            } else {
                // 새 billboard 추가
                var shipSize = getShipSize(ship.length, ship.beam);
                var bb = billboards.add({
                    position: position,
                    image: getShipIcon(SHIP_COLORS[type], type),
                    width: shipSize.width,
                    height: shipSize.height,
                    rotation: heading,
                    scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                });
                bb._mmsi = ship.mmsi;
                bb._shipType = type;
                shipBillboardMap[ship.mmsi] = bb;

                // 새 라벨 추가
                var lbl = labels.add({
                    position: position,
                    text: ship.name || '',
                    font: '11px Inter, sans-serif',
                    fillColor: Cesium.Color.fromCssColorString(SHIP_COLORS[type] || '#6b7280'),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -18),
                    scaleByDistance: new Cesium.NearFarScalar(5e5, 1.0, 5e6, 0.4),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                });
                lbl._mmsi = ship.mmsi;
                shipLabelMap[ship.mmsi] = lbl;
            }
        });

        // 뷰포트 밖이거나 사라진 선박 제거
        var toRemoveMmsis = [];
        for (var mmsi in shipBillboardMap) {
            var bb = shipBillboardMap[mmsi];
            if (bb._shipType === type && !seenMmsis.has(mmsi)) {
                toRemoveMmsis.push(mmsi);
            }
        }
        toRemoveMmsis.forEach(function(mmsi) {
            billboards.remove(shipBillboardMap[mmsi]);
            labels.remove(shipLabelMap[mmsi]);
            delete shipBillboardMap[mmsi];
            delete shipLabelMap[mmsi];
        });

        var countEl = document.getElementById('count-' + type);
        if (countEl) countEl.textContent = typeShips.length.toLocaleString();
    });
```

- [ ] **Step 3: 동작 확인**

브라우저에서 라이브 모드로 접속하여:
- 선박 아이콘이 정상 표시되는지 확인
- 선박 위치가 1초마다 갱신되는지 확인
- 타입별 체크박스 토글이 작동하는지 확인
- FPS가 개선되었는지 확인 (Cesium Inspector 또는 개발자 도구)

- [ ] **Step 4: 커밋**

```bash
git add static/js/websocket.js
git commit -m "perf: replace Entity API with BillboardCollection for ship rendering"
```

---

### Task 4: 클릭 핸들러 수정 (ui-controls.js)

**Files:**
- Modify: `static/js/ui-controls.js:795-859` (showShipInfo + 클릭 핸들러)

- [ ] **Step 1: showShipInfo를 mmsi 기반으로 변경**

기존 `showShipInfo(entity)` (라인 795-815)는 Entity 객체를 받아서 `entity.description.getValue()`를 호출한다. Primitive에는 description이 없으므로, `shipDataMap`에서 직접 HTML을 생성하도록 변경한다.

기존:
```javascript
function showShipInfo(entity) {
    var panel = document.getElementById('shipInfoPanel');
    var title = document.getElementById('shipInfoTitle');
    var body = document.getElementById('shipInfoBody');

    var name = entity.name || 'UNKNOWN';
    title.textContent = name;

    var descHtml = '';
    if (entity.description) {
        if (entity.description.getValue) {
            descHtml = entity.description.getValue(viewer.clock.currentTime);
        } else {
            descHtml = entity.description;
        }
    }

    body.innerHTML = descHtml || '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
    panel.classList.add('visible');
}
```

새 코드:
```javascript
function showShipInfo(entityOrMmsi) {
    var panel = document.getElementById('shipInfoPanel');
    var title = document.getElementById('shipInfoTitle');
    var body = document.getElementById('shipInfoBody');

    // Entity 객체 또는 mmsi 문자열 둘 다 지원 (히스토리 모드 호환)
    var s;
    if (typeof entityOrMmsi === 'object' && entityOrMmsi !== null) {
        // Entity 객체 (히스토리 모드)
        var entityId = entityOrMmsi.id !== undefined ? entityOrMmsi.id : entityOrMmsi;
        s = shipDataMap[entityId];
        if (!s) {
            // 히스토리 모드 Entity — 기존 description 로직
            var name = entityOrMmsi.name || 'UNKNOWN';
            title.textContent = name;
            var descHtml = '';
            if (entityOrMmsi.description) {
                if (entityOrMmsi.description.getValue) {
                    descHtml = entityOrMmsi.description.getValue(viewer.clock.currentTime);
                } else {
                    descHtml = entityOrMmsi.description;
                }
            }
            body.innerHTML = descHtml || '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
            panel.classList.add('visible');
            return;
        }
    } else {
        s = shipDataMap[entityOrMmsi];
    }

    if (!s) {
        body.innerHTML = '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
        panel.classList.add('visible');
        return;
    }

    title.textContent = s.name || 'UNKNOWN';

    var rows = '\
        <tr><th>Name</th><td>' + (s.name || 'UNKNOWN') + '</td></tr>\
        <tr><th>MMSI</th><td>' + s.mmsi + '</td></tr>\
        <tr><th>Type</th><td>' + (s.type || 'unknown') + '</td></tr>\
        <tr><th>Country</th><td>' + (s.country || 'UNKNOWN') + '</td></tr>\
        <tr><th>SOG</th><td>' + (s.sog || 0) + ' kts</td></tr>\
        <tr><th>COG</th><td>' + (s.cog || 0) + '\u00b0</td></tr>\
        <tr><th>Heading</th><td>' + (s.heading || 0) + '\u00b0</td></tr>';
    if (s.length) rows += '<tr><th>Length</th><td>' + s.length + ' m</td></tr>';
    if (s.beam) rows += '<tr><th>Beam</th><td>' + s.beam + ' m</td></tr>';
    if (s.draught) rows += '<tr><th>Draught</th><td>' + s.draught + ' m</td></tr>';
    if (s.destination && s.destination !== 'UNKNOWN') rows += '<tr><th>Destination</th><td>' + s.destination + '</td></tr>';
    if (s.eta) rows += '<tr><th>ETA</th><td>' + s.eta + '</td></tr>';
    if (s.callsign) rows += '<tr><th>Callsign</th><td>' + s.callsign + '</td></tr>';
    if (s.imo) rows += '<tr><th>IMO</th><td>' + s.imo + '</td></tr>';

    body.innerHTML = '<table class="cesium-infoBox-defaultTable"><tbody>' + rows + '</tbody></table>';
    panel.classList.add('visible');
}
```

- [ ] **Step 2: 클릭 핸들러를 Primitive 지원으로 수정**

기존 클릭 핸들러(라인 818-859)는 `picked.id`로 Entity를 찾는다. Primitive에서는 `picked.primitive._mmsi`로 선박을 식별해야 한다.

기존:
```javascript
var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(function(click) {
    var picked = viewer.scene.pick(click.position);
    if (Cesium.defined(picked) && picked.id) {
        var entityId = picked.id.id !== undefined ? picked.id.id : picked.id;

        // Satellite click -> footprint toggle + camera move
        if (_satRecCache[entityId]) {
            // ... satellite logic ...
            return;
        }

        showShipInfo(picked.id);
        if (shipDataMap[entityId]) {
            selectedProximityMmsi = entityId;
            collisionTargetMmsi = null;
            proximityMissCount = 0;
            updateProximity();
        } else {
            clearProximity();
        }
    } else {
        document.getElementById('shipInfoPanel').classList.remove('visible');
        clearProximity();
        if (_activeFootprintSatId) {
            var old = satDataSource.entities.getById('footprint-' + _activeFootprintSatId);
            if (old) satDataSource.entities.remove(old);
            _activeFootprintSatId = null;
        }
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

새 코드:
```javascript
var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(function(click) {
    var picked = viewer.scene.pick(click.position);

    if (Cesium.defined(picked)) {
        // Case 1: Entity (위성, 히스토리 모드 선박)
        if (picked.id) {
            var entityId = picked.id.id !== undefined ? picked.id.id : picked.id;

            // Satellite click
            if (_satRecCache[entityId]) {
                _toggleSatFootprint(entityId);
                if (_activeFootprintSatId === entityId) {
                    var pos = _getSatRealTimePosition(entityId);
                    if (pos) {
                        var horizonAngle = Math.acos(6371 / (6371 + pos.altKm));
                        var footprintRadiusKm = 6371 * horizonAngle;
                        var viewAlt = Math.max(footprintRadiusKm * 4 * 1000, 8000000);
                        smoothFlyTo({
                            destination: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, viewAlt)
                        });
                    }
                }
                return;
            }

            // 히스토리 모드 Entity 선박
            showShipInfo(picked.id);
            if (shipDataMap[entityId]) {
                selectedProximityMmsi = entityId;
                collisionTargetMmsi = null;
                proximityMissCount = 0;
                updateProximity();
            } else {
                clearProximity();
            }
            return;
        }

        // Case 2: Primitive billboard (라이브 모드 선박)
        if (picked.primitive && picked.primitive._mmsi) {
            var mmsi = picked.primitive._mmsi;
            showShipInfo(mmsi);
            selectedProximityMmsi = mmsi;
            collisionTargetMmsi = null;
            proximityMissCount = 0;
            updateProximity();
            return;
        }
    }

    // 빈 공간 클릭 — 패널 닫기
    document.getElementById('shipInfoPanel').classList.remove('visible');
    clearProximity();
    if (_activeFootprintSatId) {
        var old = satDataSource.entities.getById('footprint-' + _activeFootprintSatId);
        if (old) satDataSource.entities.remove(old);
        _activeFootprintSatId = null;
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

- [ ] **Step 3: 커밋**

```bash
git add static/js/ui-controls.js
git commit -m "refactor: update click handler and showShipInfo for Primitive support"
```

---

### Task 5: 근접/충돌 시각화 전환 (proximity.js)

**Files:**
- Modify: `static/js/proximity.js:214-417` (renderProximityLines)
- Modify: `static/js/proximity.js:486-498` (clearProximity)

- [ ] **Step 1: renderProximityLines를 Primitive Collection으로 교체**

기존 `renderProximityLines()` (라인 214-417)을 완전히 교체한다. CallbackProperty를 제거하고, 정적 값으로 Primitive를 추가한다.

기존 함수 전체를 다음으로 교체:

```javascript
function renderProximityLines(selectedMmsi, nearbyVessels) {
    // Primitive Collections 클리어
    proximityLines.removeAll();
    proximityLabels.removeAll();
    proximityCogLines.removeAll();
    proximityCpaPoints.removeAll();
    proximityCpaLabels.removeAll();
    proximityMap = {};

    // 2D Leaflet 클리어 (기존 로직 유지)
    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }

    var selected = shipDataMap[selectedMmsi];
    if (!selected || nearbyVessels.length === 0) return;

    var closestMmsi = nearbyVessels[0].mmsi;

    nearbyVessels.forEach(function(nv) {
        var isCollisionTarget = collisionTargetMmsi != null && (nv.mmsi == collisionTargetMmsi);
        var isMlPair = nv.mlRiskLevel != null;
        var color = isMlPair
            ? mlRiskColor(nv.mlRiskLevel)
            : isCollisionTarget
                ? { css: '#f43f5e', cesium: Cesium.Color.fromCssColorString('#f43f5e') }
                : proximityColor(nv.distance);
        var isHighlight = isMlPair || isCollisionTarget || nv.mmsi === closestMmsi;
        var showCollisionViz = isMlPair || isCollisionTarget;

        var sel = shipDataMap[selectedMmsi];
        var tgt = shipDataMap[nv.mmsi];
        if (!sel || !tgt) return;

        // 근접 라인
        var lineWidth = isMlPair ? 4 : isCollisionTarget ? 4 : isHighlight ? 3 : 2;
        var lineColor = isHighlight ? color.cesium.withAlpha(0.8) : color.cesium.withAlpha(0.6);

        var line = proximityLines.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                sel.lng, sel.lat, 50, tgt.lng, tgt.lat, 50
            ]),
            width: lineWidth,
            material: Cesium.Material.fromType('Color', { color: lineColor })
        });

        // 거리 라벨
        var dist = haversineNm(sel.lat, sel.lng, tgt.lat, tgt.lng);
        var prefix = (isMlPair || isCollisionTarget) ? '\u26a0 ' : '';
        var label = proximityLabels.add({
            position: Cesium.Cartesian3.fromDegrees(
                (sel.lng + tgt.lng) / 2,
                (sel.lat + tgt.lat) / 2
            ),
            text: prefix + dist.toFixed(1) + ' nm',
            font: isCollisionTarget ? 'bold 14px JetBrains Mono' : '12px JetBrains Mono',
            fillColor: color.cesium,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });

        var entry = { line: line, label: label };

        // 충돌 시각화 (COG + CPA)
        if (showCollisionViz) {
            // COG 프로젝션 — 선택 선박
            var selEnd = projectPosition(sel.lat, sel.lng, sel.cog || 0, Math.max((sel.sog || 0) / 60 * 10, 0.5));
            var cogSel = proximityCogLines.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    sel.lng, sel.lat, 50, selEnd.lng, selEnd.lat, 50
                ]),
                width: 2,
                material: Cesium.Material.fromType('PolylineDash', {
                    color: color.cesium.withAlpha(0.7),
                    dashLength: 12.0
                })
            });

            // COG 프로젝션 — 대상 선박
            var tgtEnd = projectPosition(tgt.lat, tgt.lng, tgt.cog || 0, Math.max((tgt.sog || 0) / 60 * 10, 0.5));
            var cogTgt = proximityCogLines.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    tgt.lng, tgt.lat, 50, tgtEnd.lng, tgtEnd.lat, 50
                ]),
                width: 2,
                material: Cesium.Material.fromType('PolylineDash', {
                    color: color.cesium.withAlpha(0.7),
                    dashLength: 12.0
                })
            });

            entry.cogSel = cogSel;
            entry.cogTgt = cogTgt;

            // CPA 마커 + 라벨
            var cpa = computeCpa(sel, tgt);
            if (cpa.tcpaMin > 0 && cpa.tcpaMin < 60) {
                var cpaPoint = proximityCpaPoints.add({
                    position: Cesium.Cartesian3.fromDegrees(cpa.lng, cpa.lat),
                    pixelSize: 10,
                    color: color.cesium.withAlpha(0.9),
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                });

                var cpaLabel = proximityCpaLabels.add({
                    position: Cesium.Cartesian3.fromDegrees(cpa.lng, cpa.lat),
                    text: 'CPA ' + cpa.dcpaNm.toFixed(2) + 'nm\n' + cpa.tcpaMin.toFixed(1) + 'min',
                    font: 'bold 11px JetBrains Mono',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    showBackground: true,
                    backgroundColor: color.cesium.withAlpha(0.7)
                });

                entry.cpaPoint = cpaPoint;
                entry.cpaLabel = cpaLabel;
            }
        }

        proximityMap[nv.mmsi] = entry;
    });
}
```

**참고:** 기존의 CPA risk zone 타원(pulsing ellipse)은 PolylineCollection에서 직접 지원하지 않으므로 제거한다. CPA 포인트 마커와 라벨이 충분히 위치를 알려준다.

- [ ] **Step 2: clearProximity를 Collection 클리어로 수정**

기존 (라인 486-498):
```javascript
function clearProximity() {
    selectedProximityMmsi = null;
    collisionTargetMmsi = null;
    proximityMissCount = 0;
    proximityDataSource.entities.removeAll();
    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }
    var section = document.getElementById('nearbyVesselsSection');
    if (section) section.style.display = 'none';
}
```

새 코드:
```javascript
function clearProximity() {
    selectedProximityMmsi = null;
    collisionTargetMmsi = null;
    proximityMissCount = 0;

    // Primitive Collections 클리어
    if (proximityLines) proximityLines.removeAll();
    if (proximityLabels) proximityLabels.removeAll();
    if (proximityCogLines) proximityCogLines.removeAll();
    if (proximityCpaPoints) proximityCpaPoints.removeAll();
    if (proximityCpaLabels) proximityCpaLabels.removeAll();
    proximityMap = {};

    // 기존 DataSource도 클리어 (히스토리 모드 호환)
    if (proximityDataSource) proximityDataSource.entities.removeAll();

    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }
    var section = document.getElementById('nearbyVesselsSection');
    if (section) section.style.display = 'none';
}
```

- [ ] **Step 3: 동작 확인**

브라우저에서:
- 선박 클릭 → 근접 라인이 표시되는지 확인
- 거리 라벨이 정상 표시되는지 확인
- 충돌 위험 쌍에서 COG 프로젝션 대시 라인이 보이는지 확인
- CPA 마커와 라벨이 표시되는지 확인
- 빈 공간 클릭 → 근접 시각화가 사라지는지 확인
- 선택 중 프레임 드랍이 없는지 확인

- [ ] **Step 4: 커밋**

```bash
git add static/js/proximity.js
git commit -m "perf: replace CallbackProperty with static Primitive Collections for proximity"
```

---

### Task 6: collision.js / ui-controls.js 참조 수정

**Files:**
- Modify: `static/js/collision.js:243-250`
- Modify: `static/js/ui-controls.js:276-278, 374-376, 404-407`

- [ ] **Step 1: collision.js — 선박 Entity 조회를 shipDataMap으로 교체**

기존 (라인 243-250):
```javascript
            for (var type in shipDataSources) {
                var entity = shipDataSources[type].entities.getById(mmsiA)
                    || shipDataSources[type].entities.getById(String(mmsiA));
                if (entity) {
                    showShipInfo(entity);
                    break;
                }
            }
```

새 코드:
```javascript
            // showShipInfo는 이제 mmsi도 받을 수 있음
            if (shipDataMap[mmsiA] || shipDataMap[String(mmsiA)]) {
                showShipInfo(mmsiA);
            }
```

- [ ] **Step 2: ui-controls.js — 히스토리/라이브 전환 시 Collection 클리어 추가**

라이브 모드 전환 시 (라인 373-377 부근) 기존 Entity removeAll 아래에 Collection 클리어를 추가한다.

기존:
```javascript
        SHIP_TYPES.forEach(function(type) {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });
```

이 패턴이 3곳에 있다 (라인 277, 375, 405). 각각 아래에 Collection 클리어를 추가:

```javascript
        SHIP_TYPES.forEach(function(type) {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
            if (shipBillboards[type]) shipBillboards[type].removeAll();
            if (shipLabels[type]) shipLabels[type].removeAll();
        });
        shipBillboardMap = {};
        shipLabelMap = {};
```

- [ ] **Step 3: ui-controls.js — 뉴스카드 선박 클릭 (라인 577-581)**

기존:
```javascript
                                for (var type in shipDataSources) {
                                    var ds = shipDataSources[type];
                                    var entity = ds.entities.getById(mmsi) || ds.entities.getById(String(mmsi)) || ds.entities.getById(Number(mmsi));
                                    if (entity) { viewer.selectedEntity = entity; showShipInfo(entity); break; }
                                }
```

새 코드:
```javascript
                                if (shipDataMap[mmsi] || shipDataMap[String(mmsi)]) {
                                    showShipInfo(mmsi);
                                    selectedProximityMmsi = mmsi;
                                    updateProximity();
                                }
```

- [ ] **Step 4: 커밋**

```bash
git add static/js/collision.js static/js/ui-controls.js
git commit -m "refactor: update shipDataSources references for Primitive migration"
```

---

### Task 7: 차트 업데이트 스로틀링 (charts.js)

**Files:**
- Modify: `static/js/charts.js:33-38` (resize 핸들러)
- Modify: `static/js/charts.js:295-316` (updateShipTypeChart)

- [ ] **Step 1: resize 이벤트 디바운스 추가**

기존 (라인 33-38):
```javascript
    window.addEventListener('resize', function() {
        if (gaugeChart) gaugeChart.resize();
        if (radarChart) radarChart.resize();
        if (shipTypeBarChart) shipTypeBarChart.resize();
    });
```

새 코드:
```javascript
    var _resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
            if (gaugeChart) gaugeChart.resize();
            if (radarChart) radarChart.resize();
            if (shipTypeBarChart) shipTypeBarChart.resize();
        }, 300);
    });
```

- [ ] **Step 2: updateShipTypeChart에 5초 스로틀 추가**

기존 (라인 295-316):
```javascript
function updateShipTypeChart(ships) {
    var chartEl = document.getElementById('shipTypeChart');
    if (!chartEl || !shipTypeBarChart) return;

    var counts = {};
    // ... counting logic ...
    shipTypeBarChart.setOption(buildShipTypeOption(counts));
    // ...
}
```

새 코드:
```javascript
var _lastShipTypeChartUpdate = 0;
function updateShipTypeChart(ships) {
    var now = Date.now();
    if (now - _lastShipTypeChartUpdate < 5000) return;
    _lastShipTypeChartUpdate = now;

    var chartEl = document.getElementById('shipTypeChart');
    if (!chartEl || !shipTypeBarChart) return;

    var counts = {};
    var TYPE_MAP = { military_vessel: 'military', unknown: 'other', yacht: 'other' };

    if (ships && ships.length > 0) {
        ships.forEach(function(s) {
            var raw = s.type || 'other';
            var type = TYPE_MAP[raw] || raw;
            if (SHIP_TYPES.indexOf(type) === -1) type = 'other';
            counts[type] = (counts[type] || 0) + 1;
        });
        chartEl.style.display = 'block';
        shipTypeBarChart.setOption(buildShipTypeOption(counts));
        setTimeout(function() { shipTypeBarChart.resize(); }, 100);
    } else {
        chartEl.style.display = 'none';
    }
}
```

- [ ] **Step 3: 커밋**

```bash
git add static/js/charts.js
git commit -m "perf: add resize debounce and chart update throttle"
```

---

### Task 8: 통합 테스트 및 엣지 케이스 확인

**Files:**
- 모든 수정된 파일

- [ ] **Step 1: 전체 동작 확인 체크리스트**

브라우저에서 다음을 순서대로 확인:

1. **라이브 모드 기본 렌더링**
   - 선박 아이콘이 타입별 색상으로 표시되는가
   - 선박 위치가 1초마다 갱신되는가
   - 줌/패닝이 부드러운가 (버벅임 없음)
   - FPS가 50 이상인가

2. **선박 인터랙션**
   - 선박 클릭 → 상세 패널 표시
   - 빈 공간 클릭 → 패널 닫힘
   - 타입별 체크박스 토글 → 해당 타입 숨김/표시

3. **근접/충돌 시각화**
   - 선박 선택 → 근접 라인 표시
   - 거리 라벨 정상 표시
   - COG 프로젝션 대시 라인 표시 (충돌 위험 쌍)
   - CPA 마커 표시
   - 다른 선박 선택 → 이전 근접 시각화 제거, 새로 표시
   - 선택 중에도 프레임 드랍 없음

4. **충돌 카드**
   - 충돌 카드 클릭 → 선박으로 이동 + 상세 패널 표시
   - 근접 시각화 연동

5. **위성 레이어**
   - 위성 클릭 → 기존과 동일하게 작동 (Entity 유지)

6. **모드 전환**
   - 히스토리 모드 전환 → Collection 클리어, Entity 렌더링
   - 라이브 모드 복귀 → Entity 클리어, Collection 렌더링

- [ ] **Step 2: 문제 발견 시 수정 후 커밋**

```bash
git add -A
git commit -m "fix: address integration test issues for Primitive migration"
```

- [ ] **Step 3: 최종 커밋 (없으면 스킵)**

모든 테스트 통과 시 최종 정리.
