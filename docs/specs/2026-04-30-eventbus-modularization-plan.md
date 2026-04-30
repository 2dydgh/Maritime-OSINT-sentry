# EventBus Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple data flow from rendering/UI by introducing EventBus + DataService, eliminating circular dependencies between collision.js and proximity.js.

**Architecture:** New event-bus.js and data-service.js files are loaded first. websocket.js is refactored to only receive data and call DataService. Rendering logic moves to subscribers in map-cesium.js, ui-controls.js, sparkline.js, map-leaflet.js. collision.js and proximity.js communicate via events instead of direct function calls.

**Tech Stack:** Vanilla JS, no build tools, `<script>` tag loading

---

## File Structure

**New files:**
- `static/js/event-bus.js` — Event publish/subscribe system (~20 lines)
- `static/js/data-service.js` — Centralized state management + event emission (~100 lines)

**Modified files:**
- `static/index.html` — Add new script tags at top of load order
- `static/js/app.js` — Replace direct var declarations with DataService references (compatibility bridge)
- `static/js/websocket.js` — Remove rendering/UI code, delegate to DataService
- `static/js/map-cesium.js` — Add EventBus subscribers for rendering + command:flyTo
- `static/js/map-leaflet.js` — Add EventBus subscriber for 2D sync
- `static/js/ui-controls.js` — Add EventBus subscriber for count updates + ws:status
- `static/js/sparkline.js` — Add EventBus subscriber for vessel/risk updates
- `static/js/collision.js` — Replace direct proximity/smoothFlyTo calls with EventBus.emit
- `static/js/proximity.js` — Subscribe to ship:selected, emit proximity:cleared

---

### Task 1: Create event-bus.js

**Files:**
- Create: `static/js/event-bus.js`

- [ ] **Step 1: Create event-bus.js**

```js
// ── Maritime OSINT Sentry — Event Bus ──
// Lightweight publish/subscribe for decoupling modules.
// Loaded before all other application scripts.

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
        (this._handlers[event] || []).forEach(function(fn) {
            try { fn(data); } catch (e) { console.error('[EventBus] Error in handler for "' + event + '":', e); }
        });
    }
};
```

- [ ] **Step 2: Add script tag to index.html**

Add as the **first** application script, before all other `js/` scripts (before `sparkline.js`). In `static/index.html`, find the line:

```html
    <script src="js/sparkline.js?v=1"></script>
```

Insert before it:

```html
    <script src="js/event-bus.js?v=1"></script>
```

- [ ] **Step 3: Verify in browser**

Open the app in browser, open DevTools console, run:
```
EventBus.on('test', function(d) { console.log('got:', d); });
EventBus.emit('test', 'hello');
```
Expected: `got: hello` in console. No errors on page load.

- [ ] **Step 4: Commit**

```bash
git add static/js/event-bus.js static/index.html
git commit -m "feat: add EventBus for decoupled module communication"
```

---

### Task 2: Create data-service.js

**Files:**
- Create: `static/js/data-service.js`

- [ ] **Step 1: Create data-service.js**

```js
// ── Maritime OSINT Sentry — Data Service ──
// Centralized state management. All data mutations go through here.
// Emits events so subscribers (map, UI, bottom bar) can react independently.

window.DataService = {
    ships: {},
    aircraft: {},
    collision: { distance: { risks: [] }, ml: { risks: [] } },
    latestShipMmsis: new Set(),

    updateShips: function(ships) {
        var counts = {};
        var totalByType = {};
        ships.forEach(function(s) {
            DataService.ships[s.mmsi] = s;
            var type = s.type || 'other';
            totalByType[type] = (totalByType[type] || 0) + 1;
        });
        // Preserve Set reference — clear and re-populate instead of replacing
        DataService.latestShipMmsis.clear();
        ships.forEach(function(s) { DataService.latestShipMmsis.add(s.mmsi); });
        EventBus.emit('ships:updated', { ships: ships, counts: totalByType });
    },

    updateAircraft: function(aircraft) {
        var counts = {};
        aircraft.forEach(function(ac) {
            DataService.aircraft[ac.icao24] = ac;
            var type = ac.category || 'other';
            counts[type] = (counts[type] || 0) + 1;
        });
        EventBus.emit('aircraft:updated', { aircraft: aircraft, counts: counts });
    },

    updateCollision: function(data) {
        DataService.collision = data;
        EventBus.emit('collision:updated', data);
    }
};
```

- [ ] **Step 2: Add script tag to index.html**

In `static/index.html`, insert after event-bus.js and before sparkline.js:

