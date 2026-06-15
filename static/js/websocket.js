// ── Maritime OSINT Sentry — WebSocket & Ship Updates ──

// Ship size based on actual vessel length (AIS dimension data)
function getShipSize(lengthM, beamM) {
    var len = lengthM || 70;
    var bm = beamM || 12;
    var h = Math.max(11, Math.min(34, 11 + (len / 400) * 23));
    // AIS dimension reports are often garbage (beam ≥ length, tiny length).
    // Real-world beam/length stays under ~0.32 — clamp so icons stay sleek
    // (long & narrow, like a real vessel) and never become horizontal bars.
    var ratio = Math.max(0.08, Math.min(0.32, bm / len));
    var w = h * ratio * 2.2;
    return { width: Math.max(7, Math.round(w)), height: Math.round(h) };
}
window.getShipSize = getShipSize;

// Ship icon SVG by type.
// Top-down silhouettes — pointed/raked bow up, parallel sides, transom stern,
// rotated to heading by the caller. For a "2.5D" look each hull is filled with a
// cross-beam gradient (dark edges → light centre = rounded-hull volume) plus a
// soft drop shadow, and proportions are long & narrow like a real vessel.
// Deck superstructure is drawn on top (outside the shadowed group).

// Mix a hex colour toward white (pct>0) or black (pct<0) by |pct| (0..1).
function _shipShade(hex, pct) {
    var n = parseInt((hex || '').slice(1), 16);
    if (isNaN(n)) return hex;
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var t = pct < 0 ? 0 : 255, p = Math.abs(pct);
    r = Math.round((t - r) * p + r);
    g = Math.round((t - g) * p + g);
    b = Math.round((t - b) * p + b);
    return '#' + (0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

var _shipIconCache = {};
function getShipIcon(colorHex, shipType) {
    var key = colorHex + '|' + (shipType || 'other');
    if (_shipIconCache[key]) return _shipIconCache[key];

    var c = colorHex;
    var gid = c.slice(1) + (shipType || 'other');
    // Keep the vivid base colour at the centre; only the edges darken for volume.
    // (Lightening the centre toward white desaturates and looks washed-out.)
    var sheen = _shipShade(c, 0.15);  // subtle deck highlight ridge
    var dark = _shipShade(c, -0.24);  // gently shaded sides
    var edge = _shipShade(c, -0.5);   // crisp outline

    var d, deck;
    switch (shipType) {
        case 'cargo':
            // Boxy bulk/container carrier: cargo hatches forward, deckhouse + funnel aft.
            d = 'M16,2 C18.6,3.2 20.5,7 20.5,12 L20.5,38 L18.8,42 L13.2,42 L11.5,38 L11.5,12 C11.5,7 13.4,3.2 16,2 Z';
            deck = '<rect x="12.6" y="13" width="6.8" height="3" rx="0.4" fill="#fff" opacity="0.3"/>'
                + '<rect x="12.6" y="17.5" width="6.8" height="3" rx="0.4" fill="#fff" opacity="0.26"/>'
                + '<rect x="12.6" y="22" width="6.8" height="3" rx="0.4" fill="#fff" opacity="0.22"/>'
                + '<rect x="12.6" y="26.5" width="6.8" height="3" rx="0.4" fill="#fff" opacity="0.2"/>'
                + '<rect x="12.4" y="33" width="7.2" height="5" rx="0.6" fill="#fff" opacity="0.5"/>'
                + '<rect x="14.8" y="34.5" width="2.4" height="2" rx="0.3" fill="#fff" opacity="0.35"/>';
            break;
        case 'tanker':
            // Full hull, rounded bow; centreline pipeline + tank domes, bridge aft.
            d = 'M16,2.5 C18.8,3.6 20.5,7.5 20.5,13 L20.5,38 L18.8,42 L13.2,42 L11.5,38 L11.5,13 C11.5,7.5 13.2,3.6 16,2.5 Z';
            deck = '<line x1="16" y1="13" x2="16" y2="32" stroke="#fff" stroke-width="1" opacity="0.3"/>'
                + '<circle cx="16" cy="15" r="1.7" fill="#fff" opacity="0.24"/>'
                + '<circle cx="16" cy="20" r="1.7" fill="#fff" opacity="0.21"/>'
                + '<circle cx="16" cy="25" r="1.7" fill="#fff" opacity="0.18"/>'
                + '<circle cx="16" cy="30" r="1.5" fill="#fff" opacity="0.16"/>'
                + '<rect x="12.4" y="33.5" width="7.2" height="5" rx="0.6" fill="#fff" opacity="0.5"/>';
            break;
        case 'passenger':
            // Cruise/ferry: wide hull, long superstructure + promenade lines, lifeboats.
            d = 'M16,2 C19,3.2 21.5,8 21.5,14 L21.5,37 L19.8,42 L12.2,42 L10.5,37 L10.5,14 C10.5,8 13,3.2 16,2 Z';
            deck = '<rect x="11.6" y="10" width="8.8" height="26" rx="1.5" fill="#fff" opacity="0.42"/>'
                + '<line x1="12.4" y1="15" x2="19.6" y2="15" stroke="' + c + '" stroke-width="0.6" opacity="0.45"/>'
                + '<line x1="12.4" y1="20" x2="19.6" y2="20" stroke="' + c + '" stroke-width="0.6" opacity="0.45"/>'
                + '<line x1="12.4" y1="25" x2="19.6" y2="25" stroke="' + c + '" stroke-width="0.6" opacity="0.45"/>'
                + '<line x1="12.4" y1="30" x2="19.6" y2="30" stroke="' + c + '" stroke-width="0.6" opacity="0.45"/>'
                + '<circle cx="11" cy="16" r="0.9" fill="#fff" opacity="0.5"/><circle cx="21" cy="16" r="0.9" fill="#fff" opacity="0.5"/>'
                + '<circle cx="11" cy="23" r="0.9" fill="#fff" opacity="0.5"/><circle cx="21" cy="23" r="0.9" fill="#fff" opacity="0.5"/>'
                + '<circle cx="11" cy="30" r="0.9" fill="#fff" opacity="0.5"/><circle cx="21" cy="30" r="0.9" fill="#fff" opacity="0.5"/>';
            break;
        case 'fishing':
            // Small trawler: wheelhouse forward, outrigger booms amidships, reel aft.
            d = 'M16,8 C17.5,8.8 18.8,10.8 18.8,14 L18.8,33 L17.4,36.5 L14.6,36.5 L13.2,33 L13.2,14 C13.2,10.8 14.5,8.8 16,8 Z';
            deck = '<rect x="13.9" y="12" width="4.2" height="4" rx="0.6" fill="#fff" opacity="0.46"/>'
                + '<line x1="16" y1="20" x2="5" y2="27" stroke="' + c + '" stroke-width="1.3" opacity="0.85"/>'
                + '<line x1="16" y1="20" x2="27" y2="27" stroke="' + c + '" stroke-width="1.3" opacity="0.85"/>'
                + '<circle cx="5" cy="27" r="1" fill="' + c + '" opacity="0.7"/>'
                + '<circle cx="27" cy="27" r="1" fill="' + c + '" opacity="0.7"/>'
                + '<rect x="14.3" y="30" width="3.4" height="2.4" rx="0.4" fill="#fff" opacity="0.3"/>';
            break;
        case 'military':
            // Warship: slim, sharp bow; forward gun, midship bridge + mast, helideck aft.
            d = 'M16,1 C16.8,3 17.8,7 17.8,13 L17.8,38 L16.9,42 L15.1,42 L14.2,38 L14.2,13 C14.2,7 15.2,3 16,1 Z';
            deck = '<rect x="14.7" y="9.5" width="2.6" height="3" rx="0.3" fill="#fff" opacity="0.42"/>'
                + '<rect x="14.3" y="15" width="3.4" height="7" rx="0.4" fill="#fff" opacity="0.38"/>'
                + '<line x1="16" y1="18" x2="16" y2="13.5" stroke="#fff" stroke-width="0.8" opacity="0.6"/>'
                + '<rect x="14.4" y="32" width="3.2" height="5" rx="0.3" fill="none" stroke="#fff" stroke-width="0.5" opacity="0.45"/>';
            break;
        case 'tug':
            // Tug: short, beamy hull; large wheelhouse forward, aft towing deck + post.
            d = 'M16,11 C18,11.8 20,14.5 20,18.5 L20,36 L18.4,40 L13.6,40 L12,36 L12,18.5 C12,14.5 14,11.8 16,11 Z';
            deck = '<rect x="12.8" y="16" width="6.4" height="6" rx="1" fill="#fff" opacity="0.46"/>'
                + '<rect x="13.2" y="26" width="5.6" height="4" rx="0.6" fill="#fff" opacity="0.2"/>'
                + '<circle cx="16" cy="28" r="1.1" fill="#fff" opacity="0.42"/>';
            break;
        default:
            // Generic vessel: medium hull, deckhouse aft, short bow mast.
            d = 'M16,3 C18,4 19.8,7.5 19.8,12 L19.8,38 L18.2,42 L13.8,42 L12.2,38 L12.2,12 C12.2,7.5 14,4 16,3 Z';
            deck = '<rect x="13" y="13" width="6" height="9" rx="0.6" fill="#fff" opacity="0.22"/>'
                + '<rect x="13" y="33" width="6" height="5" rx="0.6" fill="#fff" opacity="0.42"/>'
                + '<line x1="16" y1="3" x2="16" y2="8" stroke="#fff" stroke-width="0.7" opacity="0.5"/>';
    }

    // Cross-beam gradient (volume) + soft drop shadow. IDs are per colour+type so
    // cached icons don't collide. Filter ref uses a literal '#' (single-encoded
    // by encodeURIComponent below) so it resolves once the browser decodes.
    var defs = '<defs>'
        + '<linearGradient id="hg-' + gid + '" x1="0" y1="0" x2="1" y2="0">'
        +   '<stop offset="0" stop-color="' + dark + '"/>'
        +   '<stop offset="0.42" stop-color="' + c + '"/>'
        +   '<stop offset="0.5" stop-color="' + sheen + '"/>'
        +   '<stop offset="0.58" stop-color="' + c + '"/>'
        +   '<stop offset="1" stop-color="' + dark + '"/>'
        + '</linearGradient>'
        + '<filter id="sh-' + gid + '" x="-60%" y="-30%" width="220%" height="160%">'
        +   '<feDropShadow dx="0" dy="0.5" stdDeviation="0.8" flood-color="#000" flood-opacity="0.45"/>'
        + '</filter>'
        + '</defs>';

    // Fading wake astern (stern is toward +y, behind the hull).
    var trail = '<circle cx="16" cy="47" r="3" fill="' + c + '" opacity="0.55"/>'
        + '<circle cx="16" cy="56" r="2.6" fill="' + c + '" opacity="0.42"/>'
        + '<circle cx="16" cy="64" r="2.2" fill="' + c + '" opacity="0.3"/>'
        + '<circle cx="16" cy="71" r="1.8" fill="' + c + '" opacity="0.2"/>'
        + '<circle cx="16" cy="77" r="1.4" fill="' + c + '" opacity="0.12"/>'
        + '<circle cx="16" cy="82" r="1.1" fill="' + c + '" opacity="0.07"/>';

    var hull = '<g filter="url(#sh-' + gid + ')">'
        + '<path d="' + d + '" fill="url(#hg-' + gid + ')" stroke="' + edge + '" stroke-width="0.5" stroke-linejoin="round"/>'
        + '</g>';

    // viewBox is cropped to "4 0 24 88" (centred on x=16) instead of the full
    // 0..32 so the hull fills far more of the icon — bigger and crisper on the
    // 3D globe — while staying symmetric for heading rotation. Fishing booms
    // (x5..27) still fit inside the 4..28 window.
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="88" viewBox="4 0 24 88">'
        + defs + trail + hull + deck + '</svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _shipIconCache[key] = url;
    return url;
}
window.getShipIcon = getShipIcon;

// ── 3D ship marker: AIS-style arrowhead + fading wake tail ──
// Matches the 2D arrow but keeps the wake behind it. Uniform size (no per-vessel
// scaling) so it stays crisp and consistent at any zoom; coloured by type and
// rotated to heading by the caller. Vessel position ≈ icon centre (arrow base).
var SHIP_ARROW_W = 11, SHIP_ARROW_H = 22;
var _shipArrowCache = {};
function getShipArrowIcon(colorHex) {
    if (_shipArrowCache[colorHex]) return _shipArrowCache[colorHex];
    var c = colorHex;
    var gid = c.slice(1);
    var dark = _shipShade(c, -0.28);  // shaded edges (volume)
    var edge = _shipShade(c, -0.55);  // outline (테두리)
    // Cross-beam gradient + drop shadow give the flat arrow a bit of depth.
    var defs = '<defs>'
        + '<linearGradient id="ag-' + gid + '" x1="0" y1="0" x2="1" y2="0">'
        +   '<stop offset="0" stop-color="' + dark + '"/>'
        +   '<stop offset="0.5" stop-color="' + c + '"/>'
        +   '<stop offset="1" stop-color="' + dark + '"/>'
        + '</linearGradient>'
        + '<filter id="af-' + gid + '" x="-60%" y="-60%" width="220%" height="220%">'
        +   '<feDropShadow dx="0" dy="0.6" stdDeviation="0.7" flood-color="#000" flood-opacity="0.5"/>'
        + '</filter>'
        + '</defs>';
    var trail = '<circle cx="12" cy="28" r="2.4" fill="' + c + '" opacity="0.5"/>'
        + '<circle cx="12" cy="34" r="2" fill="' + c + '" opacity="0.34"/>'
        + '<circle cx="12" cy="39" r="1.6" fill="' + c + '" opacity="0.22"/>'
        + '<circle cx="12" cy="43" r="1.3" fill="' + c + '" opacity="0.12"/>'
        + '<circle cx="12" cy="46" r="1" fill="' + c + '" opacity="0.07"/>';
    var arrow = '<path d="M12,2 L20,22 L12,17 L4,22 Z" fill="url(#ag-' + gid + ')" stroke="' + edge + '" stroke-width="1.3" stroke-linejoin="round" filter="url(#af-' + gid + ')"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="48" viewBox="0 0 24 48">'
        + defs + trail + arrow + '</svg>';
    var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _shipArrowCache[colorHex] = url;
    return url;
}
window.getShipArrowIcon = getShipArrowIcon;

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

    var svg = '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'36\' viewBox=\'0 0 32 36\'>' + glow + body + '</svg>';
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
            var tileUrl = host + latestPath + '/256/{z}/{x}/{y}/2/1_1.png';
            var newProvider = new Cesium.UrlTemplateImageryProvider({
                url: tileUrl,
                maximumLevel: 6
            });
            // 강수 레이더 가시성은 기상 칩 / wx-precipitation 토글이 관리 (기본 OFF)
            var wasVisible = cloudLayer ? cloudLayer.show : false;
            if (cloudLayer) viewer.imageryLayers.remove(cloudLayer, true);
            cloudLayer = viewer.imageryLayers.addImageryProvider(newProvider);
            cloudLayer.alpha = 0.6;
            cloudLayer.show = wasVisible;
            weatherProvider = newProvider;
            // 2D(Leaflet)용 강수 타일 URL 노출 + 표시 중이면 갱신
            window._rainviewerTileUrl = tileUrl;
            if (typeof renderPrecipitation === 'function') renderPrecipitation();
        })
        .catch(function(err) { console.warn("Rainviewer refresh failed:", err); });
}
refreshRainviewer();
setInterval(refreshRainviewer, 10 * 60 * 1000);

