// ── Maritime OSINT Sentry — WebSocket & Ship Updates ──

// Ship size based on actual vessel length (AIS dimension data)
function getShipSize(lengthM, beamM) {
    var len = lengthM || 50;
    var bm = beamM || 10;
    var h = Math.max(10, Math.min(30, 10 + (len / 400) * 20));
    var w = h * (bm / len) * 2.5;
    return { width: Math.max(8, Math.round(w)), height: Math.round(h) };
}
window.getShipSize = getShipSize;

// Ship icon SVG by type
var _shipIconCache = {};
function getShipIcon(colorHex, shipType) {
    var key = colorHex + '|' + (shipType || 'other');
    if (_shipIconCache[key]) return _shipIconCache[key];

    var c = colorHex;
    var s = '#000';
    var glow = '<defs>\
        <filter id=\'g\' x=\'-50%\' y=\'-50%\' width=\'200%\' height=\'200%\'>\
            <feDropShadow dx=\'0\' dy=\'0\' stdDeviation=\'2\' flood-color=\'rgba(0,0,0,0.7)\'/>\
        </filter>\
    </defs>';

    var hull;
    switch (shipType) {
        case 'cargo':
            hull = '<path d=\'M16,3 L24,10 L24,30 L22,34 L10,34 L8,30 L8,10 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <rect x=\'10\' y=\'12\' width=\'12\' height=\'3.5\' rx=\'0.5\' fill=\'white\' opacity=\'0.3\'/>\
                <rect x=\'10\' y=\'17\' width=\'12\' height=\'3.5\' rx=\'0.5\' fill=\'white\' opacity=\'0.25\'/>\
                <rect x=\'10\' y=\'22\' width=\'12\' height=\'3.5\' rx=\'0.5\' fill=\'white\' opacity=\'0.2\'/>\
                <rect x=\'13\' y=\'6\' width=\'6\' height=\'4\' rx=\'0.8\' fill=\'white\' opacity=\'0.4\'/>';
            break;
        case 'tanker':
            hull = '<ellipse cx=\'16\' cy=\'20\' rx=\'9\' ry=\'15\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <ellipse cx=\'16\' cy=\'14\' rx=\'5\' ry=\'3\' fill=\'white\' opacity=\'0.2\'/>\
                <ellipse cx=\'16\' cy=\'22\' rx=\'5\' ry=\'3\' fill=\'white\' opacity=\'0.15\'/>\
                <ellipse cx=\'16\' cy=\'29\' rx=\'4\' ry=\'2.5\' fill=\'white\' opacity=\'0.12\'/>\
                <rect x=\'13\' y=\'6\' width=\'6\' height=\'3\' rx=\'1.5\' fill=\'white\' opacity=\'0.4\'/>';
            break;
        case 'passenger':
            hull = '<path d=\'M16,2 L26,12 L26,28 L23,34 L9,34 L6,28 L6,12 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <rect x=\'8\' y=\'12\' width=\'16\' height=\'2\' rx=\'0.5\' fill=\'white\' opacity=\'0.35\'/>\
                <rect x=\'8\' y=\'15.5\' width=\'16\' height=\'2\' rx=\'0.5\' fill=\'white\' opacity=\'0.3\'/>\
                <rect x=\'8\' y=\'19\' width=\'16\' height=\'2\' rx=\'0.5\' fill=\'white\' opacity=\'0.25\'/>\
                <rect x=\'8\' y=\'22.5\' width=\'16\' height=\'2\' rx=\'0.5\' fill=\'white\' opacity=\'0.2\'/>\
                <rect x=\'11\' y=\'5\' width=\'10\' height=\'5\' rx=\'1.5\' fill=\'white\' opacity=\'0.35\'/>\
                <circle cx=\'16\' cy=\'29\' r=\'2\' fill=\'white\' opacity=\'0.15\'/>';
            break;
        case 'fishing':
            hull = '<path d=\'M16,6 L19,14 L19,28 L17,32 L15,32 L13,28 L13,14 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <line x1=\'16\' y1=\'6\' x2=\'16\' y2=\'16\' stroke=\'white\' stroke-width=\'1.2\' opacity=\'0.6\'/>\
                <line x1=\'16\' y1=\'10\' x2=\'5\' y2=\'18\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.9\'/>\
                <line x1=\'16\' y1=\'10\' x2=\'27\' y2=\'18\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.9\'/>\
                <line x1=\'5\' y1=\'18\' x2=\'5\' y2=\'24\' stroke=\'' + c + '\' stroke-width=\'1\' opacity=\'0.7\'/>\
                <line x1=\'27\' y1=\'18\' x2=\'27\' y2=\'24\' stroke=\'' + c + '\' stroke-width=\'1\' opacity=\'0.7\'/>\
                <circle cx=\'5\' cy=\'25\' r=\'1\' fill=\'' + c + '\' opacity=\'0.6\'/>\
                <circle cx=\'27\' cy=\'25\' r=\'1\' fill=\'' + c + '\' opacity=\'0.6\'/>';
            break;
        case 'military':
            hull = '<path d=\'M16,0 L20,10 L21,18 L20,30 L18,36 L14,36 L12,30 L11,18 L12,10 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <path d=\'M14,7 L18,7 L19,11 L13,11 Z\' fill=\'white\' opacity=\'0.3\'/>\
                <circle cx=\'16\' cy=\'15\' r=\'1.8\' fill=\'white\' opacity=\'0.3\'/>\
                <rect x=\'14\' y=\'20\' width=\'4\' height=\'1.5\' rx=\'0.5\' fill=\'white\' opacity=\'0.25\'/>\
                <line x1=\'16\' y1=\'0\' x2=\'16\' y2=\'6\' stroke=\'white\' stroke-width=\'0.8\' opacity=\'0.6\'/>';
            break;
        case 'tug':
            hull = '<path d=\'M16,12 L22,16 L22,28 L20,32 L12,32 L10,28 L10,16 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <rect x=\'12\' y=\'15\' width=\'8\' height=\'6\' rx=\'1.5\' fill=\'white\' opacity=\'0.4\'/>\
                <line x1=\'16\' y1=\'12\' x2=\'16\' y2=\'14\' stroke=\'white\' stroke-width=\'1\' opacity=\'0.5\'/>\
                <rect x=\'13\' y=\'24\' width=\'6\' height=\'4\' rx=\'0.8\' fill=\'white\' opacity=\'0.2\'/>';
            break;
        default:
            hull = '<path d=\'M16,4 L21,12 L21,28 L19,33 L13,33 L11,28 L11,12 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#g)\'/>\
                <rect x=\'13\' y=\'10\' width=\'6\' height=\'4\' rx=\'1\' fill=\'white\' opacity=\'0.35\'/>\
                <line x1=\'16\' y1=\'4\' x2=\'16\' y2=\'9\' stroke=\'white\' stroke-width=\'0.7\' opacity=\'0.5\'/>';
    }

    // 페이딩 방향 꼬리 (선미 뒤쪽 점들)
    var trail = '<circle cx=\'16\' cy=\'43\' r=\'3\' fill=\'' + c + '\' opacity=\'0.6\'/>\
        <circle cx=\'16\' cy=\'52\' r=\'2.6\' fill=\'' + c + '\' opacity=\'0.45\'/>\
        <circle cx=\'16\' cy=\'60\' r=\'2.2\' fill=\'' + c + '\' opacity=\'0.32\'/>\
        <circle cx=\'16\' cy=\'67\' r=\'1.8\' fill=\'' + c + '\' opacity=\'0.2\'/>\
        <circle cx=\'16\' cy=\'73\' r=\'1.4\' fill=\'' + c + '\' opacity=\'0.1\'/>';

    var svg = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 78\'>' + glow + hull + trail + '</svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _shipIconCache[key] = url;
    return url;
}
window.getShipIcon = getShipIcon;

