// ── Maritime OSINT Sentry — Satellite Layer ──

var _satIconCache = {};
function getSatIcon(colorHex, missionType) {
    var key = colorHex + '|' + (missionType || '');
    if (_satIconCache[key]) return _satIconCache[key];

    var c = colorHex;
    var gid = c.slice(1) + (missionType || 'def');
    // Diamond shape: rhombus centered at 24,24
    var body = '\
        <polygon points=\'24,6 42,24 24,42 6,24\' fill=\'none\' stroke=\'' + c + '\' stroke-width=\'2\' stroke-linejoin=\'round\' opacity=\'0.9\'/>\
        <line x1=\'24\' y1=\'14\' x2=\'24\' y2=\'20\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.5\'/>\
        <line x1=\'24\' y1=\'28\' x2=\'24\' y2=\'34\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.5\'/>\
        <line x1=\'14\' y1=\'24\' x2=\'20\' y2=\'24\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.5\'/>\
        <line x1=\'28\' y1=\'24\' x2=\'34\' y2=\'24\' stroke=\'' + c + '\' stroke-width=\'1.5\' opacity=\'0.5\'/>';

    var svg = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 48 48\'>\
        <defs>\
            <filter id=\'glow-' + gid + '\' x=\'-50%\' y=\'-50%\' width=\'200%\' height=\'200%\'>\
                <feGaussianBlur stdDeviation=\'2\' result=\'blur\'/>\
                <feMerge><feMergeNode in=\'blur\'/><feMergeNode in=\'SourceGraphic\'/></feMerge>\
            </filter>\
        </defs>\
        <g filter=\'url(%23glow-' + gid + ')\'>' + body + '</g>\
    </svg>';
    var uri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    _satIconCache[key] = uri;
    return uri;
}
window.getSatIcon = getSatIcon;

// Build set of enabled mission types from checkboxes
function _getEnabledMissions() {
    var enabled = new Set();
    document.querySelectorAll('.sat-mission-filter').forEach(function(cb) {
        if (cb.checked) {
            cb.dataset.mission.split(',').forEach(function(m) { enabled.add(m.trim()); });
        }
    });
    return enabled;
}

// Show/hide satellite entities based on mission filter state
function _applySatMissionFilter() {
    var enabled = _getEnabledMissions();
    var visibleCount = 0;
    Object.entries(_satRecCache).forEach(function([satId, { sat }]) {
        var mission = sat.mission || '';
        var visible = enabled.has(mission);
        if (visible) visibleCount++;
        ['', 'orbit-', 'ground-', 'footprint-'].forEach(function(prefix) {
            var entity = satDataSource.entities.getById(prefix + satId);
            if (entity) {
                if (prefix === '') {
                    entity.show = visible;
                } else if (visible) {
                    var toggleId = prefix === 'orbit-' ? 'layer-sat-orbits'
                        : prefix === 'ground-' ? 'layer-sat-ground'
                            : 'layer-sat-footprint';
                    entity.show = document.getElementById(toggleId).checked;
                } else {
                    entity.show = false;
                }
            }
        });
    });
    document.getElementById('total-sats').textContent = visibleCount + '/' + Object.keys(_satRecCache).length;
}

document.getElementById('layer-sats').addEventListener('change', function(e) {
    satDataSource.show = e.target.checked;
    document.getElementById('satSubToggles').style.display = e.target.checked ? 'block' : 'none';
    if (e.target.checked) _applySatMissionFilter();
    if (currentMapMode === '2d') {
        if (satDataSource.show) {
            syncSatellitesToLeaflet();
        } else {
            Object.values(leafletSatMarkers).forEach(function(m) { leafletMap.removeLayer(m); });
            Object.values(leafletSatTracks).forEach(function(t) { leafletMap.removeLayer(t); });
            leafletSatMarkers = {};
            leafletSatTracks = {};
        }
    }
});

// Mission type filter change handlers
document.querySelectorAll('.sat-mission-filter').forEach(function(cb) {
    cb.addEventListener('change', function() {
        _applySatMissionFilter();
        if (currentMapMode === '2d' && typeof syncSatellitesToLeaflet === 'function') {
            syncSatellitesToLeaflet();
        }
    });
});

