// ── Maritime OSINT Sentry — Dark Ship (AIS 고스트 추적) ──
// 신호두절 30분+ 선박을 지도 위에 고스트 마커 + 불확실성 원으로 표시.
// hazard-zones와 달리 모드 전환 없이 지금 보고 있는 2D/3D 지도 위에 그대로 오버레이된다.

var _darkShipsActive = false;
var _darkShipsPollTimer = null;
var _darkShipsCache = [];              // 최신 폴링 결과 (mmsi 조회용)
var _darkShipCesiumDataSource = null;
var _darkShipLeafletLayer = null;

var DARK_SHIP_POLL_MS = 30000;
var DARK_SHIP_COLOR = '#9b8ce0';       // 중립 보라 — 위험도(빨강/주황) 팔레트와 분리

function _nmToMeters(nm) {
    return nm * 1852;
}

function activateDarkShips() {
    if (_darkShipsActive) return;
    _darkShipsActive = true;
    _fetchAndRenderDarkShips();
    _darkShipsPollTimer = setInterval(_fetchAndRenderDarkShips, DARK_SHIP_POLL_MS);
}
window.activateDarkShips = activateDarkShips;

function deactivateDarkShips() {
    _darkShipsActive = false;
    if (_darkShipsPollTimer) {
        clearInterval(_darkShipsPollTimer);
        _darkShipsPollTimer = null;
    }
    _clearDarkShipEntities();
    _darkShipsCache = [];
}
window.deactivateDarkShips = deactivateDarkShips;

function isDarkShipsActive() {
    return _darkShipsActive;
}
window.isDarkShipsActive = isDarkShipsActive;

function getDarkShipEntry(mmsi) {
    for (var i = 0; i < _darkShipsCache.length; i++) {
        if (_darkShipsCache[i].mmsi == mmsi) return _darkShipsCache[i];
    }
    return null;
}
window.getDarkShipEntry = getDarkShipEntry;

function _fetchAndRenderDarkShips() {
    fetch('/api/v1/ships/dark')
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
            _darkShipsCache = data.dark_ships || [];
            if (_darkShipsActive) _renderDarkShipEntities(_darkShipsCache);
        })
        .catch(function(err) {
            console.error('[dark-ship] fetch failed:', err);
        });
}

function _clearDarkShipEntities() {
    if (_darkShipCesiumDataSource && window.viewer) {
        viewer.dataSources.remove(_darkShipCesiumDataSource, true);
        _darkShipCesiumDataSource = null;
    }
    if (_darkShipLeafletLayer && window.leafletMap) {
        leafletMap.removeLayer(_darkShipLeafletLayer);
        _darkShipLeafletLayer = null;
    }
}

function _renderDarkShipEntities(darkShips) {
    _clearDarkShipEntities();
    if (!darkShips.length) return;

    if (typeof currentMapMode !== 'undefined' && currentMapMode === '2d' && window.leafletMap) {
        _renderDarkShipsLeaflet(darkShips);
    } else if (window.viewer) {
        _renderDarkShipsCesium(darkShips);
    }
}

function _renderDarkShipsCesium(darkShips) {
    _darkShipCesiumDataSource = new Cesium.CustomDataSource('DarkShips');
    viewer.dataSources.add(_darkShipCesiumDataSource);

    darkShips.forEach(function(d) {
        _darkShipCesiumDataSource.entities.add({
            id: 'dark_' + d.mmsi,
            position: Cesium.Cartesian3.fromDegrees(d.lng, d.lat),
            billboard: {
                image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
                    '<text x="16" y="24" font-size="24" text-anchor="middle" fill="' +
                    DARK_SHIP_COLOR + '">👻</text></svg>'),
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                scale: 1.0
            },
            ellipse: {
                semiMinorAxis: _nmToMeters(d.radius_nm),
                semiMajorAxis: _nmToMeters(d.radius_nm),
                material: Cesium.Color.fromCssColorString(DARK_SHIP_COLOR).withAlpha(0.15),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString(DARK_SHIP_COLOR).withAlpha(0.6)
            },
            description: d.name + ' — ' + d.minutes_dark + '분 전 신호 소실'
        });
    });
    if (viewer.scene) viewer.scene.requestRender();
}

function _renderDarkShipsLeaflet(darkShips) {
    var group = L.layerGroup();
    darkShips.forEach(function(d) {
        L.circle([d.lat, d.lng], {
            radius: _nmToMeters(d.radius_nm),
            color: DARK_SHIP_COLOR,
            weight: 1.5,
            fillColor: DARK_SHIP_COLOR,
            fillOpacity: 0.12,
            interactive: false
        }).addTo(group);

        L.marker([d.lat, d.lng], {
            icon: L.divIcon({
                className: 'dark-ship-icon',
                html: '<i class="fa-solid fa-ghost" style="color:' + DARK_SHIP_COLOR + ';font-size:18px;"></i>',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            })
        }).bindPopup(d.name + ' — ' + d.minutes_dark + '분 전 신호 소실').addTo(group);
    });
    group.addTo(leafletMap);
    _darkShipLeafletLayer = group;
}
