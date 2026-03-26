// ── Maritime OSINT Sentry — Vessel Proximity & CPA ──

/**
 * Haversine distance between two points in decimal degrees.
 * Returns distance in nautical miles.
 */
function haversineNm(lat1, lon1, lat2, lon2) {
    var R = 3440.065;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
window.haversineNm = haversineNm;

/**
 * Project a position forward along a bearing (COG) by a given distance.
 * Returns {lat, lng} in degrees.
 */
function projectPosition(lat, lng, cogDeg, distNm) {
    var R = 3440.065;
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;
    var lat1 = lat * toRad;
    var lon1 = lng * toRad;
    var brng = cogDeg * toRad;
    var d = distNm / R;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    var lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * toDeg, lng: lon2 * toDeg };
}
window.projectPosition = projectPosition;

/**
 * Compute CPA (Closest Point of Approach) position and time.
 */
function computeCpa(shipA, shipB) {
    var toRad = Math.PI / 180;
    var nmPerDeg = 60;
    var sogA = shipA.sog || 0, cogA = (shipA.cog || 0) * toRad;
    var sogB = shipB.sog || 0, cogB = (shipB.cog || 0) * toRad;
    var vxA = (sogA / 60) * Math.sin(cogA), vyA = (sogA / 60) * Math.cos(cogA);
    var vxB = (sogB / 60) * Math.sin(cogB), vyB = (sogB / 60) * Math.cos(cogB);
    var dLat = (shipB.lat - shipA.lat) * nmPerDeg;
    var dLng = (shipB.lng - shipA.lng) * nmPerDeg * Math.cos(((shipA.lat + shipB.lat) / 2) * toRad);
    var dvx = vxB - vxA, dvy = vyB - vyA;
    var v2 = dvx * dvx + dvy * dvy;
    if (v2 < 1e-10) {
        return { lat: (shipA.lat + shipB.lat) / 2, lng: (shipA.lng + shipB.lng) / 2, tcpaMin: 0, dcpaNm: Math.sqrt(dLat * dLat + dLng * dLng) };
    }
    var tcpa = -(dLat * dvy + dLng * dvx) / v2;
    var tcpaMin = Math.max(tcpa, 0);
    var cpaA = projectPosition(shipA.lat, shipA.lng, shipA.cog || 0, (sogA / 60) * tcpaMin);
    var cpaB = projectPosition(shipB.lat, shipB.lng, shipB.cog || 0, (sogB / 60) * tcpaMin);
    var dcpaNm = haversineNm(cpaA.lat, cpaA.lng, cpaB.lat, cpaB.lng);
    return {
        lat: (cpaA.lat + cpaB.lat) / 2,
        lng: (cpaA.lng + cpaB.lng) / 2,
        tcpaMin: tcpaMin, dcpaNm: dcpaNm
    };
}
window.computeCpa = computeCpa;

/**
 * Find nearby vessels within radius, sorted by distance, max count.
 */
function findNearbyVesselsCandidates(mmsi, radiusNm, maxCount) {
    var selected = shipDataMap[mmsi];
    if (!selected) return { selected: selected, results: [] };

    var results = [];
    for (var key in shipDataMap) {
        if (key == mmsi) continue;
        var vessel = shipDataMap[key];
        if (!latestWsShipsMmsis.has(vessel.mmsi)) continue;

        var dist = haversineNm(selected.lat, selected.lng, vessel.lat, vessel.lng);
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

    results.sort(function(a, b) { return a.distance - b.distance; });
    return { selected: selected, results: results.slice(0, maxCount) };
}

// Land obstruction cache
var _landCache = new Map();
var LAND_CACHE_TTL_MS = 30000;

async function findNearbyVessels(mmsi, radiusNm, maxCount) {
    var result = findNearbyVesselsCandidates(mmsi, radiusNm, maxCount);
    var selected = result.selected;
    var results = result.results;
    if (!selected || results.length === 0) return results;

    var now = Date.now();
    var unchecked = [];
    var uncheckedIdx = [];

    for (var i = 0; i < results.length; i++) {
        var key = mmsi < results[i].mmsi
            ? mmsi + ':' + results[i].mmsi
            : results[i].mmsi + ':' + mmsi;
        var cached = _landCache.get(key);
        if (cached && (now - cached.ts) < LAND_CACHE_TTL_MS) {
            continue;
        }
        unchecked.push(results[i]);
        uncheckedIdx.push(i);
    }

    if (unchecked.length > 0) {
        try {
            var pairs = unchecked.map(function(nv) {
                return {
                    lat1: selected.lat, lon1: selected.lng,
                    lat2: nv.lat, lon2: nv.lng
                };
            });
            var resp = await fetch('/api/v1/collision/land-check-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pairs)
            });
            if (resp.ok) {
                var data = await resp.json();
                var blocked = data.results;
                for (var j = 0; j < unchecked.length; j++) {
                    var key = mmsi < unchecked[j].mmsi
                        ? mmsi + ':' + unchecked[j].mmsi
                        : unchecked[j].mmsi + ':' + mmsi;
                    _landCache.set(key, { blocked: blocked[j], ts: now });
                }
            }
        } catch (e) {
            console.warn('Land check failed, showing all:', e);
        }
    }

    return results.filter(function(nv) {
        var key = mmsi < nv.mmsi
            ? mmsi + ':' + nv.mmsi
            : nv.mmsi + ':' + mmsi;
        var cached = _landCache.get(key);
        return !cached || !cached.blocked;
    });
}