// Sub-toggles: 3D Orbit, Ground Track, Sensor Footprint
function _toggleSatLayer(prefix, visible) {
    var enabled = _getEnabledMissions();
    satDataSource.entities.values.forEach(function(e) {
        if (e.id.startsWith(prefix)) {
            var satId = e.id.slice(prefix.length);
            var rec = _satRecCache[satId];
            var missionVisible = rec ? enabled.has(rec.sat.mission || '') : true;
            e.show = visible && missionVisible;
        }
    });
}

document.getElementById('layer-sat-orbits').addEventListener('change', function(e) {
    _toggleSatLayer('orbit-', e.target.checked);
});
document.getElementById('layer-sat-ground').addEventListener('change', function(e) {
    _toggleSatLayer('ground-', e.target.checked);
    if (currentMapMode === '2d' && typeof syncSatellitesToLeaflet === 'function') syncSatellitesToLeaflet();
});
document.getElementById('layer-sat-footprint').addEventListener('change', function(e) {
    _toggleSatLayer('footprint-', e.target.checked);
    if (currentMapMode === '2d' && typeof syncSatellitesToLeaflet === 'function') syncSatellitesToLeaflet();
});

var _satLastApiFetch = 0;
var SAT_API_INTERVAL_MS = 30 * 60 * 1000;

async function _refreshSatTleCache() {
    try {
        var response = await fetch('/api/v1/satellites');
        if (!response.ok) return;
        var sats = await response.json();
        var newCache = {};
        var hasSatelliteJs = typeof satellite !== 'undefined';

        sats.forEach(function(sat) {
            var satId = String(sat.id);
            var satrec = null;
            if (hasSatelliteJs) {
                if (sat.tle && sat.tle.length === 2) {
                    try { satrec = satellite.twoline2satrec(sat.tle[0], sat.tle[1]); } catch (e) { /* skip */ }
                } else if (sat.gp) {
                    satrec = _createSatrecFromGP(sat.gp, sat.id);
                }
            }
            newCache[satId] = { satrec: satrec, sat: sat };
        });
        _satRecCache = newCache;
        _satLastApiFetch = Date.now();
        var enabledM = _getEnabledMissions();
        var visCount = sats.filter(function(s) { return enabledM.has(s.mission || ''); }).length;
        document.getElementById('total-sats').textContent = visCount + '/' + sats.length;
    } catch (err) {
        console.error('Error fetching satellite TLE data:', err);
    }
}

function _createSatrecFromGP(gp, noradId) {
    if (!gp || typeof satellite === 'undefined') return null;
    try {
        var epochDt = new Date(gp.EPOCH);
        var year = epochDt.getUTCFullYear();
        var startOfYear = new Date(Date.UTC(year, 0, 1));
        var dayOfYear = (epochDt - startOfYear) / 86400000 + 1;
        var epochYr = year % 100;
        var epochDay = dayOfYear + epochDt.getUTCHours() / 24 +
            epochDt.getUTCMinutes() / 1440 + epochDt.getUTCSeconds() / 86400;

        var norad = String(noradId).padStart(5, '0');
        var eLine1 = '1 ' + norad + 'U 00000A   ' + String(epochYr).padStart(2, '0') + epochDay.toFixed(8).padStart(12, ' ') + ' .00000000  00000-0  ' + (gp.BSTAR || 0).toExponential(4).replace('e', '').replace('+', '').replace('.', '').padStart(8, ' ') + ' 0    0';
        var eLine2 = '2 ' + norad + ' ' + (gp.INCLINATION).toFixed(4).padStart(8, ' ') + ' ' + (gp.RA_OF_ASC_NODE).toFixed(4).padStart(8, ' ') + ' ' + String(Math.round(gp.ECCENTRICITY * 1e7)).padStart(7, '0') + ' ' + (gp.ARG_OF_PERICENTER).toFixed(4).padStart(8, ' ') + ' ' + (gp.MEAN_ANOMALY).toFixed(4).padStart(8, ' ') + ' ' + (gp.MEAN_MOTION).toFixed(8).padStart(11, ' ') + '    0';

        return satellite.twoline2satrec(eLine1, eLine2);
    } catch (e) {
        return null;
    }
}