// Aircraft icon SVG by type
var _aircraftIconCache = {};
function getAircraftIcon(colorHex, aircraftType) {
    var key = colorHex + '|' + (aircraftType || 'other');
    if (_aircraftIconCache[key]) return _aircraftIconCache[key];

    var c = colorHex;
    var s = '#000';
    var glow = '<defs>\
        <filter id=\'ag\' x=\'-50%\' y=\'-50%\' width=\'200%\' height=\'200%\'>\
            <feDropShadow dx=\'0\' dy=\'0\' stdDeviation=\'2\' flood-color=\'rgba(0,0,0,0.7)\'/>\
        </filter>\
    </defs>';

    var body;
    switch (aircraftType) {
        case 'civilian':
            body = '<path d=\'M16,2 L18,8 L30,18 L30,20 L18,16 L18,28 L22,32 L22,34 L16,32 L10,34 L10,32 L14,28 L14,16 L2,20 L2,18 L14,8 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#ag)\'/>';
            break;
        case 'military':
            body = '<path d=\'M16,1 L18,6 L28,16 L28,18 L18,14 L19,22 L18,28 L22,32 L22,34 L16,30 L10,34 L10,32 L14,28 L13,22 L14,14 L4,18 L4,16 L14,6 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#ag)\'/>\
                <line x1=\'16\' y1=\'1\' x2=\'16\' y2=\'34\' stroke=\'white\' stroke-width=\'0.8\' opacity=\'0.5\'/>';
            break;
        case 'helicopter':
            body = '<ellipse cx=\'16\' cy=\'18\' rx=\'5\' ry=\'8\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#ag)\'/>\
                <line x1=\'4\' y1=\'12\' x2=\'28\' y2=\'12\' stroke=\'' + c + '\' stroke-width=\'2\' stroke-linecap=\'round\'/>\
                <line x1=\'16\' y1=\'26\' x2=\'16\' y2=\'32\' stroke=\'' + c + '\' stroke-width=\'1.5\'/>\
                <line x1=\'12\' y1=\'32\' x2=\'20\' y2=\'32\' stroke=\'' + c + '\' stroke-width=\'1.5\' stroke-linecap=\'round\'/>';
            break;
        default:
            body = '<path d=\'M16,4 L18,10 L26,18 L26,19 L18,16 L18,26 L21,30 L21,31 L16,29 L11,31 L11,30 L14,26 L14,16 L6,19 L6,18 L14,10 Z\' fill=\'' + c + '\' stroke=\'' + s + '\' stroke-width=\'1.2\' filter=\'url(#ag)\'/>';
    }

    var svg = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 36\'>' + glow + body + '</svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _aircraftIconCache[key] = url;
    return url;
}
window.getAircraftIcon = getAircraftIcon;