```html
    <script src="js/event-bus.js?v=1"></script>
    <script src="js/data-service.js?v=1"></script>
    <script src="js/sparkline.js?v=1"></script>
```

- [ ] **Step 3: Update app.js compatibility bridge**

Replace the direct variable declarations in `static/js/app.js` (lines 8-9, 37, 66-67) with references to DataService. The file should become:

```js
// ── Maritime OSINT Sentry — App Entry Point ──
// Compatibility bridge: existing code reads these globals,
// but they now reference DataService's objects.

var currentMapMode = '3d';
var leafletMap = null;
var viewer = null; // set in map-cesium.js

// ── Ship state — backed by DataService ──
var shipDataMap = DataService.ships;
var shipDataSources = {};
// Primitive Collection refs (set in map-cesium.js)
var shipBillboards = {};
var shipLabels = {};
var shipBillboardMap = {};
var shipLabelMap = {};
var shipCogLines = null;
var shipCogLineMap = {};
var SHIP_TYPES = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];
var SHIP_COLORS = {
    cargo: '#10b981',
    tanker: '#f97316',
    passenger: '#0ea5e9',
    fishing: '#eab308',
    military: '#002878',
    tug: '#6989E0',
    other: '#6b7280'
};

// Aircraft type system
var AIRCRAFT_TYPES = ['civilian', 'military', 'helicopter', 'other'];
var AIRCRAFT_COLORS = {
    civilian:   '#8b5cf6',
    military:   '#ef4444',
    helicopter: '#f59e0b',
    other:      '#9ca3af'
};

// ── Aircraft state — backed by DataService ──
var aircraftDataMap = DataService.aircraft;
var aircraftBillboards = {};
var aircraftLabels = {};
var aircraftBillboardMap = {};
var aircraftLabelMap = {};

var satDataSource = null;
var _satRecCache = {};
var SAT_COLORS = {
    military_recon: '#fde047',
    military_sar: '#f97316',
    sar: '#f97316',
    sigint: '#eab308',
    navigation: '#10b981',
    early_warning: '#3b82f6',
    space_station: '#002878',
    commercial_imaging: '#94a3b8',
};

var proximityDataSource = null;
var proximityLines = null;
var proximityLabels = null;
var proximityCogLines = null;
var proximityCpaPoints = null;
var proximityCpaLabels = null;
var proximityMap = {};
var selectedProximityMmsi = null;
var collisionTargetMmsi = null;
// ── Collision state — backed by DataService ──
var latestWsShipsMmsis = DataService.latestShipMmsis;
var collisionData = DataService.collision;
var collisionActiveTab = 'distance';
var mlRiskFilter = null;
var distRiskFilter = null;
var timeMode = 'live';
var _lastShipsData = null;

// Leaflet shared state
var leafletInitialized = false;
var leafletShipMarkers = {};
var leafletShipLayerGroups = {};
var leafletCollisionLines = {};
var leafletSatMarkers = {};
var leafletSatTracks = {};
var leafletSatFootprints = {};

// Proximity shared state
var lastProximityUpdate = 0;
var proximityMissCount = 0;
var PROXIMITY_RADIUS_NM = 10;
var PROXIMITY_MAX_COUNT = 10;
var PROXIMITY_THROTTLE_MS = 2000;

// ML risk colors and labels
var ML_RISK_COLORS = {
    3: '#f43f5e',
    2: '#f97316',
    1: '#eab308',
    0: '#10b981',
};
var ML_RISK_LABELS = { 3: '위험', 2: '경고', 1: '주의' };

// Ship 3D Model state
var ship3dDataSource = null;
var ship3dEntityMap = {};
var ship3dEnabled = false;
var SHIP_3D_HEIGHT_THRESHOLD = 30000;
var SHIP_3D_MAX_COUNT = 25;
var SHIP_3D_MODEL_URL = 'models/ships/cargo.glb';
```

Key changes: `shipDataMap`, `aircraftDataMap`, `latestWsShipsMmsis`, `collisionData` now reference DataService objects. Since JS objects are passed by reference, any code reading `shipDataMap.someKey` will get the same data as `DataService.ships.someKey`.

- [ ] **Step 4: Verify in browser**

Open app, check DevTools console:
```
DataService.ships === shipDataMap  // should be true
DataService.aircraft === aircraftDataMap  // should be true
```
No errors on page load. App should function identically.

- [ ] **Step 5: Commit**

```bash
git add static/js/data-service.js static/js/app.js static/index.html
git commit -m "feat: add DataService with compatibility bridge for global vars"
```

