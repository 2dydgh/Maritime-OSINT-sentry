// ── Maritime OSINT Sentry — Leaflet 2D Map ──

var REGION_VIEWS = {
    'world':          { center: [20, 0],    zoom: 2 },
    'east-asia':      { center: [35, 125],  zoom: 5 },
    'southeast-asia': { center: [5, 115],   zoom: 5 },
    'europe':         { center: [50, 15],   zoom: 4 },
    'middle-east':    { center: [28, 48],   zoom: 5 },
    'africa':         { center: [5, 20],    zoom: 4 },
    'north-america':  { center: [40, -95],  zoom: 4 },
    'south-america':  { center: [-15, -55], zoom: 4 }
};

function flyToRegion2D(region, btn) {
    var view = REGION_VIEWS[region];
    if (!view || !leafletMap) return;
    document.querySelectorAll('.region-tab').forEach(function(b) { b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    leafletMap.flyTo(view.center, view.zoom, { duration: 0.8 });
}
window.flyToRegion2D = flyToRegion2D;

var REGION_TABS_2D = [
    { key: 'world', label: '전체' },
    { key: 'east-asia', label: '동아시아' },
    { key: 'southeast-asia', label: '동남아' },
    { key: 'europe', label: '유럽' },
    { key: 'middle-east', label: '중동' },
    { key: 'africa', label: '아프리카' },
    { key: 'north-america', label: '북미' },
    { key: 'south-america', label: '남미' }
];

var REGION_TABS_3D = [
    { key: 'korea', label: '한국 해역' },
    { key: 'arctic', label: '북극항로' },
    { key: 'somalia', label: '아덴만' },
    { key: 'malacca', label: '말라카' },
    { key: 'guinea', label: '기니만' }
];

function buildRegionTabs(mode) {
    var container = document.getElementById('regionTabs');
    if (!container) return;
    var tabs = mode === '2d' ? REGION_TABS_2D : REGION_TABS_3D;
    container.innerHTML = tabs.map(function(t, i) {
        return '<button class="region-tab' + (i === 0 ? ' active' : '') + '" data-region="' + t.key + '" data-mode="' + mode + '">' + t.label + '</button>';
    }).join('');
    container.onclick = function(e) {
        var btn = e.target.closest('.region-tab');
        if (!btn) return;
        container.querySelectorAll('.region-tab').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var region = btn.dataset.region;
        if (btn.dataset.mode === '2d') {
            flyToRegion2D(region, btn);
        } else if (typeof flyToRegion === 'function') {
            flyToRegion(region);
        }
    };
}
window.buildRegionTabs = buildRegionTabs;

function initLeaflet() {
    if (leafletInitialized) return;

    leafletMap = L.map('leafletContainer', {
        center: [20, 0],
        zoom: 2,
        minZoom: 2,
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true
    });

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        className: 'leaflet-satellite-dark'
    }).addTo(leafletMap);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
        pane: 'overlayPane'
    }).addTo(leafletMap);

    leafletInitialized = true;
}

// 2D zoom buttons — bind after DOM ready, use leafletMap at click time
document.addEventListener('DOMContentLoaded', function() {
    // Initial region tabs (3D is default)
    buildRegionTabs('3d');

    var zoomInBtn = document.getElementById('leafletZoomIn');
    var zoomOutBtn = document.getElementById('leafletZoomOut');
    if (zoomInBtn) zoomInBtn.addEventListener('click', function() { if (leafletMap) leafletMap.zoomIn(); });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', function() { if (leafletMap) leafletMap.zoomOut(); });
});