// 강수 레이더(cloudLayer) 토글은 weather-overlay.js의 #wx-precipitation 핸들러와
// ui-controls.js의 기상 칩 핸들러에서 관리한다. (옛 #layer-clouds 체크박스는 제거됨)

function updateShipsLayer(ships) {
    var byType = {};
    SHIP_TYPES.forEach(function(t) { byType[t] = []; });

    ships.forEach(function(ship) {
        var type = ship.type || 'other';
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
                    var hNormal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position);
                    ds.entities.add({
                        id: ship.mmsi,
                        name: ship.name,
                        position: position,
                        billboard: {
                            image: getShipArrowIcon(SHIP_COLORS[type] || '#6b7280'),
                            width: SHIP_ARROW_W,
                            height: SHIP_ARROW_H,
                            rotation: Cesium.Math.toRadians(-(ship.heading || 0)),
                            alignedAxis: hNormal,
                            scaleByDistance: new Cesium.NearFarScalar(5e5, 1.9, 1.5e7, 0.9),
                            disableDepthTestDistance: 5e6
                        }
                    });
                } else {
                    entity.position = position;
                    entity.billboard.rotation = Cesium.Math.toRadians(-(ship.heading || 0));
                }
            });

            ds.entities.values.forEach(function(entity) {
                if (!existingIds.has(entity.id)) {
                    ds.entities.remove(entity);
                }
            });
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

            var mmsiKey = String(ship.mmsi);
            var existingBb = shipBillboardMap[mmsiKey];
            if (existingBb) {
                // Skip update if position hasn't changed
                var prev = existingBb._prevPos;
                if (prev && prev[0] === ship.lng && prev[1] === ship.lat && prev[2] === (ship.heading || 0)) {
                    // No change — skip expensive Cartesian3/surfaceNormal recalc
                } else {
                    existingBb._prevPos = [ship.lng, ship.lat, ship.heading || 0];
                    existingBb.position = position;
                    existingBb.rotation = heading;
                    existingBb.alignedAxis = surfaceNormal;
                }
                var existingLabel = shipLabelMap[mmsiKey];
                if (existingLabel) {
                    if (!prev || prev[0] !== ship.lng || prev[1] !== ship.lat) {
                        existingLabel.position = position;
                    }
                    if (ship.name && existingLabel.text !== ship.name) {
                        existingLabel.text = ship.name;
                    }
                }
            } else {
                // 새 billboard 추가 — 화살표 + 꼬리 (2D 화살표와 통일)
                var bb = billboards.add({
                    position: position,
                    image: getShipArrowIcon(SHIP_COLORS[type] || '#6b7280'),
                    width: SHIP_ARROW_W,
                    height: SHIP_ARROW_H,
                    rotation: heading,
                    alignedAxis: surfaceNormal,
                    scaleByDistance: new Cesium.NearFarScalar(5e5, 1.9, 1.5e7, 0.9),
                    disableDepthTestDistance: 5e6
                });
                bb._mmsi = ship.mmsi;
                bb._shipType = type;
                shipBillboardMap[String(ship.mmsi)] = bb;

                // 새 라벨 추가
                var lbl = labels.add({
                    position: position,
                    text: ship.name || '',
                    font: '11px Pretendard Variable, Inter, sans-serif',
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
    });

    // Update 3D models if zoomed in
    if (ship3dEnabled && typeof updateShip3dModels === 'function') {
        updateShip3dModels(ships);
    }

    // 2D mode Leaflet marker update
    if (currentMapMode === '2d' && leafletMap) {
        var newMarkersByType = {};
        ships.forEach(function(ship) {
            var type = ship.type || 'other';
            var entry = leafletShipMarkers[ship.mmsi];

            if (entry) {
                // Skip setLatLng if position unchanged
                if (entry._prevLat !== ship.lat || entry._prevLng !== ship.lng) {
                    entry._prevLat = ship.lat;
                    entry._prevLng = ship.lng;
                    entry.marker.setLatLng([ship.lat, ship.lng]);
                }
                // Re-point the arrow if the heading changed (setLatLng already
                // redraws; only redraw separately when position held but course moved)
                if (entry._prevHeading !== ship.heading && entry.marker.setHeading) {
                    entry._prevHeading = ship.heading;
                    var hk = ship.heading != null && !isNaN(ship.heading);
                    entry.marker.setHeading(hk ? ship.heading : 0, hk);
                }
            } else {
                var color = SHIP_COLORS[type] || '#6b7280';
                var marker = makeShipArrowMarker(ship, color);

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
                leafletShipMarkers[ship.mmsi] = { marker: marker, type: type, _prevLat: ship.lat, _prevLng: ship.lng, _prevHeading: ship.heading };
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

    // requestRenderMode: 데이터 변경 후 Cesium에 렌더 요청
    if (viewer && viewer.scene) viewer.scene.requestRender();
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

                var acKey = String(ac.icao24);
                var existingBb = aircraftBillboardMap[acKey];
                if (existingBb) {
                    var prevAc = existingBb._prevPos;
                    if (prevAc && prevAc[0] === ac.lng && prevAc[1] === ac.lat && prevAc[2] === alt && prevAc[3] === (ac.heading || 0)) {
                        // No change — skip
                    } else {
                        existingBb._prevPos = [ac.lng, ac.lat, alt, ac.heading || 0];
                        existingBb.position = position;
                        existingBb.rotation = acHeading;
                        existingBb.alignedAxis = acSurfaceNormal;
                    }
                    var existingLabel = aircraftLabelMap[acKey];
                    if (existingLabel) {
                        if (!prevAc || prevAc[0] !== ac.lng || prevAc[1] !== ac.lat || prevAc[2] !== alt) {
                            existingLabel.position = position;
                        }
                        if (ac.callsign && existingLabel.text !== ac.callsign) {
                            existingLabel.text = ac.callsign;
                        }
                    }
                } else {
                    var bb = billboards.add({
                        position: position,
                        image: getAircraftIcon(AIRCRAFT_COLORS[type] || '#60a5fa', type),
                        width: 18,
                        height: 20,
                        rotation: acHeading,
                        alignedAxis: acSurfaceNormal,
                        scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                        disableDepthTestDistance: 5e6
                    });
                    bb._icao24 = ac.icao24;
                    bb._isAircraft = true;
                    bb._acType = type;
                    aircraftBillboardMap[String(ac.icao24)] = bb;

                    var lbl = labels.add({
                        position: position,
                        text: ac.callsign || '',
                        font: '10px Pretendard Variable, Inter, sans-serif',
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
        });
    }

    // Leaflet 2D mode
    if (currentMapMode === '2d' && leafletMap) {
        var newAcMarkersByType = {};
        aircraft.forEach(function(ac) {
            var type = ac.category || 'other';
            var entry = leafletAircraftMarkers[ac.icao24];

            if (entry) {
                // Skip setLatLng if position unchanged
                if (entry._prevLat !== ac.lat || entry._prevLng !== ac.lng) {
                    entry._prevLat = ac.lat;
                    entry._prevLng = ac.lng;
                    entry.marker.setLatLng([ac.lat, ac.lng]);
                }
                // Only update icon if heading actually changed
                var newH = ac.heading || 0;
                if (entry._lastHeading !== newH) {
                    entry._lastHeading = newH;
                    var uColor = (typeof AIRCRAFT_COLORS !== 'undefined' && AIRCRAFT_COLORS[type]) ? AIRCRAFT_COLORS[type] : '#60a5fa';
                    entry.marker.setIcon(L.divIcon({
                        className: 'aircraft-icon-2d',
                        html: '<svg viewBox="0 0 32 32" width="14" height="14" style="transform:rotate(' + newH + 'deg);filter:drop-shadow(0 0 2px rgba(0,0,0,0.6));">' +
                              '<path d="M16,2 L18,8 L30,17 L30,19 L18,15 L18,26 L22,30 L22,31 L16,29 L10,31 L10,30 L14,26 L14,15 L2,19 L2,17 L14,8 Z" ' +
                              'fill="' + uColor + '" stroke="#000" stroke-width="0.5"/></svg>',
                        iconSize: [14, 14],
                        iconAnchor: [7, 7]
                    }));
                }
            } else {
                var color = (typeof AIRCRAFT_COLORS !== 'undefined' && AIRCRAFT_COLORS[type]) ? AIRCRAFT_COLORS[type] : '#60a5fa';
                var _acHeading = ac.heading || 0;
                var acIcon = L.divIcon({
                    className: 'aircraft-icon-2d',
                    html: '<svg viewBox="0 0 32 32" width="14" height="14" style="transform:rotate(' + _acHeading + 'deg);filter:drop-shadow(0 0 2px rgba(0,0,0,0.6));">' +
                          '<path d="M16,2 L18,8 L30,17 L30,19 L18,15 L18,26 L22,30 L22,31 L16,29 L10,31 L10,30 L14,26 L14,15 L2,19 L2,17 L14,8 Z" ' +
                          'fill="' + color + '" stroke="#000" stroke-width="0.5"/></svg>',
                    iconSize: [14, 14],
                    iconAnchor: [7, 7]
                });
                var marker = L.marker([ac.lat, ac.lng], { icon: acIcon });

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

    }

    if (viewer && viewer.scene) viewer.scene.requestRender();
}
window.updateAircraftLayer = updateAircraftLayer;

var ws;
var _wsReconnectDelay = 300;          // ms — first retry is fast so cold-start is barely visible
var _WS_RECONNECT_MAX = 5000;         // exponential backoff cap
function initWebSocket() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/api/v1/ws/ships';

    console.log("Connecting to WebSocket:", wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
        console.log("WebSocket connected!");
        _wsReconnectDelay = 300;       // reset backoff on successful open
        EventBus.emit('ws:status', 'connected');
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
                        _lastLatencyMs = latency;
                        if (typeof BottomBar !== 'undefined') {
                            BottomBar.updateValue('headerLatency', latency);
                        }
                        var latEl = document.getElementById('headerLatency');
                        if (latEl) {
                            latEl.classList.toggle('latency-warn', latency >= 300 && latency < 1000);
                            latEl.classList.toggle('latency-bad', latency >= 1000);
                        }
                    }
                }

                _lastShipsData = data.ships || [];

                // DataService handles state + emits 'ships:updated'
                DataService.updateShips(_lastShipsData);

                if (data.timestamp) {
                    var updated = new Date(data.timestamp);
                    var kst = new Date(updated.getTime() + 9 * 60 * 60 * 1000);
                    document.getElementById('last-update').textContent = kst.toISOString().substring(11, 19);
                }

                _lastWsReceived = Date.now();
            }
            else if (data.type === "aircraft_update") {
                // DataService handles state + emits 'aircraft:updated'
                DataService.updateAircraft(data.aircraft || []);
            }
        } catch (error) {
            console.error("Error parsing WebSocket message:", error);
        }
    };

    ws.onerror = function(error) {
        console.error("WebSocket error:", error);
        EventBus.emit('ws:status', 'disconnected');
    };

    ws.onclose = function() {
        console.log("WebSocket closed. Reconnecting in " + _wsReconnectDelay + "ms...");
        EventBus.emit('ws:status', 'connecting');
        var loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.style.display = '';
            var loadingText = document.getElementById('loading-text');
            if (loadingText) loadingText.textContent = '재연결 중...';
        }
        if (currentMapMode === '2d' && leafletMap) {
            Object.values(leafletShipMarkers).forEach(function(m) { m.setStyle({ opacity: 0.3, fillOpacity: 0.3 }); });
        }
        setTimeout(initWebSocket, _wsReconnectDelay);
        _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, _WS_RECONNECT_MAX);
    };
}
window.initWebSocket = initWebSocket;