---

### Task 3: Refactor websocket.js — extract ship rendering to map-cesium.js subscriber

This is the largest task. We extract the ship rendering logic from `websocket.js` into `map-cesium.js` as an EventBus subscriber.

**Files:**
- Modify: `static/js/websocket.js` — Remove `updateShipsLayer()` rendering code, call `DataService.updateShips()` instead
- Modify: `static/js/map-cesium.js` — Add `EventBus.on('ships:updated', ...)` with the extracted rendering logic

- [ ] **Step 1: Identify the rendering code block in websocket.js**

In `websocket.js`, the function `updateShipsLayer(ships)` (around lines 220-500) does:
1. Store ships in `shipDataMap` (lines ~223)
2. Camera viewport culling (lines ~245-250)
3. Create/update Cesium billboards per ship type (lines ~260-420)
4. Update type count UI elements with `animateCount()` (lines ~306, ~407)
5. Remove stale ships not in latest data (lines ~410-440)
6. Update `BottomBar` (lines ~445-460)
7. Call `updateProximity()` (lines ~465)
8. Call `viewer.scene.requestRender()` (line ~492)
9. Similar for `updateAircraftLayer()` (lines ~500-760)

- [ ] **Step 2: In websocket.js, replace ship data storage with DataService call**

Find the `updateShipsLayer` function. At the top where it stores ships into `shipDataMap`:

**Before** (around line 223):
```js
ships.forEach(function(s) { shipDataMap[s.mmsi] = s; });
```

This line can be removed because `DataService.updateShips()` will handle it. But since `updateShipsLayer` also does rendering that we're moving, we need to restructure the entire `ws.onmessage` handler.

In the `ws.onmessage` handler (around line 770-870), find where ships data is processed:

**Before:**
```js
if (data.ships) {
    _lastShipsData = data.ships;
    latestWsShipsMmsis = new Set(data.ships.map(function(s) { return s.mmsi; }));
    updateShipsLayer(data.ships);
    // ... proximity, BottomBar calls
}
```

**After:**
```js
if (data.ships) {
    _lastShipsData = data.ships;
    DataService.updateShips(data.ships);
    // rendering, UI updates, and proximity are now handled by EventBus subscribers
}
```

Similarly for aircraft:

**Before:**
```js
if (data.aircraft) {
    updateAircraftLayer(data.aircraft);
}
```

**After:**
```js
if (data.aircraft) {
    DataService.updateAircraft(data.aircraft);
}
```

- [ ] **Step 3: Move ship rendering logic to map-cesium.js**

At the bottom of `static/js/map-cesium.js` (after all current code, before the closing), add the ship rendering subscriber. This is the rendering logic extracted from `updateShipsLayer()` in websocket.js:

```js
// ── EventBus Subscribers: Ship & Aircraft Rendering ──

EventBus.on('ships:updated', function(data) {
    if (timeMode !== 'live') return;
    var ships = data.ships;

    // Camera viewport culling (only render ships in view)
    var cameraRect = viewer.camera.computeViewRectangle();
    var visibleShips = ships;
    if (cameraRect) {
        var west = Cesium.Math.toDegrees(cameraRect.west) - 2;
        var east = Cesium.Math.toDegrees(cameraRect.east) + 2;
        var south = Cesium.Math.toDegrees(cameraRect.south) - 2;
        var north = Cesium.Math.toDegrees(cameraRect.north) + 2;
        visibleShips = ships.filter(function(s) {
            return s.lat >= south && s.lat <= north && s.lng >= west && s.lng <= east;
        });
    }

    // Group by type
    var byType = {};
    SHIP_TYPES.forEach(function(t) { byType[t] = []; });
    visibleShips.forEach(function(s) {
        var type = s.type || 'other';
        if (!byType[type]) byType[type] = [];
        byType[type].push(s);
    });

    // Update billboards per type
    SHIP_TYPES.forEach(function(type) {
        var typeShips = byType[type] || [];
        var bbCol = shipBillboards[type];
        var lbCol = shipLabels[type];
        if (!bbCol || !lbCol) return;

        bbCol.removeAll();
        lbCol.removeAll();

        var color = SHIP_COLORS[type] || '#6b7280';
        typeShips.forEach(function(s) {
            var pos = Cesium.Cartesian3.fromDegrees(s.lng, s.lat);
            var sz = getShipSize(s.length, s.beam);
            var icon = getShipIcon(color, type);

            var bb = bbCol.add({
                position: pos,
                image: icon,
                width: sz.width,
                height: sz.height,
                rotation: -Cesium.Math.toRadians(s.cog || 0),
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(1e3, 1.0, 8e6, 0.3)
            });
            shipBillboardMap[s.mmsi] = bb;

            var lb = lbCol.add({
                position: pos,
                text: s.name || '',
                font: '11px JetBrains Mono',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -sz.height / 2 - 6),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(1e3, 0.8, 3e6, 0.0),
                translucencyByDistance: new Cesium.NearFarScalar(5e4, 1.0, 2e6, 0.0)
            });
            shipLabelMap[s.mmsi] = lb;
        });
    });

    // COG direction lines
    if (shipCogLines) {
        shipCogLines.removeAll();
        shipCogLineMap = {};
        visibleShips.forEach(function(s) {
            if (!s.sog || s.sog < 0.5) return;
            var endPos = projectPosition(s.lat, s.lng, s.cog || 0, Math.max(s.sog / 60 * 5, 0.3));
            var line = shipCogLines.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    s.lng, s.lat, 50, endPos.lng, endPos.lat, 50
                ]),
                width: 1.5,
                material: Cesium.Material.fromType('Color', {
                    color: Cesium.Color.fromCssColorString(SHIP_COLORS[s.type || 'other'] || '#6b7280').withAlpha(0.4)
                })
            });
            shipCogLineMap[s.mmsi] = line;
        });
    }

    viewer.scene.requestRender();
});

EventBus.on('aircraft:updated', function(data) {
    if (timeMode !== 'live') return;
    var aircraft = data.aircraft;

    var cameraRect = viewer.camera.computeViewRectangle();
    var visible = aircraft;
    if (cameraRect) {
        var west = Cesium.Math.toDegrees(cameraRect.west) - 5;
        var east = Cesium.Math.toDegrees(cameraRect.east) + 5;
        var south = Cesium.Math.toDegrees(cameraRect.south) - 5;
        var north = Cesium.Math.toDegrees(cameraRect.north) + 5;
        visible = aircraft.filter(function(ac) {
            return ac.lat >= south && ac.lat <= north && ac.lng >= west && ac.lng <= east;
        });
    }

    var byType = {};
    AIRCRAFT_TYPES.forEach(function(t) { byType[t] = []; });
    visible.forEach(function(ac) {
        var type = ac.category || 'other';
        if (!byType[type]) byType[type] = [];
        byType[type].push(ac);
    });

    AIRCRAFT_TYPES.forEach(function(type) {
        var typeAircraft = byType[type] || [];
        var bbCol = aircraftBillboards[type];
        var lbCol = aircraftLabels[type];
        if (!bbCol || !lbCol) return;

        bbCol.removeAll();
        lbCol.removeAll();

        var color = AIRCRAFT_COLORS[type] || '#9ca3af';
        typeAircraft.forEach(function(ac) {
            var alt = (ac.alt || 10000) * 0.3048;
            var pos = Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat, alt);
            var icon = getAircraftIcon(color, type);

            var bb = bbCol.add({
                position: pos,
                image: icon,
                width: 24,
                height: 24,
                rotation: -Cesium.Math.toRadians(ac.heading || 0),
                alignedAxis: Cesium.Cartesian3.UNIT_Z,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(1e3, 1.0, 8e6, 0.3)
            });
            aircraftBillboardMap[ac.icao24] = bb;

            var lb = lbCol.add({
                position: pos,
                text: ac.callsign || ac.icao24 || '',
                font: '10px JetBrains Mono',
                fillColor: Cesium.Color.fromCssColorString(color),
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -18),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(1e3, 0.7, 3e6, 0.0),
                translucencyByDistance: new Cesium.NearFarScalar(5e4, 1.0, 2e6, 0.0)
            });
            aircraftLabelMap[ac.icao24] = lb;
        });
    });

    viewer.scene.requestRender();
});

EventBus.on('command:flyTo', function(data) {
    smoothFlyTo({
        destination: Cesium.Cartesian3.fromDegrees(data.lng, data.lat, data.height || 50000)
    });
});
```

**IMPORTANT:** The rendering code above is a reference template. During implementation, you MUST read the actual `updateShipsLayer()` and `updateAircraftLayer()` functions from `websocket.js` carefully and extract the exact Cesium rendering logic, preserving all billboard properties, label properties, COG line logic, and viewport culling logic. The code above captures the pattern but the actual property values (scaleByDistance, font sizes, pixel offsets, etc.) must match the original websocket.js implementation exactly.

- [ ] **Step 4: Remove rendering code from websocket.js**