// Ship type filter checkbox handlers
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

// Aircraft type filter checkbox handlers
var leafletAircraftLayerGroups = {};
var leafletAircraftMarkers = {};

AIRCRAFT_TYPES.forEach(function(type) {
    var checkbox = document.getElementById('filter-ac-' + type);
    if (checkbox) {
        checkbox.addEventListener('change', function() {
            if (aircraftBillboards[type]) aircraftBillboards[type].show = checkbox.checked;
            if (aircraftLabels[type]) aircraftLabels[type].show = checkbox.checked;
            if (currentMapMode === '2d' && leafletMap && leafletAircraftLayerGroups[type]) {
                if (checkbox.checked) {
                    leafletAircraftLayerGroups[type].addTo(leafletMap);
                } else {
                    leafletMap.removeLayer(leafletAircraftLayerGroups[type]);
                }
            }
        });
    }
});

// Weather Imagery Layers
var cloudLayer = null;
var weatherProvider = null;

function refreshRainviewer() {
    fetch('https://api.rainviewer.com/public/weather-maps.json')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            var pastFrames = data.radar.past;
            if (!pastFrames || pastFrames.length === 0) return;
            var latestPath = pastFrames[pastFrames.length - 1].path;
            var host = data.host || 'https://tilecache.rainviewer.com';
            var newProvider = new Cesium.UrlTemplateImageryProvider({
                url: host + latestPath + '/256/{z}/{x}/{y}/2/1_1.png',
                maximumLevel: 6
            });
            var _cl = document.getElementById('layer-clouds');
            var wasVisible = cloudLayer ? cloudLayer.show : (_cl ? _cl.checked : false);
            if (cloudLayer) viewer.imageryLayers.remove(cloudLayer, true);
            cloudLayer = viewer.imageryLayers.addImageryProvider(newProvider);
            cloudLayer.alpha = 0.6;
            cloudLayer.show = wasVisible;
            weatherProvider = newProvider;
        })
        .catch(function(err) { console.warn("Rainviewer refresh failed:", err); });
}
refreshRainviewer();
setInterval(refreshRainviewer, 10 * 60 * 1000);

var _cloudsCheckbox = document.getElementById('layer-clouds');
if (_cloudsCheckbox) {
    _cloudsCheckbox.addEventListener('change', function(e) {
        if (cloudLayer) {
            cloudLayer.show = e.target.checked;
            if (e.target.checked) viewer.imageryLayers.raiseToTop(cloudLayer);
        }
    });
}