// ── WS connection status LED ──
// Freshness first (stale link = amber/red), then latency thresholds:
// <300ms green, <1s amber, >=1s red — matches the latency text color.
var _lastWsReceived = 0;
var _lastLatencyMs = -1;

setInterval(function() {
    var ago = _lastWsReceived ? Math.round((Date.now() - _lastWsReceived) / 1000) : 999;
    var led = document.getElementById('headerWsLed');
    if (led) {
        var cls;
        if (ago > 15) cls = 'disconnected';
        else if (ago > 5) cls = 'connecting';
        else if (_lastLatencyMs >= 1000) cls = 'connected latency-bad';
        else if (_lastLatencyMs >= 300) cls = 'connected latency-warn';
        else cls = 'connected';
        led.className = 'ws-led ' + cls;
    }
}, 1000);

// ── EventBus Subscribers ──

EventBus.on('ships:updated', function(data) {
    var ships = data.ships;

    // Loading overlay handling
    var loadingEl = document.getElementById('loading');
    var loadingTextEl = document.getElementById('loading-text');
    var isFirstLoad2d = Object.keys(leafletShipMarkers).length === 0 && currentMapMode === '2d';

    if (isFirstLoad2d && loadingEl && loadingTextEl) {
        loadingTextEl.textContent = '선박 데이터 렌더링 중...';
        loadingEl.style.display = 'flex';
        requestAnimationFrame(function() {
            setTimeout(function() {
                updateShipsLayer(ships);
                if (loadingEl) loadingEl.style.display = 'none';
            }, 0);
        });
    } else {
        if (loadingEl && loadingEl.style.display !== 'none') {
            loadingEl.style.display = 'none';
        }
        updateShipsLayer(ships);
    }

    // Ship type distribution chart
    if (typeof updateShipTypeChart === 'function') updateShipTypeChart(ships);

    // Proximity refresh (throttled)
    if (selectedProximityMmsi) {
        var now = Date.now();
        if (now - lastProximityUpdate >= PROXIMITY_THROTTLE_MS) {
            lastProximityUpdate = now;
            updateProximity();
        }
    }
});

EventBus.on('aircraft:updated', function(data) {
    updateAircraftLayer(data.aircraft);
});

EventBus.on('ws:status', function(status) {
    if (typeof setWsStatus === 'function') setWsStatus(status);
});

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
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#3b82f6';
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
