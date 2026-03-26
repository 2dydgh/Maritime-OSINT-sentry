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

    var svg = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 38\'>' + glow + hull + '</svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _shipIconCache[key] = url;
    return url;
}
window.getShipIcon = getShipIcon;

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
            var wasVisible = cloudLayer ? cloudLayer.show : document.getElementById('layer-clouds').checked;
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

document.getElementById('layer-clouds').addEventListener('change', function(e) {
    if (cloudLayer) {
        cloudLayer.show = e.target.checked;
        if (e.target.checked) viewer.imageryLayers.raiseToTop(cloudLayer);
    }
});

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
            seenMmsis.add(String(ship.mmsi));

            var position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);
            var heading = Cesium.Math.toRadians(-(ship.heading || 0));

            var existingBb = shipBillboardMap[String(ship.mmsi)];
            if (existingBb) {
                // 기존 billboard 업데이트 — 직접 세팅, Property 평가 없음
                existingBb.position = position;
                existingBb.rotation = heading;
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
                    scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
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
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
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
        if (countEl) countEl.textContent = typeShips.length.toLocaleString();
    });

    // 2D mode Leaflet marker update
    if (currentMapMode === '2d' && leafletMap) {
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
                leafletShipLayerGroups[type].addLayer(marker);
                leafletShipMarkers[ship.mmsi] = { marker: marker, type: type };
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

var ws;
function initWebSocket() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/api/v1/ws/ships';

    console.log("Connecting to WebSocket:", wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        console.log("WebSocket connected!");
        var loadingEl = document.getElementById('loading');
        if (loadingEl && loadingEl.innerHTML.includes('\uCD08\uAE30\uD654')) {
            loadingEl.style.display = 'none';
        }
    };

    ws.onmessage = function(event) {
        if (timeMode !== 'live') return;

        try {
            var data = JSON.parse(event.data);
            if (data.type === "ships_update") {
                updateShipsLayer(data.ships || []);

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

                document.getElementById('total-ships').textContent = (data.total_tracked || data.ship_count || 0).toLocaleString();

                if (data.timestamp) {
                    var updated = new Date(data.timestamp);
                    document.getElementById('last-update').textContent = updated.toISOString().substring(11, 19);
                }

                // Update header latency indicator
                _lastWsReceived = Date.now();
            }
        } catch (error) {
            console.error("Error parsing WebSocket message:", error);
        }
    };

    ws.onerror = function(error) {
        console.error("WebSocket error:", error);
    };

    ws.onclose = function() {
        console.log("WebSocket closed. Reconnecting in 5 seconds...");
        if (currentMapMode === '2d' && leafletMap) {
            Object.values(leafletShipMarkers).forEach(function(m) { m.setStyle({ opacity: 0.3, fillOpacity: 0.3 }); });
        }
        setTimeout(initWebSocket, 5000);
    };
}
window.initWebSocket = initWebSocket;

// ── Header latency indicator ──
var _lastWsReceived = 0;

setInterval(function() {
    var el = document.getElementById('stat-latency');
    if (!el) return;

    if (_lastWsReceived === 0) {
        el.textContent = '--';
        el.className = '';
        return;
    }

    var ago = Math.round((Date.now() - _lastWsReceived) / 1000);
    if (ago < 60) {
        el.textContent = ago + 's';
        el.className = ago <= 5 ? 'fresh' : ago <= 15 ? '' : 'stale';
    } else {
        el.textContent = Math.floor(ago / 60) + 'm';
        el.className = 'dead';
    }
}, 1000);