function setMapMode(mode) {
    if (mode === currentMapMode) return;
    currentMapMode = mode;

    var mapArea = document.getElementById('mapArea');
    var btns = document.querySelectorAll('.map-mode-btn');
    btns.forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });

    if (mode === '2d') {
        initLeaflet();

        viewer.useDefaultRenderLoop = false;

        mapArea.classList.add('mode-2d');

        leafletMap.invalidateSize();
        leafletMap.setView([20, 0], 2);

        buildRegionTabs('2d');

        // 로딩 표시 후 렌더링 — requestAnimationFrame으로 로딩 UI가 먼저 그려진 후 실행
        var loadingEl = document.getElementById('loading');
        var loadingTextEl = document.getElementById('loading-text');
        if (loadingEl && loadingTextEl) {
            loadingTextEl.textContent = '2D 지도 렌더링 중...';
            loadingEl.style.display = 'flex';
        }
        requestAnimationFrame(function() {
            setTimeout(function() {
                if (typeof syncShipsToLeaflet === 'function') syncShipsToLeaflet();
                if (typeof syncProximityToLeaflet === 'function') syncProximityToLeaflet();
                if (typeof syncSatellitesToLeaflet === 'function') syncSatellitesToLeaflet();
                if (loadingEl) loadingEl.style.display = 'none';
            }, 0);
        });

        if (timeMode === 'history' && !window._leaflet2dUpdateInterval) {
            window._leaflet2dUpdateInterval = setInterval(function() {
                if (currentMapMode === '2d') syncShipsToLeaflet();
            }, 2000);
        }
    } else {
        var center = leafletMap.getCenter();
        var zoom = leafletMap.getZoom();

        mapArea.classList.remove('mode-2d');
        viewer.useDefaultRenderLoop = true;
        viewer.resize();

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, zoomToAltitude(zoom)),
            duration: 0
        });

        if (window._leaflet2dUpdateInterval) {
            clearInterval(window._leaflet2dUpdateInterval);
            window._leaflet2dUpdateInterval = null;
        }

        clearLeafletLayers();

        buildRegionTabs('3d');
    }
}
window.setMapMode = setMapMode;

function syncShipsToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;

    Object.values(leafletShipLayerGroups).forEach(function(lg) { leafletMap.removeLayer(lg); });
    leafletShipLayerGroups = {};
    leafletShipMarkers = {};

    // shipDataMap에서 직접 읽기 (Entity 의존 제거)
    var shipsByType = {};
    Object.keys(shipDataMap).forEach(function(mmsi) {
        var ship = shipDataMap[mmsi];
        if (ship.lat == null || ship.lng == null) return;
        var type = ship.type || 'other';
        if (!shipsByType[type]) shipsByType[type] = [];
        shipsByType[type].push(ship);
    });

    SHIP_TYPES.forEach(function(type) {
        var ships = shipsByType[type];
        if (!ships || ships.length === 0) return;

        var lg = L.layerGroup();
        leafletShipLayerGroups[type] = lg;

        var color = SHIP_COLORS[type] || '#6b7280';
        ships.forEach(function(ship) {
            var marker = L.circleMarker([ship.lat, ship.lng], {
                radius: 4,
                fillColor: color,
                fillOpacity: 0.9,
                color: color,
                weight: 1,
                opacity: 0.7
            });

            marker.bindTooltip(ship.name || 'Unknown', {
                className: 'ship-tooltip-2d',
                direction: 'top',
                offset: [0, -6]
            });

            marker.on('click', function() {
                showShipInfo(ship.mmsi);
                selectedProximityMmsi = ship.mmsi;
                updateProximity();
            });

            lg.addLayer(marker);
            leafletShipMarkers[ship.mmsi] = { marker: marker, type: type };
        });

        var checkbox = document.getElementById('filter-' + type);
        if (!checkbox || checkbox.checked) {
            lg.addTo(leafletMap);
        }
    });
}

function syncProximityToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;

    Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
    leafletCollisionLines = {};

    if (!proximityDataSource) return;

    proximityDataSource.entities.values.forEach(function(entity) {
        if (entity.polyline) {
            try {
                var positions = entity.polyline.positions.getValue(viewer.clock.currentTime);
                if (!positions || positions.length < 2) return;

                var latLngs = positions.map(function(p) {
                    var c = Cesium.Cartographic.fromCartesian(p);
                    return [Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)];
                });

                var color = '#f59e0b';
                var id = entity.id || '';
                if (id.includes('cog-')) color = '#f43f5e';

                var isDashed = id.startsWith('cog-');
                var line = L.polyline(latLngs, {
                    color: color,
                    weight: isDashed ? 2 : 3,
                    opacity: 0.7,
                    dashArray: isDashed ? '8, 6' : null
                }).addTo(leafletMap);

                leafletCollisionLines[id] = line;
            } catch (e) { /* skip if positions can't be resolved */ }
        }

        if (entity.point && entity.position) {
            try {
                var pos = entity.position.getValue(viewer.clock.currentTime);
                if (!pos) return;

                var c = Cesium.Cartographic.fromCartesian(pos);
                var lat = Cesium.Math.toDegrees(c.latitude);
                var lon = Cesium.Math.toDegrees(c.longitude);

                var marker = L.circleMarker([lat, lon], {
                    radius: 6,
                    fillColor: '#f43f5e',
                    fillOpacity: 0.5,
                    color: '#f43f5e',
                    weight: 2
                }).addTo(leafletMap);

                leafletCollisionLines[entity.id] = marker;
            } catch (e) { /* skip */ }
        }
    });
}

var leafletSatFootprints = {};

function syncSatellitesToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;
    if (!satDataSource || !satDataSource.show) return;

    // Clear previous
    Object.values(leafletSatMarkers).forEach(function(m) { leafletMap.removeLayer(m); });
    Object.values(leafletSatTracks).forEach(function(t) { leafletMap.removeLayer(t); });
    Object.values(leafletSatFootprints).forEach(function(f) { leafletMap.removeLayer(f); });
    leafletSatMarkers = {};
    leafletSatTracks = {};
    leafletSatFootprints = {};

    var hasSatelliteJs = typeof satellite !== 'undefined';
    var now = new Date();
    var enabledMissions = typeof _getEnabledMissions === 'function' ? _getEnabledMissions() : null;
    var showOrbits = document.getElementById('layer-sat-ground').checked;
    var showFootprint = document.getElementById('layer-sat-footprint').checked;

    Object.entries(_satRecCache).forEach(function([satId, entry]) {
        var satrec = entry.satrec;
        var sat = entry.sat;
        var mission = sat.mission || '';

        // Respect mission filter
        if (enabledMissions && !enabledMissions.has(mission)) return;

        var lat, lng, altKm;

        // Propagate real-time position with satellite.js
        if (hasSatelliteJs && satrec) {
            try {
                var posVel = satellite.propagate(satrec, now);
                if (posVel.position) {
                    var gmst = satellite.gstime(now);
                    var geo = satellite.eciToGeodetic(posVel.position, gmst);
                    lat = satellite.degreesLat(geo.latitude);
                    lng = satellite.degreesLong(geo.longitude);
                    altKm = geo.height;
                }
            } catch (e) { /* fallback */ }
        }
        if (lat == null) {
            lat = sat.lat; lng = sat.lng; altKm = sat.alt_km || 400;
        }
        if (lat == null || lng == null) return;

        var color = SAT_COLORS[mission] || '#94a3b8';

        // Satellite marker with mission color
        var iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">' +
            '<circle cx="10" cy="10" r="4" fill="' + color + '" opacity="0.9"/>' +
            '<circle cx="10" cy="10" r="7" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.4"/>' +
            '<line x1="3" y1="10" x2="7" y2="10" stroke="' + color + '" stroke-width="1.5" opacity="0.6"/>' +
            '<line x1="13" y1="10" x2="17" y2="10" stroke="' + color + '" stroke-width="1.5" opacity="0.6"/>' +
            '</svg>';

        var marker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'sat-icon-2d',
                html: iconSvg,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            }),
            zIndexOffset: 500
        }).addTo(leafletMap);

        var tooltipContent = '<b>' + sat.name + '</b><br>' +
            '<span style="color:' + color + '">' + (sat.sat_type || mission) + '</span><br>' +
            'ALT: ' + Math.round(altKm) + ' km';
        marker.bindTooltip(tooltipContent, {
            className: 'ship-tooltip-2d',
            direction: 'top',
            offset: [0, -12]
        });

        marker.on('click', function() {
            if (typeof _toggleSatFootprint === 'function') {
                _toggleSatFootprint(satId);
                syncSatellitesToLeaflet(); // refresh to show/hide footprint
            }
        });

        leafletSatMarkers[satId] = marker;

        // Ground track
        if (showOrbits && hasSatelliteJs && satrec && typeof _computeGroundTrack === 'function') {
            var groundCoords = _computeGroundTrack(satrec, now, 100);
            if (groundCoords.length >= 4) {
                var latLngs = [];
                for (var i = 0; i < groundCoords.length; i += 2) {
                    latLngs.push([groundCoords[i + 1], groundCoords[i]]); // [lat, lng]
                }

                // Split at antimeridian to avoid wrapping artifacts
                var segments = _splitAtAntimeridian(latLngs);
                var trackGroup = L.layerGroup();
                segments.forEach(function(seg) {
                    L.polyline(seg, {
                        color: color,
                        weight: 1.5,
                        opacity: 0.35,
                        dashArray: '6, 4'
                    }).addTo(trackGroup);
                });
                trackGroup.addTo(leafletMap);
                leafletSatTracks[satId] = trackGroup;
            }
        }

        // Footprint (sensor coverage area)
        if (showFootprint && typeof _computeFootprint === 'function') {
            var fpCoords = _computeFootprint(lat, lng, altKm, 36);
            if (fpCoords.length >= 6) {
                var fpLatLngs = [];
                for (var j = 0; j < fpCoords.length; j += 2) {
                    fpLatLngs.push([fpCoords[j + 1], fpCoords[j]]); // [lat, lng]
                }
                var footprint = L.polygon(fpLatLngs, {
                    color: color,
                    weight: 1,
                    opacity: 0.4,
                    fillColor: color,
                    fillOpacity: 0.08,
                    dashArray: '4, 3'
                }).addTo(leafletMap);
                leafletSatFootprints[satId] = footprint;
            }
        }
    });
}