function _computeGroundTrack(satrec, now, steps) {
    steps = steps || 120;
    var positions = [];
    var periodMin = satrec.no ? (2 * Math.PI / satrec.no) : 90;
    for (var i = 0; i <= steps; i++) {
        var t = new Date(now.getTime() + (i / steps) * periodMin * 60 * 1000);
        try {
            var posVel = satellite.propagate(satrec, t);
            if (!posVel.position) continue;
            var gmst = satellite.gstime(t);
            var geo = satellite.eciToGeodetic(posVel.position, gmst);
            positions.push(
                satellite.degreesLong(geo.longitude),
                satellite.degreesLat(geo.latitude)
            );
        } catch (e) { /* skip */ }
    }
    return positions;
}

function _computeFootprint(lat, lng, altKm, numPoints) {
    numPoints = numPoints || 18;
    var R = 6371;
    var halfAngleDeg = Math.acos(R / (R + altKm)) * (180 / Math.PI) * 0.5;
    var positions = [];
    for (var i = 0; i <= numPoints; i++) {
        var bearing = (360 / numPoints) * i;
        var bearingRad = bearing * Math.PI / 180;
        var latRad = lat * Math.PI / 180;
        var lngRad = lng * Math.PI / 180;
        var angDist = halfAngleDeg * Math.PI / 180;
        var newLat = Math.asin(
            Math.sin(latRad) * Math.cos(angDist) +
            Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearingRad)
        );
        var newLng = lngRad + Math.atan2(
            Math.sin(bearingRad) * Math.sin(angDist) * Math.cos(latRad),
            Math.cos(angDist) - Math.sin(latRad) * Math.sin(newLat)
        );
        positions.push(newLng * 180 / Math.PI, newLat * 180 / Math.PI);
    }
    return positions;
}
window._computeFootprint = _computeFootprint;
window._computeGroundTrack = _computeGroundTrack;
window._getEnabledMissions = _getEnabledMissions;

function _computeOrbitPath(satrec, now, steps) {
    steps = steps || 120;
    var positions = [];
    var periodMin = satrec.no ? (2 * Math.PI / satrec.no) : 90;
    for (var i = 0; i <= steps; i++) {
        var t = new Date(now.getTime() + (i / steps) * periodMin * 60 * 1000);
        try {
            var posVel = satellite.propagate(satrec, t);
            if (!posVel.position) continue;
            var gmst = satellite.gstime(t);
            var geo = satellite.eciToGeodetic(posVel.position, gmst);
            positions.push(
                satellite.degreesLong(geo.longitude),
                satellite.degreesLat(geo.latitude),
                geo.height * 1000
            );
        } catch (e) { /* skip point */ }
    }
    return positions;
}

