# Vessel Proximity Distance Measurement

## Purpose

Provide real-time distance measurement between a selected vessel and nearby vessels on the CesiumJS map. This feature serves as the foundation for future collision analysis capabilities.

## Interaction Model

When a user clicks a vessel on the map, the system calculates distances to all vessels within a configurable radius and displays the closest ones. Selecting a different vessel switches the proximity view. Deselecting or clicking empty space clears it. Only ship entities activate proximity — satellites, restricted areas, and event markers do not.

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| Radius | 10 nm | Future: UI slider |
| Max displayed vessels | 10 | Within radius, sorted by distance |

## Distance Calculation

- **Algorithm:** Haversine formula (great-circle distance)
- **Input:** Decimal degrees (lat/lon as stored in `shipDataMap`)
- **Unit:** Nautical miles (nm)
- **Location:** Frontend only — all vessel coordinates are already available in memory from WebSocket updates
- **No backend changes required**

## Visualization — Map

### Connecting Lines
- Polyline from selected vessel to each nearby vessel
- Distance label at midpoint of each line (e.g., `3.2 nm`)
- Polylines rendered above ground with slight altitude to avoid z-fighting

### Risk Color Coding
| Distance | Color | Level |
|----------|-------|-------|
| < 2 nm | Red (#ef4444) | Danger |
| 2–5 nm | Yellow (#eab308) | Caution |
| > 5 nm | Green (#10b981) | Safe |

### Closest Vessel Highlight
- The connecting line to the closest vessel uses a pulse animation (alpha oscillation via `CallbackProperty`)

## Visualization — Panel

- New **"Nearby Vessels"** section inside the existing ship info panel (`shipInfoPanel`)
- Added as a separate `<div id="nearbyVesselsSection">` below `shipInfoBody`, so `showShipInfo()` innerHTML replacement does not wipe it
- List sorted by distance (ascending)
- Each row: risk color dot, vessel name, distance in nm
- Clicking a row flies the camera to that vessel (camera fly only, does not change selection)
- Panel scrollable if content exceeds max-height

## State Management

### New State Variable
- `selectedProximityMmsi` — tracks the MMSI of the currently selected vessel for proximity display
- Set on ship entity click, cleared on deselect / empty click / mode switch to history

### Entity Type Guard
- On click, check if the picked entity's ID exists as a key in `shipDataMap` before activating proximity logic
- Non-ship entities are handled as before (no proximity)

## Implementation Approach

### New Cesium DataSource
- `proximityDataSource` (`CustomDataSource`) — holds all proximity polylines and labels
- Cleared and rebuilt on: vessel selection change, throttled WebSocket position update

### Key Functions
1. `haversineNm(lat1, lon1, lat2, lon2)` — returns distance in nautical miles between two points in decimal degrees
2. `findNearbyVessels(selectedMmsi, allVessels, radiusNm, maxCount)` — filters `shipDataMap` for vessels present in current WebSocket payload (to exclude stale entries), returns sorted array of `{mmsi, name, distance, lat, lon}`
3. `renderProximityLines(selectedVessel, nearbyVessels)` — creates/updates polylines, labels, and pulse effect on `proximityDataSource`
4. `renderNearbyPanel(nearbyVessels)` — updates the nearby vessels panel HTML list

### Update Flow
1. User clicks map → `ScreenSpaceEventHandler` LEFT_CLICK fires (existing handler at line ~1936)
2. Check if picked entity is a ship (entity ID exists in `shipDataMap`)
3. Set `selectedProximityMmsi`, call `findNearbyVessels()` with current `shipDataMap` (cross-referenced against latest WebSocket payload to exclude stale entries)
4. Call `renderProximityLines()` and `renderNearbyPanel()`
5. On WebSocket `ships_update` message: if `selectedProximityMmsi` is set and `timeMode === 'live'`, recalculate (throttled to max once per 2 seconds to avoid flicker and GC pressure)
6. On deselect (click empty space), clear `selectedProximityMmsi`, `proximityDataSource.entities.removeAll()`, hide nearby panel section
7. On mode switch to history: clear all proximity state

### Pulse Animation (Closest Vessel)
- `CallbackProperty` on polyline material alpha
- `alpha = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 500))`

### Edge Cases
- **Selected vessel culled from viewport:** Proximity lines and panel persist as long as vessel data exists in `shipDataMap`. Lines will naturally update positions even if the entity billboard is removed by viewport culling.
- **Selected vessel disappears from WebSocket feed:** Clear proximity state after vessel is absent for 2+ consecutive updates.

## Scope

- **Live mode only** — history mode support deferred
- **No backend changes** — purely frontend feature
- **Future extensions:** collision risk scoring (CPA/TCPA), arbitrary point-to-point measurement (B mode), radius slider UI, selected vessel glow indicator