function updateShipsLayer(ships) {
    var byType = {};
    SHIP_TYPES.forEach(function(t) { byType[t] = []; });

    ships.forEach(function(s) { shipDataMap[s.mmsi] = s; });

    var TYPE_MAP = { military_vessel: 'military', unknown: 'other', yacht: 'other' };

    ships.forEach(function(ship) {
        var raw = ship.type || 'other';
        var type = TYPE_MAP[raw] || raw;
        ship.type = type;
        if (byType[type]) byType[type].push(ship);
        else byType['other'].push(ship);
    });

    var west = -180, east = 180, south = -90, north = 90;

    if (timeMode === 'live') {
        if (currentMapMode === '2d' && leafletMap) {
            var bounds = leafletMap.getBounds();
            var buffer = 0.5;
            west = bounds.getWest() - buffer;
            east = bounds.getEast() + buffer;
            south = bounds.getSouth() - buffer;
            north = bounds.getNorth() + buffer;
        } else {
            var cameraRect = viewer.camera.computeViewRectangle();
            if (cameraRect) {
                var buffer = 0.5;
                west = Cesium.Math.toDegrees(cameraRect.west) - buffer;
                east = Cesium.Math.toDegrees(cameraRect.east) + buffer;
                south = Cesium.Math.toDegrees(cameraRect.south) - buffer;
                north = Cesium.Math.toDegrees(cameraRect.north) + buffer;
            }
        }
    }

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
                            disableDepthTestDistance: 5e6
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
            if (countEl) animateCount(countEl, typeShips.length.toLocaleString());
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
            seenMmsis.add(String(ship.mmsi));

            var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);
            var heading = Cesium.Math.toRadians(-(ship.heading || 0));
            var surfaceNormal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position);

            var existingBb = shipBillboardMap[String(ship.mmsi)];
            if (existingBb) {
                // 기존 billboard 업데이트 — 직접 세팅, Property 평가 없음
                existingBb.position = position;
                existingBb.rotation = heading;
                existingBb.alignedAxis = surfaceNormal;
                // 라벨도 업데이트
                var existingLabel = shipLabelMap[String(ship.mmsi)];
                if (existingLabel) {
                    existingLabel.position = position;
                    if (ship.name && existingLabel.text !== ship.name) {
                        existingLabel.text = ship.name;
                    }
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
                    alignedAxis: surfaceNormal,
                    scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                    disableDepthTestDistance: 5e6
                });
                bb._mmsi = ship.mmsi;
                bb._shipType = type;
                shipBillboardMap[String(ship.mmsi)] = bb;

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
                    disableDepthTestDistance: 5e6
                });
                lbl._mmsi = ship.mmsi;
                shipLabelMap[String(ship.mmsi)] = lbl;
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
        if (countEl) animateCount(countEl, typeShips.length.toLocaleString());
    });

    // 2D mode Leaflet marker update
    if (currentMapMode === '2d' && leafletMap) {
        var newMarkersByType = {};
        ships.forEach(function(ship) {
            var type = ship.type || 'other';
            var entry = leafletShipMarkers[ship.mmsi];

            if (entry) {
                entry.marker.setLatLng([ship.lat, ship.lng]);
            } else {
                var color = SHIP_COLORS[type] || '#6b7280';
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

                if (!leafletShipLayerGroups[type]) {
                    leafletShipLayerGroups[type] = L.layerGroup();
                    var cb = document.getElementById('filter-' + type);
                    if (!cb || cb.checked) {
                        leafletShipLayerGroups[type].addTo(leafletMap);
                    }
                }
                if (!newMarkersByType[type]) newMarkersByType[type] = [];
                newMarkersByType[type].push(marker);
                leafletShipMarkers[ship.mmsi] = { marker: marker, type: type };
            }
        });

        // 새 마커를 타입별로 배치 추가 — 맵에서 분리 후 추가하고 다시 붙임 (Canvas 재렌더 1회)
        Object.keys(newMarkersByType).forEach(function(type) {
            var group = leafletShipLayerGroups[type];
            if (group) {
                var wasOnMap = leafletMap.hasLayer(group);
                if (wasOnMap) leafletMap.removeLayer(group);
                var layers = newMarkersByType[type];
                for (var i = 0; i < layers.length; i++) {
                    group.addLayer(layers[i]);
                }
                if (wasOnMap) group.addTo(leafletMap);
            }
        });

        var currentMmsis = new Set(ships.map(function(s) { return String(s.mmsi); }));
        Object.keys(leafletShipMarkers).forEach(function(mmsi) {
            if (!currentMmsis.has(String(mmsi))) {
                var entry = leafletShipMarkers[mmsi];
                if (entry && leafletShipLayerGroups[entry.type]) {
                    leafletShipLayerGroups[entry.type].removeLayer(entry.marker);
                }
                delete leafletShipMarkers[mmsi];
            }
        });
    }
}