function _propagateSatPositions() {
    var hasSatelliteJs = typeof satellite !== 'undefined';
    var now = new Date();
    var enabledMissions = _getEnabledMissions();

    Object.entries(_satRecCache).forEach(function([satId, { satrec, sat }]) {
        var lat, lng, altKm;

        if (hasSatelliteJs && satrec) {
            try {
                var posVel = satellite.propagate(satrec, now);
                if (!posVel.position) return;
                var gmst = satellite.gstime(now);
                var geodetic = satellite.eciToGeodetic(posVel.position, gmst);
                lat = satellite.degreesLat(geodetic.latitude);
                lng = satellite.degreesLong(geodetic.longitude);
                altKm = geodetic.height;
            } catch (e) {
                lat = sat.lat; lng = sat.lng; altKm = sat.alt_km || 0;
            }
        } else {
            lat = sat.lat; lng = sat.lng; altKm = sat.alt_km || 0;
        }

        var color = SAT_COLORS[sat.mission] || '#94a3b8';
        var position = Cesium.Cartesian3.fromDegrees(lng, lat, altKm * 1000);

        var entity = satDataSource.entities.getById(satId);
        if (!entity) {
            if (hasSatelliteJs && satrec) {
                var cesiumColor = Cesium.Color.fromCssColorString(color);

                var orbitCoords = _computeOrbitPath(satrec, now);
                if (orbitCoords.length > 6) {
                    satDataSource.entities.add({
                        id: 'orbit-' + satId,
                        polyline: {
                            positions: Cesium.Cartesian3.fromDegreesArrayHeights(orbitCoords),
                            width: 1.5,
                            material: new Cesium.PolylineDashMaterialProperty({
                                color: cesiumColor.withAlpha(0.4),
                                dashLength: 16,
                                dashPattern: 255
                            })
                        }
                    });
                }

                var groundCoords = _computeGroundTrack(satrec, now);
                if (groundCoords.length > 4) {
                    satDataSource.entities.add({
                        id: 'ground-' + satId,
                        polyline: {
                            positions: Cesium.Cartesian3.fromDegreesArray(groundCoords),
                            width: 1.5,
                            clampToGround: true,
                            material: new Cesium.PolylineDashMaterialProperty({
                                color: cesiumColor.withAlpha(0.35),
                                dashLength: 10,
                                dashPattern: 255
                            })
                        }
                    });
                }
            }

            satDataSource.entities.add({
                id: satId,
                name: sat.name,
                description: '\
                    <table class="cesium-infoBox-defaultTable"><tbody>\
                        <tr><th>Name</th><td>' + sat.name + '</td></tr>\
                        <tr><th>NORAD ID</th><td>' + sat.id + '</td></tr>\
                        <tr><th>Country</th><td>' + (sat.country || 'UNKNOWN') + '</td></tr>\
                        <tr><th>Mission</th><td>' + (sat.sat_type || sat.mission || '-') + '</td></tr>\
                        <tr><th>Altitude</th><td>' + Math.round(altKm) + ' km</td></tr>\
                        <tr><th>Speed</th><td>' + sat.speed_knots + ' kts</td></tr>\
                        ' + (sat.wiki ? '<tr><th>Info</th><td><a href="' + sat.wiki + '" target="_blank">Wikipedia</a></td></tr>' : '') + '\
                    </tbody></table>\
                ',
                position: new Cesium.CallbackProperty(function() {
                    var e = satDataSource.entities.getById(satId);
                    return (e && e._currentPosition) || position;
                }, false),
                billboard: {
                    image: getSatIcon(color, sat.mission),
                    width: 32,
                    height: 32,
                    scaleByDistance: new Cesium.NearFarScalar(1.5e7, 1.5, 8.0e7, 0.6),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: sat.name,
                    font: '11px JetBrains Mono, monospace',
                    fillColor: Cesium.Color.fromCssColorString(color),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -26),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6e7),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
        }
        var e = satDataSource.entities.getById(satId);
        if (e) e.position = position;

        var missionVisible = enabledMissions.has(sat.mission || '');
        if (e) e.show = missionVisible;

        var orbitE = satDataSource.entities.getById('orbit-' + satId);
        if (orbitE) orbitE.show = missionVisible && document.getElementById('layer-sat-orbits').checked;
        var groundE = satDataSource.entities.getById('ground-' + satId);
        if (groundE) groundE.show = missionVisible && document.getElementById('layer-sat-ground').checked;
        var fpE = satDataSource.entities.getById('footprint-' + satId);
        if (fpE) fpE.show = missionVisible && document.getElementById('layer-sat-footprint').checked;
    });

    var cacheIds = new Set(Object.keys(_satRecCache));
    satDataSource.entities.values
        .filter(function(e) {
            var baseId = e.id;
            ['orbit-', 'ground-', 'footprint-'].forEach(function(prefix) {
                if (baseId.startsWith(prefix)) { baseId = baseId.slice(prefix.length); }
            });
            return !cacheIds.has(baseId);
        })
        .forEach(function(e) { satDataSource.entities.remove(e); });
}

// Update satellites for a specific time (history mode)
function updateSatellitesForTime(sats, targetDate) {
    sats.forEach(function(sat) {
        var satId = String(sat.id);
        var lat = sat.lat;
        var lng = sat.lng;
        var altKm = sat.alt_km || 0;
        var color = SAT_COLORS[sat.mission] || '#94a3b8';
        var position = Cesium.Cartesian3.fromDegrees(lng, lat, altKm * 1000);

        var entity = satDataSource.entities.getById(satId);
        if (!entity) {
            satDataSource.entities.add({
                id: satId,
                name: sat.name,
                description: '\
                    <table class="cesium-infoBox-defaultTable"><tbody>\
                        <tr><th>Name</th><td>' + sat.name + '</td></tr>\
                        <tr><th>NORAD ID</th><td>' + sat.id + '</td></tr>\
                        <tr><th>Country</th><td>' + (sat.country || 'UNKNOWN') + '</td></tr>\
                        <tr><th>Mission</th><td>' + (sat.sat_type || sat.mission || '-') + '</td></tr>\
                        <tr><th>Altitude</th><td>' + Math.round(altKm) + ' km</td></tr>\
                        <tr><th>Speed</th><td>' + (sat.speed_knots || 0) + ' kts</td></tr>\
                        ' + (sat.wiki ? '<tr><th>Info</th><td><a href="' + sat.wiki + '" target="_blank">Wikipedia</a></td></tr>' : '') + '\
                    </tbody></table>\
                ',
                position: position,
                billboard: {
                    image: getSatIcon(color, sat.mission),
                    width: 32,
                    height: 32,
                    scaleByDistance: new Cesium.NearFarScalar(1.5e7, 1.5, 8.0e7, 0.6),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: sat.name,
                    font: '11px JetBrains Mono, monospace',
                    fillColor: Cesium.Color.fromCssColorString(color),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -26),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6e7),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
        } else {
            entity.position = position;
        }

        _satRecCache[satId] = { satrec: null, sat: sat };
    });

    var currentIds = new Set(sats.map(function(s) { return String(s.id); }));
    satDataSource.entities.values
        .filter(function(e) { return !currentIds.has(e.id); })
        .forEach(function(e) { satDataSource.entities.remove(e); });

    document.getElementById('total-sats').textContent = sats.length;
}
window.updateSatellitesForTime = updateSatellitesForTime;

// Satellite footprint toggle
var _activeFootprintSatId = null;

function _getSatRealTimePosition(satId) {
    var cache = _satRecCache[satId];
    if (!cache) return null;
    var satrec = cache.satrec;
    var sat = cache.sat;
    if (typeof satellite !== 'undefined' && satrec) {
        try {
            var now = new Date();
            var posVel = satellite.propagate(satrec, now);
            if (posVel.position) {
                var gmst = satellite.gstime(now);
                var geo = satellite.eciToGeodetic(posVel.position, gmst);
                return {
                    lat: satellite.degreesLat(geo.latitude),
                    lng: satellite.degreesLong(geo.longitude),
                    altKm: geo.height
                };
            }
        } catch (e) { /* fallback below */ }
    }
    return { lat: sat.lat, lng: sat.lng, altKm: sat.alt_km || 400 };
}

function _toggleSatFootprint(satId) {
    if (_activeFootprintSatId) {
        var old = satDataSource.entities.getById('footprint-' + _activeFootprintSatId);
        if (old) satDataSource.entities.remove(old);
    }

    if (_activeFootprintSatId === satId) {
        _activeFootprintSatId = null;
        return;
    }

    var cache = _satRecCache[satId];
    if (!cache) return;
    var color = SAT_COLORS[cache.sat.mission] || '#94a3b8';
    var pos = _getSatRealTimePosition(satId);
    if (!pos) return;

    var footprintCoords = _computeFootprint(pos.lat, pos.lng, pos.altKm);
    if (footprintCoords.length > 4) {
        satDataSource.entities.add({
            id: 'footprint-' + satId,
            polygon: {
                hierarchy: Cesium.Cartesian3.fromDegreesArray(footprintCoords),
                material: Cesium.Color.fromCssColorString(color).withAlpha(0.12),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString(color).withAlpha(0.5),
                outlineWidth: 1,
                height: 0
            }
        });
        _activeFootprintSatId = satId;
    }
}
window._toggleSatFootprint = _toggleSatFootprint;
window._activeFootprintSatId = null;

// Initial TLE load + apply mission filter
_refreshSatTleCache().then(function() {
    _propagateSatPositions();
    _applySatMissionFilter();
});

// Refresh TLE data from API every 30 minutes (only in LIVE mode)
setInterval(async function() {
    if (timeMode === 'live') {
        await _refreshSatTleCache();
    }
}, SAT_API_INTERVAL_MS);

// Re-propagate positions every 5 seconds
setInterval(function() {
    if (timeMode === 'live') {
        _propagateSatPositions();
        // Sync to Leaflet 2D if active
        if (currentMapMode === '2d' && typeof syncSatellitesToLeaflet === 'function') {
            syncSatellitesToLeaflet();
        }
    }
}, 5000);