// Split polyline at antimeridian (±180°) to avoid wrapping artifacts
function _splitAtAntimeridian(latLngs) {
    if (latLngs.length < 2) return [latLngs];
    var segments = [];
    var current = [latLngs[0]];

    for (var i = 1; i < latLngs.length; i++) {
        var prevLng = latLngs[i - 1][1];
        var curLng = latLngs[i][1];
        if (Math.abs(curLng - prevLng) > 180) {
            // Antimeridian crossing — start new segment
            segments.push(current);
            current = [];
        }
        current.push(latLngs[i]);
    }
    if (current.length > 0) segments.push(current);
    return segments;
}

function clearLeafletLayers() {
    if (!leafletMap) return;
    Object.values(leafletShipLayerGroups).forEach(function(lg) { leafletMap.removeLayer(lg); });
    Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
    Object.values(leafletSatMarkers).forEach(function(m) { leafletMap.removeLayer(m); });
    Object.values(leafletSatTracks).forEach(function(t) { leafletMap.removeLayer(t); });
    Object.values(leafletSatFootprints).forEach(function(f) { leafletMap.removeLayer(f); });
    leafletShipMarkers = {};
    leafletShipLayerGroups = {};
    leafletCollisionLines = {};
    leafletSatMarkers = {};
    leafletSatTracks = {};
    leafletSatFootprints = {};
}

function altitudeToZoom(altitude) {
    return Math.max(2, Math.min(18, Math.round(Math.log2(40000000 / altitude) + 1)));
}

function zoomToAltitude(zoom) {
    return 40000000 / Math.pow(2, zoom - 1);
}