After moving the rendering logic to map-cesium.js, the `updateShipsLayer()` and `updateAircraftLayer()` functions in websocket.js should be deleted entirely. The `ws.onmessage` handler now only calls `DataService.updateShips()` and `DataService.updateAircraft()`.

Keep in websocket.js:
- `initWebSocket()` function and reconnection logic
- `getShipIcon()`, `getAircraftIcon()`, `getShipSize()` utility functions (and their caches)
- `showShipInfo()`, `highlightShip()`, `clearShipHighlight()` functions
- WS status reporting: replace direct `setWsStatus()` calls with `EventBus.emit('ws:status', 'connected')` etc.

- [ ] **Step 5: Verify in browser**

1. Open the app
2. Wait for WebSocket connection (LED should turn green)
3. Ships should appear on 3D globe with correct icons, labels, COG lines
4. Aircraft should appear if enabled
5. Check DevTools console for errors
6. Switch to 2D mode — ships should sync
7. Click a ship — info panel should appear

- [ ] **Step 6: Commit**

```bash
git add static/js/websocket.js static/js/map-cesium.js
git commit -m "refactor: move ship/aircraft rendering from websocket to map-cesium EventBus subscriber"
```

---

### Task 4: Wire up UI and bottom bar subscribers

**Files:**
- Modify: `static/js/ui-controls.js` — Add EventBus subscribers for count updates and WS status
- Modify: `static/js/sparkline.js` — Add EventBus subscribers for vessel types and risk levels
- Modify: `static/js/map-leaflet.js` — Add EventBus subscriber for 2D ship sync

- [ ] **Step 1: Add UI count subscriber in ui-controls.js**

At the bottom of `static/js/ui-controls.js`, add:

```js
// ── EventBus Subscribers ──

EventBus.on('ships:updated', function(data) {
    var totalEl = document.getElementById('total-ships');
    if (totalEl) animateCount(totalEl, data.ships.length.toLocaleString());

    // Per-type counts
    SHIP_TYPES.forEach(function(type) {
        var countEl = document.getElementById('count-' + type);
        if (countEl) animateCount(countEl, (data.counts[type] || 0).toLocaleString());
    });
});

EventBus.on('aircraft:updated', function(data) {
    var totalAcEl = document.getElementById('total-aircraft');
    if (totalAcEl) animateCount(totalAcEl, data.aircraft.length.toLocaleString());

    AIRCRAFT_TYPES.forEach(function(type) {
        var countEl = document.getElementById('count-ac-' + type);
        if (countEl) animateCount(countEl, (data.counts[type] || 0).toLocaleString());
    });
});

EventBus.on('ws:status', function(status) {
    setWsStatus(status);
});
```

- [ ] **Step 2: Add bottom bar subscriber in sparkline.js**

At the bottom of `static/js/sparkline.js` (after the IIFE that defines `BottomBar`, after `window.BottomBar = BottomBar;`), add:

```js
// ── EventBus Subscribers ──

EventBus.on('ships:updated', function(data) {
    BottomBar.updateVesselTypes(data.counts);
    BottomBar.updateFlagDistribution(data.ships);
    BottomBar._storeVessels(data.ships);
});

EventBus.on('aircraft:updated', function(data) {
    BottomBar.updateAircraftTypes(data.aircraft);
});

EventBus.on('collision:updated', function(data) {
    var mlRisks = (data.ml && data.ml.risks) || [];
    var mlByLevel = { 1: 0, 2: 0, 3: 0 };
    mlRisks.forEach(function(r) { if (mlByLevel[r.risk_level] !== undefined) mlByLevel[r.risk_level]++; });
    BottomBar.updateValue('bottomRisk', mlRisks.length);
    BottomBar.updateRiskLevels(mlByLevel[3], mlByLevel[2], mlByLevel[1]);
});
```

- [ ] **Step 3: Add 2D sync subscriber in map-leaflet.js**

At the bottom of `static/js/map-leaflet.js`, add:

```js
// ── EventBus Subscribers ──

EventBus.on('ships:updated', function(data) {
    if (currentMapMode === '2d') syncShipsToLeaflet();
});

EventBus.on('proximity:updated', function(data) {
    if (currentMapMode === '2d') syncProximityToLeaflet();
});
```

- [ ] **Step 4: Remove duplicate calls from websocket.js**

