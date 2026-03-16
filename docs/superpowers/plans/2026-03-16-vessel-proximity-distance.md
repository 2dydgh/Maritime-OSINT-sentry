# Vessel Proximity Distance Measurement — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time distance measurement between a selected vessel and nearby vessels, with map visualization (colored polylines + labels) and an info panel list.

**Architecture:** Purely frontend — all distance calculations use haversine on coordinates already in `shipDataMap`. A new `CustomDataSource` holds proximity polylines/labels. A `selectedProximityMmsi` state variable tracks the active vessel. Updates are throttled to once per 2 seconds on WebSocket messages.

**Tech Stack:** CesiumJS 1.114 (CustomDataSource, CallbackProperty, PolylineGlowMaterialProperty), vanilla JS

---

## File Structure

All changes are in a single file:
- **Modify:** `static/index.html`
  - CSS: new styles for nearby vessels panel section (~15 lines)
  - HTML: new `nearbyVesselsSection` div inside `shipInfoPanel` (~5 lines)
  - JS: proximity logic functions and integration hooks (~150 lines)

No new files. No backend changes.

---

## Chunk 1: Core Implementation

### Task 1: Add CSS styles for nearby vessels section

**Files:**
- Modify: `static/index.html:379-386` (after `#shipInfoPanel` styles)

- [ ] **Step 1: Add CSS for nearby vessels section**

Insert after the `#shipInfoPanel` block (line 386):

```css
/* Nearby Vessels proximity list */
#nearbyVesselsSection {
    border-top: 1px solid var(--panel-border);
    max-height: 200px;
    overflow-y: auto;
    padding: 8px 12px;
    display: none;
}

#nearbyVesselsSection .section-title {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--accent-cyan);
    letter-spacing: 0.08em;
    margin-bottom: 6px;
}

.nearby-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
    font-size: 0.75rem;
    font-family: 'JetBrains Mono', monospace;
    transition: background 0.15s;
    border-radius: 4px;
    padding: 4px 6px;
}

.nearby-row:hover {
    background: rgba(56, 189, 248, 0.1);
}

.nearby-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.nearby-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-main);
}

.nearby-dist {
    color: var(--text-dim);
    flex-shrink: 0;
}
```

- [ ] **Step 2: Update `#shipInfoPanel` max-height**

Change line 384 from `max-height: 380px;` to `max-height: 520px;` to accommodate the nearby vessels section.

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "style: add CSS for nearby vessels proximity section"
```

---

### Task 2: Add HTML for nearby vessels section

**Files:**
- Modify: `static/index.html:681` (inside `shipInfoPanel`, after `shipInfoBody`)

- [ ] **Step 1: Add nearbyVesselsSection div**

Insert after `<div id="shipInfoBody" class="drag-panel-body"></div>` (line 681):

```html
<div id="nearbyVesselsSection">
    <div class="section-title">NEARBY VESSELS</div>
    <div id="nearbyVesselsList"></div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: add nearby vessels section HTML to ship info panel"
```

---

### Task 3: Add haversine and findNearbyVessels functions

**Files:**
- Modify: `static/index.html` — insert after `const shipDataMap = {};` (line 1450)

- [ ] **Step 1: Add utility functions**

Insert after line 1450 (`const shipDataMap = {};`):

```javascript
// ── Vessel Proximity Distance ────────────────────────────────────────
const PROXIMITY_RADIUS_NM = 10;
const PROXIMITY_MAX_COUNT = 10;
const PROXIMITY_THROTTLE_MS = 2000;
let selectedProximityMmsi = null;  // stores raw MMSI value (same type as shipDataMap keys)
let lastProximityUpdate = 0;
let proximityMissCount = 0; // consecutive WS updates where selected vessel is absent
let latestWsShipsMmsis = new Set(); // tracks MMSIs from latest WebSocket payload

const proximityDataSource = new Cesium.CustomDataSource('Proximity');
viewer.dataSources.add(proximityDataSource);

/**
 * Haversine distance between two points in decimal degrees.
 * Returns distance in nautical miles.
 */
function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius in nautical miles
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
              Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Find nearby vessels within radius, sorted by distance, max count.
 * Only includes vessels present in the latest WebSocket payload (not stale).
 */
function findNearbyVessels(mmsi, radiusNm, maxCount) {
    const selected = shipDataMap[mmsi];
    if (!selected) return [];

    const results = [];
    for (const [key, vessel] of Object.entries(shipDataMap)) {
        if (key == mmsi) continue; // == for loose type comparison (number/string)
        if (!latestWsShipsMmsis.has(vessel.mmsi)) continue; // use vessel's own mmsi for Set lookup

        const dist = haversineNm(selected.lat, selected.lng, vessel.lat, vessel.lng);
        if (dist <= radiusNm) {
            results.push({
                mmsi: vessel.mmsi,
                name: vessel.name || 'UNKNOWN',
                distance: dist,
                lat: vessel.lat,
                lng: vessel.lng
            });
        }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, maxCount);
}
```

- [ ] **Step 2: Verify no syntax errors**

Open the app in browser, check console for errors. The functions are defined but not yet called, so the app should work exactly as before.

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat: add haversine distance and findNearbyVessels functions"
```