function showAircraftInfo(icao24) {
    var ac = aircraftDataMap[icao24] || aircraftDataMap[String(icao24)];
    if (!ac) return;
    var panel = document.getElementById('shipInfoPanel') || document.getElementById('ship-info');
    if (!panel) return;

    var type = ac.category || 'other';
    var color = (typeof AIRCRAFT_COLORS !== 'undefined' && AIRCRAFT_COLORS[type]) ? AIRCRAFT_COLORS[type] : '#60a5fa';
    var altM = ac.altitude != null ? ac.altitude : null;
    var altFt = altM != null ? Math.round(altM * 3.281) : null;
    var velMs = ac.velocity != null ? ac.velocity : null;
    var velKmh = velMs != null ? Math.round(velMs * 3.6) : null;
    var velKts = velMs != null ? Math.round(velMs * 1.944) : null;

    var html = '<div style="border-left: 4px solid ' + color + '; padding-left: 10px;">'
        + '<div style="font-size:13px; font-weight:700; color:' + color + '; margin-bottom:6px;">&#9992; ' + (ac.callsign || ac.icao24 || 'Unknown') + '</div>'
        + '<table style="width:100%; font-size:11px; border-collapse:collapse;">'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">ICAO24</td><td>' + (ac.icao24 || '-') + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Category</td><td>' + type + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Altitude</td><td>' + (altM != null ? altM + ' m / ' + altFt + ' ft' : '-') + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Speed</td><td>' + (velKmh != null ? velKmh + ' km/h / ' + velKts + ' kts' : '-') + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Heading</td><td>' + (ac.heading != null ? ac.heading + '°' : '-') + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Vertical Rate</td><td>' + (ac.vertical_rate != null ? ac.vertical_rate + ' m/s' : '-') + '</td></tr>'
        + '<tr><td style="color:#9ca3af; padding:2px 0;">Country</td><td>' + (ac.origin_country || '-') + '</td></tr>'
        + '</table>'
        + '</div>';

    panel.innerHTML = html;
    panel.style.display = 'block';
}
window.showAircraftInfo = showAircraftInfo;

