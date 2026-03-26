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
    // Primitive Collections 클리어
    proximityLines.removeAll();
    proximityLabels.removeAll();
    proximityCogLines.removeAll();
    proximityCpaPoints.removeAll();
    proximityCpaLabels.removeAll();
    proximityMap = {};

    // 2D Leaflet 클리어 (기존 로직 유지)
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

        var sel = shipDataMap[selectedMmsi];
        var tgt = shipDataMap[nv.mmsi];
        if (!sel || !tgt) return;

        // 근접 라인
        var lineWidth = isMlPair ? 4 : isCollisionTarget ? 4 : isHighlight ? 3 : 2;
        var lineColor = isHighlight ? color.cesium.withAlpha(0.8) : color.cesium.withAlpha(0.6);

        var line = proximityLines.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                sel.lng, sel.lat, 50, tgt.lng, tgt.lat, 50
            ]),
            width: lineWidth,
            material: Cesium.Material.fromType('Color', { color: lineColor })
        });

        // 거리 라벨
        var dist = haversineNm(sel.lat, sel.lng, tgt.lat, tgt.lng);
        var prefix = (isMlPair || isCollisionTarget) ? '\u26a0 ' : '';
        var label = proximityLabels.add({
            position: Cesium.Cartesian3.fromDegrees(
                (sel.lng + tgt.lng) / 2,
                (sel.lat + tgt.lat) / 2
            ),
            text: prefix + dist.toFixed(1) + ' nm',
            font: isCollisionTarget ? 'bold 14px JetBrains Mono' : '12px JetBrains Mono',
            fillColor: color.cesium,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });

        var entry = { line: line, label: label };

        // 충돌 시각화 (COG + CPA)
        if (showCollisionViz) {
            // COG 프로젝션 — 선택 선박
            var selEnd = projectPosition(sel.lat, sel.lng, sel.cog || 0, Math.max((sel.sog || 0) / 60 * 10, 0.5));
            var cogSel = proximityCogLines.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    sel.lng, sel.lat, 50, selEnd.lng, selEnd.lat, 50
                ]),
                width: 2,
                material: Cesium.Material.fromType('PolylineDash', {
                    color: color.cesium.withAlpha(0.7),
                    dashLength: 12.0
                })
            });

            // COG 프로젝션 — 대상 선박
            var tgtEnd = projectPosition(tgt.lat, tgt.lng, tgt.cog || 0, Math.max((tgt.sog || 0) / 60 * 10, 0.5));
            var cogTgt = proximityCogLines.add({
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    tgt.lng, tgt.lat, 50, tgtEnd.lng, tgtEnd.lat, 50
                ]),
                width: 2,
                material: Cesium.Material.fromType('PolylineDash', {
                    color: color.cesium.withAlpha(0.7),
                    dashLength: 12.0
                })
            });

            entry.cogSel = cogSel;
            entry.cogTgt = cogTgt;

            // CPA 마커 + 라벨
            var cpa = computeCpa(sel, tgt);
            if (cpa.tcpaMin > 0 && cpa.tcpaMin < 60) {
                var cpaPoint = proximityCpaPoints.add({
                    position: Cesium.Cartesian3.fromDegrees(cpa.lng, cpa.lat),
                    pixelSize: 10,
                    color: color.cesium.withAlpha(0.9),
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                });

                var cpaLabel = proximityCpaLabels.add({
                    position: Cesium.Cartesian3.fromDegrees(cpa.lng, cpa.lat),
                    text: 'CPA ' + cpa.dcpaNm.toFixed(2) + 'nm\n' + cpa.tcpaMin.toFixed(1) + 'min',
                    font: 'bold 11px JetBrains Mono',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -20),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    showBackground: true,
                    backgroundColor: color.cesium.withAlpha(0.7)
                });

                entry.cpaPoint = cpaPoint;
                entry.cpaLabel = cpaLabel;
            }
        }

        proximityMap[nv.mmsi] = entry;
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

    // Primitive Collections 클리어
    if (proximityLines) proximityLines.removeAll();
    if (proximityLabels) proximityLabels.removeAll();
    if (proximityCogLines) proximityCogLines.removeAll();
    if (proximityCpaPoints) proximityCpaPoints.removeAll();
    if (proximityCpaLabels) proximityCpaLabels.removeAll();
    proximityMap = {};

    // 기존 DataSource도 클리어 (히스토리 모드 호환)
    if (proximityDataSource) proximityDataSource.entities.removeAll();

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