function proximityColor(distNm) {
    if (distNm < 2) return { css: '#ef4444', cesium: Cesium.Color.fromCssColorString('#ef4444') };
    if (distNm < 5) return { css: '#eab308', cesium: Cesium.Color.fromCssColorString('#eab308') };
    return { css: '#10b981', cesium: Cesium.Color.fromCssColorString('#10b981') };
}
window.proximityColor = proximityColor;

function mlRiskColor(riskLevel) {
    var css = ML_RISK_COLORS[riskLevel] || '#10b981';
    return { css: css, cesium: Cesium.Color.fromCssColorString(css) };
}
window.mlRiskColor = mlRiskColor;

/**
 * Enrich nearby vessels with ML risk levels from collision data.
 */
function enrichNearbyWithMlRisk(selectedMmsi, nearbyVessels) {
    var mlRisks = (collisionData.ml && collisionData.ml.risks) || [];
    var mlRiskMap = {};
    mlRisks.forEach(function(r) {
        if (r.ship_a.mmsi == selectedMmsi) {
            mlRiskMap[r.ship_b.mmsi] = r;
        } else if (r.ship_b.mmsi == selectedMmsi) {
            mlRiskMap[r.ship_a.mmsi] = r;
        }
    });

    var distRisks = (collisionData.distance && collisionData.distance.risks) || [];
    var distRiskMap = {};
    distRisks.forEach(function(r) {
        if (r.ship_a.mmsi == selectedMmsi) {
            distRiskMap[r.ship_b.mmsi] = r;
        } else if (r.ship_b.mmsi == selectedMmsi) {
            distRiskMap[r.ship_a.mmsi] = r;
        }
    });

    var DIST_SEVERITY_LABELS = { danger: '\uc704\ud5d8', warning: '\uacbd\uace0' };

    nearbyVessels.forEach(function(nv) {
        var mlMatch = mlRiskMap[nv.mmsi];
        var distMatch = distRiskMap[nv.mmsi];
        if (mlMatch) {
            nv.mlRiskLevel = mlMatch.risk_level;
            nv.mlRiskLabel = mlMatch.risk_label || ML_RISK_LABELS[mlMatch.risk_level] || '';
        }
        if (distMatch) {
            nv.distSeverity = distMatch.severity;
            nv.distRiskLabel = DIST_SEVERITY_LABELS[distMatch.severity] || distMatch.severity;
        }
    });
}
window.enrichNearbyWithMlRisk = enrichNearbyWithMlRisk;