After adding the subscribers, ensure the following direct calls are removed from `websocket.js` (they were in `updateShipsLayer` and `ws.onmessage`):
- `animateCount(...)` calls for ship/aircraft counts
- `BottomBar.updateVesselTypes(...)` calls
- `BottomBar.updateAircraftTypes(...)` calls
- `BottomBar.updateFlagDistribution(...)` calls
- `BottomBar._storeVessels(...)` calls
- `setWsStatus(...)` calls (replace with `EventBus.emit('ws:status', ...)`)
- `syncShipsToLeaflet()` calls

These should already be gone if Task 3 was done correctly (since `updateShipsLayer` was deleted), but verify nothing remains in `ws.onmessage`.

- [ ] **Step 5: Verify in browser**

1. Ship type counts in left sidebar update correctly
2. Total ships/aircraft count in header updates
3. Bottom bar vessel treemap updates
4. Bottom bar flag distribution updates
5. WS LED turns green on connect, red on disconnect
6. Switch to 2D — ships appear on Leaflet map
7. All counts match between header, sidebar, and bottom bar

- [ ] **Step 6: Commit**

```bash
git add static/js/ui-controls.js static/js/sparkline.js static/js/map-leaflet.js static/js/websocket.js
git commit -m "refactor: wire UI, bottom bar, and 2D map to EventBus subscribers"
```

---

### Task 5: Decouple collision.js from proximity.js

**Files:**
- Modify: `static/js/collision.js` — Replace direct proximity/smoothFlyTo calls with EventBus.emit
- Modify: `static/js/proximity.js` — Subscribe to ship:selected, emit proximity:cleared

- [ ] **Step 1: Refactor collision.js _handleCollisionCardClick**

In `static/js/collision.js`, replace `_handleCollisionCardClick()` (lines 343-413). The key changes:

1. Replace `smoothFlyTo({...})` with `EventBus.emit('command:flyTo', {...})`
2. Replace direct `selectedProximityMmsi = mmsiA; updateProximity();` with `EventBus.emit('ship:selected', {...})`
3. Replace direct `renderProximityLines(...)` with `EventBus.emit('ship:selected', {...})` for ML tab too
4. Replace direct `showShipInfo(mmsiA)` and `highlightShip(mmsiA)` with keeping them as-is for now (these are simple UI functions, lower priority to decouple)

Replace the function body (keep the function signature and DOM highlighting at top):

```js
function _handleCollisionCardClick(card) {
    // Collision card selection highlight
    document.querySelectorAll('.collision-row.selected').forEach(function(c) { c.classList.remove('selected'); });
    card.classList.add('selected');

    var mmsiA = Number(card.dataset.mmsiA);
    var mmsiB = Number(card.dataset.mmsiB);

    // Real-time position preferred, fallback to card snapshot
    var shipA = shipDataMap[mmsiA] || shipDataMap[String(mmsiA)];
    var shipB = shipDataMap[mmsiB] || shipDataMap[String(mmsiB)];
    var latA = shipA ? shipA.lat : parseFloat(card.dataset.latA);
    var lngA = shipA ? shipA.lng : parseFloat(card.dataset.lngA);
    var latB = shipB ? shipB.lat : parseFloat(card.dataset.latB);
    var lngB = shipB ? shipB.lng : parseFloat(card.dataset.lngB);

    // CPA re-validation at click time
    if (shipA && shipB) {
        var cpa = computeCpa(shipA, shipB);
        if (cpa.dcpaNm > 1.0 || cpa.tcpaMin <= 0) {
            _showCollisionToast(
                '\u2713 \uc704\ud5d8 \ud574\uc81c',
                (shipA.name || mmsiA) + ' \u2194 ' + (shipB.name || mmsiB) + ' \u2014 \ud604\uc7ac \uc548\uc804 (CPA ' + cpa.dcpaNm.toFixed(2) + 'nm)'
            );
            fetchCollisionRisks();
            return;
        }
    }

    var midLat = (latA + latB) / 2;
    var midLng = (lngA + lngB) / 2;

    // Use EventBus instead of direct calls
    EventBus.emit('command:flyTo', { lat: midLat, lng: midLng, height: 15000 });

    if (collisionActiveTab === 'ml') {
        var riskLevel = parseInt(card.dataset.riskLevel) || 1;
        EventBus.emit('ship:selected', {
            mmsi: mmsiA,
            target: mmsiB,
            mode: 'pair',
            riskLevel: riskLevel,
            latA: latA, lngA: lngA,
            latB: latB, lngB: lngB,
            sogA: parseFloat(card.dataset.sogA) || 0,
            cogA: parseFloat(card.dataset.cogA) || 0,
            nameA: card.dataset.nameA || ''
        });
    } else {
        EventBus.emit('ship:selected', {
            mmsi: mmsiA,
            target: mmsiB,
            mode: 'proximity'
        });
    }

    // Start collision tracking
    _collisionTrackingActive = true;
    startCollisionTracking(mmsiA, mmsiB);

    if (shipA) {
        showShipInfo(mmsiA);
        highlightShip(mmsiA);
    }
}
```