function updateAircraftLayer(aircraft) {
    var byType = {};
    AIRCRAFT_TYPES.forEach(function(t) { byType[t] = []; });

    aircraft.forEach(function(ac) { aircraftDataMap[ac.icao24] = ac; });

    aircraft.forEach(function(ac) {
        var type = ac.category || 'other';
        if (byType[type]) byType[type].push(ac);
        else byType['other'].push(ac);
    });

    var west = -180, east = 180, south = -90, north = 90;

    if (currentMapMode === '2d' && leafletMap) {
        var bounds = leafletMap.getBounds();
        var buffer = 0.5;
        west = bounds.getWest() - buffer;
        east = bounds.getEast() + buffer;
        south = bounds.getSouth() - buffer;
        north = bounds.getNorth() + buffer;
    } else if (typeof viewer !== 'undefined') {
        var cameraRect = viewer.camera.computeViewRectangle();
        if (cameraRect) {
            var buffer = 0.5;
            west = Cesium.Math.toDegrees(cameraRect.west) - buffer;
            east = Cesium.Math.toDegrees(cameraRect.east) + buffer;
            south = Cesium.Math.toDegrees(cameraRect.south) - buffer;
            north = Cesium.Math.toDegrees(cameraRect.north) + buffer;
        }
    }

    var MAX_AC_PER_TYPE = 400;

    // Cesium 3D mode
    if (currentMapMode !== '2d' && typeof viewer !== 'undefined') {
        AIRCRAFT_TYPES.forEach(function(type) {
            var billboards = aircraftBillboards[type];
            var labels = aircraftLabels[type];
            if (!billboards || !labels) return;

            var typeAircraft = byType[type];
            var seenIcao24s = new Set();
            var typeRenderedCount = 0;

            typeAircraft.forEach(function(ac) {
                if (typeRenderedCount >= MAX_AC_PER_TYPE) return;
                if (ac.lng < west || ac.lng > east || ac.lat < south || ac.lat > north) return;

                typeRenderedCount++;
                seenIcao24s.add(String(ac.icao24));

                var alt = ac.altitude != null ? ac.altitude : 0;
                var position = Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat, alt);

                var acHeading = Cesium.Math.toRadians(-(ac.heading || 0));
                var acSurfaceNormal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
                    Cesium.Cartesian3.fromDegrees(ac.lng, ac.lat)
                );

                var existingBb = aircraftBillboardMap[String(ac.icao24)];
                if (existingBb) {
                    existingBb.position = position;
                    existingBb.rotation = acHeading;
                    existingBb.alignedAxis = acSurfaceNormal;
                    var existingLabel = aircraftLabelMap[String(ac.icao24)];
                    if (existingLabel) {
                        existingLabel.position = position;
                        if (ac.callsign && existingLabel.text !== ac.callsign) {
                            existingLabel.text = ac.callsign;
                        }
                    }
                } else {
                    var bb = billboards.add({
                        position: position,
                        image: getAircraftIcon(AIRCRAFT_COLORS[type] || '#60a5fa', type),
                        width: 24,
                        height: 28,
                        rotation: acHeading,
                        alignedAxis: acSurfaceNormal,
                        scaleByDistance: new Cesium.NearFarScalar(5e5, 1.8, 1.5e7, 0.7),
                        disableDepthTestDistance: 5e6
                    });
                    bb._icao24 = ac.icao24;
                    bb._isAircraft = true;
                    bb._acType = type;
                    aircraftBillboardMap[String(ac.icao24)] = bb;

                    var lbl = labels.add({
                        position: position,
                        text: ac.callsign || '',
                        font: '10px Inter, sans-serif',
                        fillColor: Cesium.Color.fromCssColorString(AIRCRAFT_COLORS[type] || '#60a5fa'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 3,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -18),
                        scaleByDistance: new Cesium.NearFarScalar(5e5, 1.0, 5e6, 0.4),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2e6),
                        disableDepthTestDistance: 5e6
                    });
                    lbl._icao24 = ac.icao24;
                    aircraftLabelMap[String(ac.icao24)] = lbl;
                }
            });

            // Remove stale aircraft
            var toRemoveIcao24s = [];
            for (var icao24 in aircraftBillboardMap) {
                var bb = aircraftBillboardMap[icao24];
                if (bb._acType === type && !seenIcao24s.has(icao24)) {
                    toRemoveIcao24s.push(icao24);
                }
            }
            toRemoveIcao24s.forEach(function(icao24) {
                billboards.remove(aircraftBillboardMap[icao24]);
                labels.remove(aircraftLabelMap[icao24]);
                delete aircraftBillboardMap[icao24];
                delete aircraftLabelMap[icao24];
            });

            var countEl = document.getElementById('count-ac-' + type);
            if (countEl) animateCount(countEl, typeAircraft.length.toLocaleString());
        });
    }

    // Leaflet 2D mode
    if (currentMapMode === '2d' && leafletMap) {
        var newAcMarkersByType = {};
        aircraft.forEach(function(ac) {
            var type = ac.category || 'other';
            var entry = leafletAircraftMarkers[ac.icao24];

            if (entry) {
                entry.marker.setLatLng([ac.lat, ac.lng]);
            } else {
                var color = (typeof AIRCRAFT_COLORS !== 'undefined' && AIRCRAFT_COLORS[type]) ? AIRCRAFT_COLORS[type] : '#60a5fa';
                var marker = L.circleMarker([ac.lat, ac.lng], {
                    radius: 5,
                    fillColor: color,
                    fillOpacity: 0.9,
                    color: color,
                    weight: 1,
                    opacity: 0.7
                });

                marker.bindTooltip(ac.callsign || ac.icao24 || 'Unknown', {
                    className: 'ship-tooltip-2d',
                    direction: 'top',
                    offset: [0, -5]
                });

                marker.on('click', function() {
                    showAircraftInfo(ac.icao24);
                });

                if (!leafletAircraftLayerGroups[type]) {
                    leafletAircraftLayerGroups[type] = L.layerGroup();
                    var cb = document.getElementById('filter-ac-' + type);
                    if (!cb || cb.checked) {
                        leafletAircraftLayerGroups[type].addTo(leafletMap);
                    }
                }
                if (!newAcMarkersByType[type]) newAcMarkersByType[type] = [];
                newAcMarkersByType[type].push(marker);
                leafletAircraftMarkers[ac.icao24] = { marker: marker, type: type };
            }
        });

        Object.keys(newAcMarkersByType).forEach(function(type) {
            var group = leafletAircraftLayerGroups[type];
            if (group) {
                var wasOnMap = leafletMap.hasLayer(group);
                if (wasOnMap) leafletMap.removeLayer(group);
                var layers = newAcMarkersByType[type];
                for (var i = 0; i < layers.length; i++) {
                    group.addLayer(layers[i]);
                }
                if (wasOnMap) group.addTo(leafletMap);
            }
        });

        var currentIcao24s = new Set(aircraft.map(function(ac) { return String(ac.icao24); }));
        Object.keys(leafletAircraftMarkers).forEach(function(icao24) {
            if (!currentIcao24s.has(String(icao24))) {
                var entry = leafletAircraftMarkers[icao24];
                if (entry && leafletAircraftLayerGroups[entry.type]) {
                    leafletAircraftLayerGroups[entry.type].removeLayer(entry.marker);
                }
                delete leafletAircraftMarkers[icao24];
            }
        });

        AIRCRAFT_TYPES.forEach(function(type) {
            var countEl = document.getElementById('count-ac-' + type);
            if (countEl) animateCount(countEl, (byType[type] || []).length.toLocaleString());
        });
    }
}
window.updateAircraftLayer = updateAircraftLayer;