function renderProximityLines(selectedMmsi, nearbyVessels) {
    proximityDataSource.entities.removeAll();
    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }
    var selected = shipDataMap[selectedMmsi];
    if (!selected || nearbyVessels.length === 0) return;

    var closestMmsi = nearbyVessels[0].mmsi;

    nearbyVessels.forEach(function(nv) {
        var isCollisionTarget = collisionTargetMmsi != null && (nv.mmsi == collisionTargetMmsi);
        var isMlPair = nv.mlRiskLevel != null;
        var color = isMlPair
            ? mlRiskColor(nv.mlRiskLevel)
            : isCollisionTarget
                ? { css: '#f43f5e', cesium: Cesium.Color.fromCssColorString('#f43f5e') }
                : proximityColor(nv.distance);
        var isHighlight = isMlPair || isCollisionTarget || nv.mmsi === closestMmsi;
        var showCollisionViz = isMlPair || isCollisionTarget;

        // Main proximity polyline
        proximityDataSource.entities.add({
            id: 'prox-line-' + nv.mmsi,
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    var sel = shipDataMap[selectedMmsi];
                    var tgt = shipDataMap[nv.mmsi];
                    if (!sel || !tgt) return [];
                    return Cesium.Cartesian3.fromDegreesArrayHeights([
                        sel.lng, sel.lat, 50, tgt.lng, tgt.lat, 50
                    ]);
                }, false),
                width: isMlPair ? 4 : isCollisionTarget ? 4 : isHighlight ? 3 : 2,
                material: isHighlight
                    ? new Cesium.PolylineGlowMaterialProperty({
                        color: new Cesium.CallbackProperty(function() {
                            var speed = isMlPair ? 300 : isCollisionTarget ? 300 : 500;
                            var alpha = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / speed));
                            return color.cesium.withAlpha(alpha);
                        }, false),
                        glowPower: isMlPair ? 0.5 : isCollisionTarget ? 0.5 : 0.3
                    })
                    : new Cesium.ColorMaterialProperty(color.cesium.withAlpha(0.6)),
                clampToGround: false
            }
        });

        // Label at midpoint
        proximityDataSource.entities.add({
            id: 'prox-label-' + nv.mmsi,
            position: new Cesium.CallbackProperty(function() {
                var sel = shipDataMap[selectedMmsi];
                var tgt = shipDataMap[nv.mmsi];
                if (!sel || !tgt) return Cesium.Cartesian3.fromDegrees(0, 0);
                return Cesium.Cartesian3.fromDegrees(
                    (sel.lng + tgt.lng) / 2,
                    (sel.lat + tgt.lat) / 2
                );
            }, false),
            label: {
                text: new Cesium.CallbackProperty(function() {
                    var sel = shipDataMap[selectedMmsi];
                    var tgt = shipDataMap[nv.mmsi];
                    if (!sel || !tgt) return '';
                    var d = haversineNm(sel.lat, sel.lng, tgt.lat, tgt.lng);
                    var prefix = isMlPair ? '\u26a0 ' : isCollisionTarget ? '\u26a0 ' : '';
                    return prefix + d.toFixed(1) + ' nm';
                }, false),
                font: isCollisionTarget ? 'bold 14px JetBrains Mono' : '12px JetBrains Mono',
                fillColor: color.cesium,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });

        // Collision visualization (COG lines + CPA marker + risk zone)
        if (showCollisionViz) {
            var sel = shipDataMap[selectedMmsi];
            var tgt = shipDataMap[nv.mmsi];
            if (!sel || !tgt) return;

            // COG projection line - selected ship
            proximityDataSource.entities.add({
                id: 'cog-sel-' + nv.mmsi,
                polyline: {
                    positions: new Cesium.CallbackProperty(function() {
                        var s = shipDataMap[selectedMmsi];
                        if (!s) return [];
                        var end = projectPosition(s.lat, s.lng, s.cog || 0, Math.max((s.sog || 0) / 60 * 10, 0.5));
                        return Cesium.Cartesian3.fromDegreesArrayHeights([s.lng, s.lat, 50, end.lng, end.lat, 50]);
                    }, false),
                    width: 2,
                    material: new Cesium.PolylineDashMaterialProperty({
                        color: color.cesium.withAlpha(0.7),
                        dashLength: 12
                    }),
                    clampToGround: false
                }
            });

            // COG projection line - target ship
            proximityDataSource.entities.add({
                id: 'cog-tgt-' + nv.mmsi,
                polyline: {
                    positions: new Cesium.CallbackProperty(function() {
                        var t = shipDataMap[nv.mmsi];
                        if (!t) return [];
                        var end = projectPosition(t.lat, t.lng, t.cog || 0, Math.max((t.sog || 0) / 60 * 10, 0.5));
                        return Cesium.Cartesian3.fromDegreesArrayHeights([t.lng, t.lat, 50, end.lng, end.lat, 50]);
                    }, false),
                    width: 2,
                    material: new Cesium.PolylineDashMaterialProperty({
                        color: color.cesium.withAlpha(0.7),
                        dashLength: 12
                    }),
                    clampToGround: false
                }
            });

            // CPA point marker + risk zone circle
            var cpa = computeCpa(sel, tgt);
            if (cpa.tcpaMin > 0 && cpa.tcpaMin < 60) {
                proximityDataSource.entities.add({
                    id: 'cpa-marker-' + nv.mmsi,
                    position: new Cesium.CallbackProperty(function() {
                        var s = shipDataMap[selectedMmsi];
                        var t = shipDataMap[nv.mmsi];
                        if (!s || !t) return Cesium.Cartesian3.fromDegrees(0, 0);
                        var c = computeCpa(s, t);
                        return Cesium.Cartesian3.fromDegrees(c.lng, c.lat);
                    }, false),
                    point: {
                        pixelSize: 10,
                        color: color.cesium.withAlpha(0.9),
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 2,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    },
                    label: {
                        text: new Cesium.CallbackProperty(function() {
                            var s = shipDataMap[selectedMmsi];
                            var t = shipDataMap[nv.mmsi];
                            if (!s || !t) return '';
                            var c = computeCpa(s, t);
                            return 'CPA ' + c.dcpaNm.toFixed(2) + 'nm\n' + c.tcpaMin.toFixed(1) + 'min';
                        }, false),
                        font: 'bold 11px JetBrains Mono',
                        fillColor: Cesium.Color.WHITE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 3,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -20),
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        showBackground: true,
                        backgroundColor: color.cesium.withAlpha(0.7)
                    }
                });

                var riskRadiusM = Math.max(cpa.dcpaNm * 1852, 200);
                proximityDataSource.entities.add({
                    id: 'cpa-zone-' + nv.mmsi,
                    position: new Cesium.CallbackProperty(function() {
                        var s = shipDataMap[selectedMmsi];
                        var t = shipDataMap[nv.mmsi];
                        if (!s || !t) return Cesium.Cartesian3.fromDegrees(0, 0);
                        var c = computeCpa(s, t);
                        return Cesium.Cartesian3.fromDegrees(c.lng, c.lat);
                    }, false),
                    ellipse: {
                        semiMajorAxis: new Cesium.CallbackProperty(function() {
                            var s = shipDataMap[selectedMmsi];
                            var t = shipDataMap[nv.mmsi];
                            if (!s || !t) return 200;
                            var c = computeCpa(s, t);
                            return Math.max(c.dcpaNm * 1852, 200);
                        }, false),
                        semiMinorAxis: new Cesium.CallbackProperty(function() {
                            var s = shipDataMap[selectedMmsi];
                            var t = shipDataMap[nv.mmsi];
                            if (!s || !t) return 200;
                            var c = computeCpa(s, t);
                            return Math.max(c.dcpaNm * 1852, 200);
                        }, false),
                        material: new Cesium.ColorMaterialProperty(
                            new Cesium.CallbackProperty(function() {
                                var pulse = 0.08 + 0.07 * Math.abs(Math.sin(Date.now() / 800));
                                return color.cesium.withAlpha(pulse);
                            }, false)
                        ),
                        outline: true,
                        outlineColor: color.cesium.withAlpha(0.5),
                        outlineWidth: 1
                    }
                });
            }
        }
    });
}
window.renderProximityLines = renderProximityLines;