- [ ] **Step 2: Refactor collision.js fetchCollisionRisks to use DataService**

In `fetchCollisionRisks()` (line 474-494), replace direct `collisionData = await resp.json()` with `DataService.updateCollision()`:

```js
async function fetchCollisionRisks() {
    try {
        var resp = await fetch('/api/v1/collision/risks');
        if (!resp.ok) return;
        var data = await resp.json();
        DataService.updateCollision(data);
        // collisionData is a reference to DataService.collision, so it's already updated
        renderCollisionList();

        var mlSerious = (data.ml?.risks || []).filter(function(r) { return r.risk_level >= 2; }).length;
        var total = (data.distance?.total || 0) + mlSerious;
        var badge = document.getElementById('collision-count');
        if (badge) animateCount(badge, total);

        _updateHeaderCollisionStats();

        if (typeof checkCollisionResolution === 'function') checkCollisionResolution();
    } catch (e) {
        console.warn('Collision fetch failed:', e);
    }
}
```

- [ ] **Step 3: Add ship:selected subscriber in proximity.js**

At the bottom of `static/js/proximity.js`, add:

```js
// ── EventBus Subscribers ──

EventBus.on('ship:selected', function(data) {
    if (data.mode === 'pair') {
        // ML tab: show only the specific pair
        selectedProximityMmsi = null;
        collisionTargetMmsi = data.target;
        var distNm = haversineNm(data.latA, data.lngA, data.latB, data.lngB);
        var selFallback = { lat: data.latA, lng: data.lngA, sog: data.sogA || 0, cog: data.cogA || 0, name: data.nameA || '' };
        renderProximityLines(data.mmsi, [{
            mmsi: data.target,
            lat: data.latB,
            lng: data.lngB,
            distance: distNm,
            mlRiskLevel: data.riskLevel,
            _selData: selFallback
        }]);
        renderNearbyPanel([]);
    } else if (data.mode === 'proximity') {
        // Distance tab: show all nearby
        collisionTargetMmsi = data.target;
        selectedProximityMmsi = data.mmsi;
        proximityMissCount = 0;
        updateProximity();
    }
});
```

- [ ] **Step 4: Replace clearProximity direct call to clearCollisionPair with event**

In `static/js/proximity.js`, modify `clearProximity()` function. Replace the direct call:

**Before** (line 545-546):
```js
_collisionTrackingActive = false;
if (typeof clearCollisionPair === 'function') clearCollisionPair();
```

**After:**
```js
_collisionTrackingActive = false;
EventBus.emit('proximity:cleared');
```

Then in `static/js/collision.js`, at the bottom, add subscriber:

```js
// ── EventBus Subscribers ──

EventBus.on('proximity:cleared', function() {
    clearCollisionPair();
});
```

- [ ] **Step 5: Verify in browser**

1. Click a collision risk card (distance tab) — camera flies to midpoint, proximity lines appear
2. Click a collision risk card (ML tab) — camera flies, pair-only line appears
3. Click a different collision card — previous proximity clears, new one shows
4. Manually drag the map — collision tracking stops
5. When risk resolves — toast appears, proximity clears
6. Switch between distance/ML tabs — correct filtering

- [ ] **Step 6: Commit**

```bash
git add static/js/collision.js static/js/proximity.js
git commit -m "refactor: decouple collision/proximity via EventBus events"
```

---

### Task 6: Wire up proximity updates to ships:updated

Currently `updateProximity()` was called directly from `updateShipsLayer()` in websocket.js. Now that rendering is event-driven, proximity also needs to subscribe.

**Files:**
- Modify: `static/js/proximity.js` — Subscribe to ships:updated for proximity refresh

- [ ] **Step 1: Add proximity refresh subscriber**

At the bottom of `static/js/proximity.js` (with the other EventBus subscribers added in Task 5), add:

```js
EventBus.on('ships:updated', function(data) {
    // Refresh proximity lines if a ship is currently selected
    if (selectedProximityMmsi && timeMode === 'live') {
        // Throttle: only update every PROXIMITY_THROTTLE_MS
        var now = Date.now();
        if (now - lastProximityUpdate < PROXIMITY_THROTTLE_MS) return;
        lastProximityUpdate = now;
        updateProximity();
    }
});
```