var ws;
function initWebSocket() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/api/v1/ws/ships';

    console.log("Connecting to WebSocket:", wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        console.log("WebSocket connected!");
        if (typeof setWsStatus === 'function') setWsStatus('connected');
        var loadingText = document.getElementById('loading-text');
        if (loadingText) loadingText.textContent = 'AIS 데이터 수신 대기...';
    };

    ws.onmessage = function(event) {
        if (timeMode !== 'live') return;

        try {
            var data = JSON.parse(event.data);
            if (data.type === "ships_update") {
                // Measure latency from server timestamp
                if (data.server_time_ms) {
                    var latency = Date.now() - data.server_time_ms;
                    if (latency >= 0 && latency < 10000) {
                        if (typeof BottomBar !== 'undefined') {
                            BottomBar.updateValue('headerLatency', latency);
                        }
                    }
                }
                var loadingEl = document.getElementById('loading');
                var loadingTextEl = document.getElementById('loading-text');
                var isFirstLoad2d = Object.keys(leafletShipMarkers).length === 0 && currentMapMode === '2d';

                _lastShipsData = data.ships || [];

                if (isFirstLoad2d && loadingEl && loadingTextEl) {
                    // 2D 첫 렌더링: 로딩 표시 → 화면 갱신 → 렌더링 → 로딩 숨김
                    loadingTextEl.textContent = '선박 데이터 렌더링 중...';
                    loadingEl.style.display = 'flex';
                    requestAnimationFrame(function() {
                        setTimeout(function() {
                            updateShipsLayer(_lastShipsData);
                            if (loadingEl) loadingEl.style.display = 'none';
                        }, 0);
                    });
                } else {
                    // 일반 업데이트
                    if (loadingEl && loadingEl.style.display !== 'none') {
                        loadingEl.style.display = 'none';
                    }
                    updateShipsLayer(_lastShipsData);
                }

                // Update ship type distribution chart
                if (typeof updateShipTypeChart === 'function') updateShipTypeChart(data.ships || []);

                latestWsShipsMmsis = new Set((data.ships || []).map(function(s) { return s.mmsi; }));

                if (selectedProximityMmsi) {
                    var now = Date.now();
                    if (now - lastProximityUpdate >= PROXIMITY_THROTTLE_MS) {
                        lastProximityUpdate = now;
                        updateProximity();
                    }
                }


                var totalShipsEl = document.getElementById('total-ships');
                var totalCount = _lastShipsData.length;
                animateCount(totalShipsEl, totalCount.toLocaleString());

                // Bottom bar vessel count + type distribution
                if (typeof BottomBar !== 'undefined') {
                    // FLAG country distribution
                    BottomBar.updateFlagDistribution(_lastShipsData);
                    BottomBar._storeVessels(_lastShipsData);

                }

                if (data.timestamp) {
                    var updated = new Date(data.timestamp);
                    var kst = new Date(updated.getTime() + 9 * 60 * 60 * 1000);
                    document.getElementById('last-update').textContent = kst.toISOString().substring(11, 19);
                }

                // Update header latency indicator
                _lastWsReceived = Date.now();
            }
            else if (data.type === "aircraft_update") {
                updateAircraftLayer(data.aircraft || []);
                var totalAcEl = document.getElementById('total-aircraft');
                if (totalAcEl) animateCount(totalAcEl, (data.aircraft || []).length.toLocaleString());
                var chipAc = document.getElementById('chipAircraftCount');
                if (chipAc) chipAc.textContent = (data.aircraft || []).length.toLocaleString();
                if (typeof BottomBar !== 'undefined' && BottomBar.updateAircraftTypes) {
                    BottomBar.updateAircraftTypes(data.aircraft || []);
                }
            }
        } catch (error) {
            console.error("Error parsing WebSocket message:", error);
        }
    };

    ws.onerror = function(error) {
        console.error("WebSocket error:", error);
        if (typeof setWsStatus === 'function') setWsStatus('disconnected');
    };

    ws.onclose = function() {
        console.log("WebSocket closed. Reconnecting in 2 seconds...");
        if (typeof setWsStatus === 'function') setWsStatus('connecting');
        var loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.style.display = '';
            var loadingText = document.getElementById('loading-text');
            if (loadingText) loadingText.textContent = '재연결 중...';
        }
        if (currentMapMode === '2d' && leafletMap) {
            Object.values(leafletShipMarkers).forEach(function(m) { m.setStyle({ opacity: 0.3, fillOpacity: 0.3 }); });
        }
        setTimeout(initWebSocket, 2000);
    };
}
window.initWebSocket = initWebSocket;