---

### Task 4: Add proximity rendering functions (map + panel)

**Files:**
- Modify: `static/index.html` — insert directly after the `findNearbyVessels` function

- [ ] **Step 1: Add risk color helper and renderProximityLines**

```javascript
function proximityColor(distNm) {
    if (distNm < 2) return { css: '#ef4444', cesium: Cesium.Color.fromCssColorString('#ef4444') };
    if (distNm < 5) return { css: '#eab308', cesium: Cesium.Color.fromCssColorString('#eab308') };
    return { css: '#10b981', cesium: Cesium.Color.fromCssColorString('#10b981') };
}

function renderProximityLines(selectedMmsi, nearbyVessels) {
    proximityDataSource.entities.removeAll();
    const selected = shipDataMap[selectedMmsi];
    if (!selected || nearbyVessels.length === 0) return;

    const closestMmsi = nearbyVessels[0].mmsi;

    nearbyVessels.forEach(nv => {
        const color = proximityColor(nv.distance);
        const isClosest = nv.mmsi === closestMmsi;

        // Polyline
        proximityDataSource.entities.add({
            id: `prox-line-${nv.mmsi}`,
            polyline: {
                positions: new Cesium.CallbackProperty(() => {
                    const sel = shipDataMap[selectedMmsi];
                    const tgt = shipDataMap[nv.mmsi];
                    if (!sel || !tgt) return [];
                    return Cesium.Cartesian3.fromDegreesArray([
                        sel.lng, sel.lat, tgt.lng, tgt.lat
                    ]);
                }, false),
                width: isClosest ? 3 : 2,
                material: isClosest
                    ? new Cesium.PolylineGlowMaterialProperty({
                        color: new Cesium.CallbackProperty(() => {
                            const alpha = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 500));
                            return color.cesium.withAlpha(alpha);
                        }, false),
                        glowPower: 0.3
                    })
                    : new Cesium.ColorMaterialProperty(color.cesium.withAlpha(0.6)),
                clampToGround: false
            }
        });

        // Label at midpoint
        proximityDataSource.entities.add({
            id: `prox-label-${nv.mmsi}`,
            position: new Cesium.CallbackProperty(() => {
                const sel = shipDataMap[selectedMmsi];
                const tgt = shipDataMap[nv.mmsi];
                if (!sel || !tgt) return Cesium.Cartesian3.fromDegrees(0, 0);
                return Cesium.Cartesian3.fromDegrees(
                    (sel.lng + tgt.lng) / 2,
                    (sel.lat + tgt.lat) / 2
                );
            }, false),
            label: {
                text: new Cesium.CallbackProperty(() => {
                    const sel = shipDataMap[selectedMmsi];
                    const tgt = shipDataMap[nv.mmsi];
                    if (!sel || !tgt) return '';
                    const d = haversineNm(sel.lat, sel.lng, tgt.lat, tgt.lng);
                    return d.toFixed(1) + ' nm';
                }, false),
                font: '12px JetBrains Mono',
                fillColor: color.cesium,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
    });
}
```

- [ ] **Step 2: Add renderNearbyPanel function**

```javascript
function renderNearbyPanel(nearbyVessels) {
    const section = document.getElementById('nearbyVesselsSection');
    const list = document.getElementById('nearbyVesselsList');

    if (nearbyVessels.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = nearbyVessels.map(nv => {
        const color = proximityColor(nv.distance);
        return `<div class="nearby-row" data-mmsi="${nv.mmsi}" data-lat="${nv.lat}" data-lng="${nv.lng}">
            <span class="nearby-dot" style="background:${color.css}"></span>
            <span class="nearby-name">${nv.name}</span>
            <span class="nearby-dist">${nv.distance.toFixed(1)} nm</span>
        </div>`;
    }).join('');

    // Click handler: fly to vessel
    list.querySelectorAll('.nearby-row').forEach(row => {
        row.addEventListener('click', () => {
            const lat = parseFloat(row.dataset.lat);
            const lng = parseFloat(row.dataset.lng);
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lng, lat, 50000)
            });
        });
    });
}

function clearProximity() {
    selectedProximityMmsi = null;
    proximityMissCount = 0;
    proximityDataSource.entities.removeAll();
    const section = document.getElementById('nearbyVesselsSection');
    if (section) section.style.display = 'none';
}

function updateProximity() {
    if (!selectedProximityMmsi || timeMode !== 'live') {
        clearProximity();
        return;
    }
    // Tolerate 2 consecutive misses before clearing (spec requirement)
    if (!latestWsShipsMmsis.has(selectedProximityMmsi)) {
        proximityMissCount++;
        if (proximityMissCount >= 2) {
            clearProximity();
        }
        return;
    }
    proximityMissCount = 0; // reset on successful match
    const nearby = findNearbyVessels(selectedProximityMmsi, PROXIMITY_RADIUS_NM, PROXIMITY_MAX_COUNT);
    renderProximityLines(selectedProximityMmsi, nearby);
    renderNearbyPanel(nearby);
}
// ── End Vessel Proximity Distance ────────────────────────────────────
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat: add proximity rendering functions (map lines + panel list)"
```

