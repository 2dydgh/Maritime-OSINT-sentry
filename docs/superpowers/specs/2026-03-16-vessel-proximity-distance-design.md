# Vessel Proximity Distance Measurement

## Purpose

Provide real-time distance measurement between a selected vessel and nearby vessels on the CesiumJS map. This feature serves as the foundation for future collision analysis capabilities.

## Interaction Model

When a user clicks a vessel on the map, the system calculates distances to all vessels within a configurable radius and displays the closest ones. Selecting a different vessel switches the proximity view. Deselecting clears it.

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| Radius | 10 nm | Future: UI slider |
| Max displayed vessels | 10 | Within radius, sorted by distance |

## Distance Calculation

- **Algorithm:** Haversine formula (great-circle distance)
- **Unit:** Nautical miles (nm)
- **Location:** Frontend only — all vessel coordinates are already available in memory from WebSocket updates
- **No backend changes required**

## Visualization — Map

### Connecting Lines
- Polyline from selected vessel to each nearby vessel
- Distance label at midpoint of each line (e.g., `3.2 nm`)

### Risk Color Coding
| Distance | Color | Level |
|----------|-------|-------|
| < 2 nm | Red (#ef4444) | Danger |
| 2–5 nm | Yellow (#eab308) | Caution |
| > 5 nm | Green (#10b981) | Safe |

### Closest Vessel Highlight
- The connecting line to the closest vessel uses a pulse animation (alpha oscillation via `CallbackProperty`)

## Visualization — Panel

- New **"Nearby Vessels"** section appended to the existing ship info panel (`selectedShipInfo`)
- List sorted by distance (ascending)
- Each row: risk color dot, vessel name, distance in nm
- Clicking a row flies the camera to that vessel

## Implementation Approach

### New Cesium DataSource
- `proximityDataSource` (`CustomDataSource`) — holds all proximity polylines and labels
- Cleared and rebuilt on: vessel selection change, WebSocket position update (when a vessel is selected)

### Key Functions
1. `haversineNm(lat1, lon1, lat2, lon2)` — returns distance in nautical miles
2. `findNearbyVessels(selectedMmsi, allVessels, radiusNm, maxCount)` — returns sorted array of `{mmsi, name, distance, lat, lon}`
3. `renderProximityLines(selectedVessel, nearbyVessels)` — creates/updates polylines, labels, and pulse effect on `proximityDataSource`
4. `renderNearbyPanel(nearbyVessels)` — updates the panel HTML list

### Update Flow
1. User clicks vessel → entity selection event fires
2. Call `findNearbyVessels()` with current vessel store
3. Call `renderProximityLines()` and `renderNearbyPanel()`
4. On each WebSocket `ships_update` message, if a vessel is selected, repeat steps 2–3
5. On deselect, clear `proximityDataSource` and hide panel section

### Pulse Animation (Closest Vessel)
- `CallbackProperty` on polyline material alpha
- `alpha = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 500))`

## Scope

- **Live mode only** — history mode support deferred
- **No backend changes** — purely frontend feature
- **Future extensions:** collision risk scoring (CPA/TCPA), arbitrary point-to-point measurement (B mode), radius slider UI