// ── WS connection status LED ──
var _lastWsReceived = 0;

setInterval(function() {
    var ago = _lastWsReceived ? Math.round((Date.now() - _lastWsReceived) / 1000) : 999;
    var led = document.getElementById('headerWsLed');
    if (led) {
        led.className = 'ws-led ' + (ago <= 5 ? 'connected' : ago <= 15 ? 'connecting' : 'disconnected');
    }
}, 1000);

// ── Ship Highlight (targeting reticle on navigation) ──
var _highlightEntity = null;
var _highlightTimer = null;
var _highlightStartTime = null;
var _highlightMmsi = null;
var _highlightUpdateInterval = null;

// Generate square bracket targeting reticle SVG
var _reticleImageCache = null;
function _getReticleImage() {
    if (_reticleImageCache) return _reticleImageCache;
    var size = 64;
    var corner = 16;
    var pad = 4;
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var ctx = c.getContext('2d');
    ctx.strokeStyle = '#406FD8';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#406FD8';
    ctx.shadowBlur = 6;

    // Top-left corner
    ctx.beginPath();
    ctx.moveTo(pad, pad + corner);
    ctx.lineTo(pad, pad);
    ctx.lineTo(pad + corner, pad);
    ctx.stroke();

    // Top-right corner
    ctx.beginPath();
    ctx.moveTo(size - pad - corner, pad);
    ctx.lineTo(size - pad, pad);
    ctx.lineTo(size - pad, pad + corner);
    ctx.stroke();

    // Bottom-right corner
    ctx.beginPath();
    ctx.moveTo(size - pad, size - pad - corner);
    ctx.lineTo(size - pad, size - pad);
    ctx.lineTo(size - pad - corner, size - pad);
    ctx.stroke();

    // Bottom-left corner
    ctx.beginPath();
    ctx.moveTo(pad + corner, size - pad);
    ctx.lineTo(pad, size - pad);
    ctx.lineTo(pad, size - pad - corner);
    ctx.stroke();

    _reticleImageCache = c.toDataURL();
    return _reticleImageCache;
}

function highlightShip(mmsi) {
    clearShipHighlight();

    var ship = shipDataMap[mmsi] || shipDataMap[String(mmsi)];
    if (!ship || !ship.lat || !ship.lng) return;

    _highlightStartTime = Date.now();
    _highlightMmsi = mmsi;

    var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);

    _highlightEntity = viewer.entities.add({
        position: position,
        billboard: {
            image: _getReticleImage(),
            width: 52,
            height: 52,
            color: new Cesium.CallbackProperty(function() {
                var elapsed = (Date.now() - _highlightStartTime) / 1000;
                var alpha = 0.6 + 0.4 * Math.sin(elapsed * 4);
                return Cesium.Color.WHITE.withAlpha(alpha);
            }, false),
            pixelOffset: new Cesium.Cartesian2(0, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(1e3, 1.2, 5e6, 0.8)
        }
    });

    // Follow ship position updates
    _highlightUpdateInterval = setInterval(function() {
        if (!_highlightEntity || !_highlightMmsi) return;
        var s = shipDataMap[_highlightMmsi] || shipDataMap[String(_highlightMmsi)];
        if (s && s.lat && s.lng) {
            _highlightEntity.position = Cesium.Cartesian3.fromDegrees(s.lng, s.lat);
        }
    }, 1000);
}
window.highlightShip = highlightShip;

function clearShipHighlight() {
    if (_highlightEntity) {
        viewer.entities.remove(_highlightEntity);
        _highlightEntity = null;
    }
    if (_highlightTimer) {
        clearTimeout(_highlightTimer);
        _highlightTimer = null;
    }
    if (_highlightUpdateInterval) {
        clearInterval(_highlightUpdateInterval);
        _highlightUpdateInterval = null;
    }
    _highlightStartTime = null;
    _highlightMmsi = null;
}
window.clearShipHighlight = clearShipHighlight;