function renderNearbyPanel(nearbyVessels) {
    var section = document.getElementById('nearbyVesselsSection');
    var list = document.getElementById('nearbyVesselsList');

    if (nearbyVessels.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    var hasMlMatches = nearbyVessels.some(function(nv) { return nv.mlRiskLevel != null && nv.mlRiskLevel > 0; });
    var mlIndicator = document.getElementById('nearbyMlIndicator');
    if (mlIndicator) mlIndicator.style.display = hasMlMatches ? 'inline' : 'none';
    list.innerHTML = nearbyVessels.map(function(nv) {
        var isCollisionTarget = collisionTargetMmsi != null && (nv.mmsi == collisionTargetMmsi);
        var hasMlRisk = nv.mlRiskLevel != null && nv.mlRiskLevel > 0;
        var mlColor = hasMlRisk ? ML_RISK_COLORS[nv.mlRiskLevel] : null;
        var color = hasMlRisk
            ? { css: mlColor }
            : isCollisionTarget
                ? { css: '#f43f5e' }
                : proximityColor(nv.distance);
        var ML_BADGE_COLORS = { 3: '#a855f7', 2: '#8b5cf6', 1: '#a78bfa' };
        var mlBadgeColor = hasMlRisk ? (ML_BADGE_COLORS[nv.mlRiskLevel] || '#a855f7') : null;

        var hasDistRisk = nv.distSeverity != null;
        var DIST_SEVERITY_COLORS = { danger: '#f43f5e', warning: '#f97316' };
        var distColor = hasDistRisk ? (DIST_SEVERITY_COLORS[nv.distSeverity] || '#f97316') : null;
        var highlight = hasMlRisk
            ? 'background:' + mlBadgeColor + '15;border:1px solid ' + mlBadgeColor + '40;border-radius:6px;'
            : hasDistRisk
                ? 'background:' + distColor + '15;border:1px solid ' + distColor + '40;border-radius:6px;'
                : isCollisionTarget
                    ? 'background:rgba(244,63,94,0.15);border:1px solid rgba(244,63,94,0.3);border-radius:6px;'
                    : '';
        var mlBadge = hasMlRisk
            ? '<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:' + mlBadgeColor + '25;color:' + mlBadgeColor + ';font-weight:600;flex-shrink:0;">AI \uc608\uce21 ' + nv.mlRiskLabel + '</span>'
            : '';
        var DIST_BADGE_LABELS = { '\uc704\ud5d8': '\uc704\ud5d8', '\uacbd\uace0': '\uacbd\uace0' };
        var distBadge = hasDistRisk
            ? '<span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:' + distColor + '25;color:' + distColor + ';font-weight:600;flex-shrink:0;">\uac70\ub9ac \uae30\ubc18 \uc811\uadfc ' + nv.distRiskLabel + '</span>'
            : '';
        var anyRisk = hasMlRisk || hasDistRisk || isCollisionTarget;
        return '<div class="nearby-row" data-mmsi="' + nv.mmsi + '" data-lat="' + nv.lat + '" data-lng="' + nv.lng + '" style="' + highlight + '">\
            <span class="nearby-dot" style="background:' + color.css + '"></span>\
            <span class="nearby-name">' + (anyRisk ? '\u26a0 ' : '') + nv.name + '</span>\
            ' + mlBadge + distBadge + '\
            <span class="nearby-dist" style="' + (anyRisk ? 'color:' + color.css + ';font-weight:700;' : '') + '">' + nv.distance.toFixed(1) + ' nm</span>\
        </div>';
    }).join('');

    list.querySelectorAll('.nearby-row').forEach(function(row) {
        row.addEventListener('click', function() {
            var lat = parseFloat(row.dataset.lat);
            var lng = parseFloat(row.dataset.lng);
            smoothFlyTo({
                destination: Cesium.Cartesian3.fromDegrees(lng, lat, 50000)
            });
        });
    });

    if (currentMapMode === '2d') {
        setTimeout(function() { syncProximityToLeaflet(); }, 50);
    }
}
window.renderNearbyPanel = renderNearbyPanel;

function clearProximity() {
    selectedProximityMmsi = null;
    collisionTargetMmsi = null;
    proximityMissCount = 0;
    proximityDataSource.entities.removeAll();
    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }
    var section = document.getElementById('nearbyVesselsSection');
    if (section) section.style.display = 'none';
}
window.clearProximity = clearProximity;

var _proximityRunning = false;
async function updateProximity() {
    if (!selectedProximityMmsi || timeMode !== 'live') {
        clearProximity();
        return;
    }
    if (!latestWsShipsMmsis.has(selectedProximityMmsi)) {
        proximityMissCount++;
        if (proximityMissCount >= 2) {
            clearProximity();
        }
        return;
    }
    proximityMissCount = 0;
    if (_proximityRunning) return;
    _proximityRunning = true;
    try {
        var mmsi = selectedProximityMmsi;
        var nearby = await findNearbyVessels(mmsi, PROXIMITY_RADIUS_NM, PROXIMITY_MAX_COUNT);
        if (mmsi !== selectedProximityMmsi) return;
        enrichNearbyWithMlRisk(mmsi, nearby);
        renderProximityLines(mmsi, nearby);
        renderNearbyPanel(nearby);
    } finally {
        _proximityRunning = false;
    }
}
window.updateProximity = updateProximity;