- [ ] **Step 2: Verify in browser**

1. Click a collision card to activate proximity
2. Proximity lines should update as new ship data arrives via WebSocket
3. Lines should not flicker excessively (throttled to 2s)

- [ ] **Step 3: Commit**

```bash
git add static/js/proximity.js
git commit -m "refactor: proximity subscribes to ships:updated for live refresh"
```

---

### Task 7: Clean up websocket.js and final integration test

**Files:**
- Modify: `static/js/websocket.js` — Final cleanup, remove dead code

- [ ] **Step 1: Review and remove dead code in websocket.js**

After Tasks 3-6, `websocket.js` should no longer contain:
- `updateShipsLayer()` function (deleted in Task 3)
- `updateAircraftLayer()` function (deleted in Task 3)
- Direct calls to `animateCount()`, `BottomBar.*`, `syncShipsToLeaflet()`, `setWsStatus()`
- Direct calls to `updateProximity()`

Verify these are all gone. The file should now contain only:
- `getShipSize()`, `getShipIcon()`, `getAircraftIcon()`, `getSatIcon()` utility functions
- Cloud layer toggle (RainViewer)
- `showShipInfo()` function
- `highlightShip()`, `clearShipHighlight()` functions
- `initWebSocket()` with clean `ws.onmessage` that calls `DataService.updateShips/updateAircraft`
- WS status via `EventBus.emit('ws:status', ...)`

- [ ] **Step 2: Replace WS status calls**

In `initWebSocket()`, find all `setWsStatus(...)` calls and replace with `EventBus.emit('ws:status', ...)`:

**Before:**
```js
if (typeof setWsStatus === 'function') setWsStatus('connected');
```

**After:**
```js
EventBus.emit('ws:status', 'connected');
```

Do the same for `'disconnected'` and `'connecting'`.

- [ ] **Step 3: Full integration test**

Test all these scenarios in browser:

- [ ] WebSocket connects, LED turns green
- [ ] Ships appear on 3D globe with correct icons and labels
- [ ] Ship type counts update in sidebar and header
- [ ] Bottom bar vessel treemap updates
- [ ] Bottom bar flag distribution updates
- [ ] Click a ship → info panel opens
- [ ] Click collision card (distance tab) → fly to midpoint, proximity lines
- [ ] Click collision card (ML tab) → fly to midpoint, pair line only
- [ ] Proximity refreshes as new data arrives
- [ ] Clear proximity → lines disappear, tracking stops
- [ ] Switch to 2D → ships appear on Leaflet map
- [ ] Switch back to 3D → ships render on Cesium
- [ ] Aircraft appear if enabled in filters
- [ ] WS disconnect → LED turns red, reconnection attempts
- [ ] No errors in DevTools console

- [ ] **Step 4: Commit**

```bash
git add static/js/websocket.js
git commit -m "refactor: clean up websocket.js, remove dead rendering code"
```

---

### Task 8: Update collisionData reference sync

Since `collisionData` in app.js is now a reference to `DataService.collision`, but `DataService.updateCollision()` replaces the entire object (`DataService.collision = data`), the reference in app.js becomes stale. We need to handle this.

**Files:**
- Modify: `static/js/data-service.js` — Fix object replacement to preserve reference
- Modify: `static/js/collision.js` — Ensure collisionData stays in sync

- [ ] **Step 1: Fix DataService.updateCollision to preserve object reference**

In `static/js/data-service.js`, change `updateCollision`:

**Before:**
```js
updateCollision: function(data) {
    DataService.collision = data;
    EventBus.emit('collision:updated', data);
}
```

**After:**
```js
updateCollision: function(data) {
    // Preserve object reference for compatibility bridge
    // (collisionData in app.js points to this same object)
    DataService.collision.distance = data.distance || { risks: [] };
    DataService.collision.ml = data.ml || { risks: [] };
    EventBus.emit('collision:updated', DataService.collision);
}
```

This way `collisionData` (which is `=== DataService.collision`) keeps working because we mutate the existing object instead of replacing it.

- [ ] **Step 2: Verify in browser**

1. Wait for collision data to load (auto-fetched periodically)
2. Collision risk cards appear in the panel
3. Click a card — proximity lines show
4. `collisionData === DataService.collision` should be `true` in console
5. Bottom bar risk counts update

- [ ] **Step 3: Commit**

```bash
git add static/js/data-service.js
git commit -m "fix: preserve collisionData object reference in DataService.updateCollision"
```