---

### Task 5: Integrate proximity into click handler and WebSocket

**Files:**
- Modify: `static/index.html` — the click handler (~line 1937) and WebSocket onmessage (~line 1596)

- [ ] **Step 1: Modify click handler to activate proximity**

Replace the existing click handler (lines 1937-1944):

```javascript
handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (Cesium.defined(picked) && picked.id) {
        showShipInfo(picked.id);
    } else {
        document.getElementById('shipInfoPanel').style.display = 'none';
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

With:

```javascript
handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (Cesium.defined(picked) && picked.id) {
        showShipInfo(picked.id);
        // Activate proximity only for ship entities
        // picked.id is a Cesium Entity; picked.id.id is the entity's ID (= ship.mmsi)
        const entityId = picked.id.id !== undefined ? picked.id.id : picked.id;
        if (shipDataMap[entityId]) {
            selectedProximityMmsi = entityId; // keep raw type matching shipDataMap keys
            proximityMissCount = 0;
            updateProximity();
        } else {
            clearProximity();
        }
    } else {
        document.getElementById('shipInfoPanel').style.display = 'none';
        clearProximity();
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

- [ ] **Step 2: Modify close button to clear proximity**

Replace the close button handler (line 1908-1910):

```javascript
document.getElementById('shipInfoClose').addEventListener('click', () => {
    document.getElementById('shipInfoPanel').style.display = 'none';
});
```

With:

```javascript
document.getElementById('shipInfoClose').addEventListener('click', () => {
    document.getElementById('shipInfoPanel').style.display = 'none';
    clearProximity();
});
```

- [ ] **Step 3: Add latestWsShipsMmsis tracking and throttled proximity update to WebSocket handler**

In the `ws.onmessage` handler, after `updateShipsLayer(data.ships || []);` (line 1603), add:

```javascript
                        // Track which MMSIs are in the latest payload (for proximity staleness check)
                        latestWsShipsMmsis = new Set((data.ships || []).map(s => s.mmsi));

                        // Throttled proximity update
                        if (selectedProximityMmsi) {
                            const now = Date.now();
                            if (now - lastProximityUpdate >= PROXIMITY_THROTTLE_MS) {
                                lastProximityUpdate = now;
                                updateProximity();
                            }
                        }
```

- [ ] **Step 4: Add mode-switch guard**

Find the section where `timeMode` is set to `'history'` (the history mode activation logic). Add `clearProximity();` when switching to history mode. Search for `timeMode = 'history'` and add the call right after it.

- [ ] **Step 5: Manual test in browser**

1. Open the app in live mode
2. Click a vessel — verify polylines appear to nearby vessels with distance labels
3. Verify the nearby vessels panel section appears below ship info
4. Verify colors: red < 2nm, yellow 2-5nm, green > 5nm
5. Verify closest vessel line pulses
6. Click a nearby vessel row — camera should fly there
7. Click empty space — proximity clears
8. Switch to history mode — proximity clears

- [ ] **Step 6: Commit**

```bash
git add static/index.html
git commit -m "feat: integrate vessel proximity into click handler and WebSocket updates"
```

---

## Chunk 2: Polish and Edge Cases

### Task 6: Handle edge cases

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: Verify selected vessel disappearance handling**

The `updateProximity()` function uses `proximityMissCount` to tolerate up to 2 consecutive WebSocket updates where the selected vessel is absent before clearing. Already implemented in Task 4. Verify by testing.

- [ ] **Step 2: Verify proximity persists when camera pans away from selected vessel**

The polylines use `CallbackProperty` which reads from `shipDataMap`, not from entity positions. Polylines should persist even if the selected vessel's billboard is culled from viewport. Test by:
1. Select a vessel
2. Pan camera far away
3. Verify polylines still render (they may be off-screen, which is fine)

- [ ] **Step 3: Final commit**

```bash
git add static/index.html
git commit -m "feat: complete vessel proximity distance measurement feature"
```
