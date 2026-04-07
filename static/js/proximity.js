// ── Maritime OSINT Sentry — Vessel Proximity & CPA ──

function _showCollisionToast(title, message) {
    var container = document.getElementById('cesiumContainer') || document.body;
    // cesiumContainer가 relative/absolute가 아닐 수 있으므로 보장
    if (container.id === 'cesiumContainer' && getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
    }
    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:99999;' +
        'background:rgba(16,185,129,0.92);color:#fff;padding:6px 14px;border-radius:6px;' +
        'font:500 11px/1.3 "Pretendard Variable","Inter",sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.3);' +
        'backdrop-filter:blur(8px);pointer-events:none;opacity:0;transition:opacity 0.3s;max-width:360px;text-align:center;';
    el.innerHTML = '<div>' + title + '</div>' +
        '<div style="font-weight:400;opacity:0.85;">' + message + '</div>';
    container.appendChild(el);
    requestAnimationFrame(function() { el.style.opacity = '1'; });
    setTimeout(function() {
        el.style.opacity = '0';
        setTimeout(function() { el.remove(); }, 300);
    }, 4000);
}
window._showCollisionToast = _showCollisionToast;

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
    // 중립 색상 — 가까울수록 약간 밝게, 위험 표시는 risk 매칭으로만
    if (distNm < 2) return { css: '#94a3b8', cesium: Cesium.Color.fromCssColorString('#94a3b8') };
    if (distNm < 5) return { css: '#64748b', cesium: Cesium.Color.fromCssColorString('#64748b') };
    return { css: '#475569', cesium: Cesium.Color.fromCssColorString('#475569') };
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

    var DIST_SEVERITY_LABELS = { danger: '\uc704\ud5d8', caution: '\uacbd\uace0', warning: '\uc8fc\uc758' };

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
    if (proximityDataSource) proximityDataSource.entities.removeAll();
    proximityMap = {};

    // 2D Leaflet 클리어 (기존 로직 유지)
    if (currentMapMode === '2d' && leafletMap) {
        Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
        leafletCollisionLines = {};
    }

    var selected = shipDataMap[selectedMmsi] || shipDataMap[String(selectedMmsi)];
    if (nearbyVessels.length === 0) { console.warn('[proximity] renderLines: empty nearbyVessels'); return; }
    if (!selected) console.warn('[proximity] renderLines: selected ship NOT in shipDataMap, mmsi=', selectedMmsi);

    var closestMmsi = nearbyVessels[0].mmsi;
    var _linesAdded = 0;

    var DIST_SEV_COLORS = { danger: '#f43f5e', caution: '#f97316', warning: '#eab308' };

    nearbyVessels.forEach(function(nv) {
        var isCollisionTarget = collisionTargetMmsi != null && (nv.mmsi == collisionTargetMmsi);
        var isMlPair = nv.mlRiskLevel != null && nv.mlRiskLevel > 0;
        var isDistPair = nv.distSeverity != null;
        var isRiskPair = isMlPair || isDistPair;

        var color;
        if (isMlPair) {
            color = mlRiskColor(nv.mlRiskLevel);
        } else if (isDistPair) {
            var dc = DIST_SEV_COLORS[nv.distSeverity] || '#f97316';
            color = { css: dc, cesium: Cesium.Color.fromCssColorString(dc) };
        } else if (isCollisionTarget) {
            color = { css: '#f43f5e', cesium: Cesium.Color.fromCssColorString('#f43f5e') };
        } else {
            color = proximityColor(nv.distance);
        }
        var isHighlight = isRiskPair || isCollisionTarget;
        var showCollisionViz = isRiskPair || isCollisionTarget;

        // shipDataMap 우선, 없으면 nv에 포함된 좌표를 fallback으로 사용
        var sel = selected || (nv._selData ? nv._selData : null);
        var tgt = shipDataMap[nv.mmsi] || shipDataMap[String(nv.mmsi)]
            || (nv.lat != null ? { lat: nv.lat, lng: nv.lng, sog: 0, cog: 0, name: '' } : null);
        if (!sel || !tgt) { console.warn('[proximity] renderLines skip: sel=', !!sel, 'tgt=', !!tgt, 'mmsi=', nv.mmsi); return; }

        // 근접 라인 — PolylineCollection (높이 10m, 해수면 바로 위)
        var lineWidth = isRiskPair ? 4 : isCollisionTarget ? 4 : 1.5;
        var lineColor = isHighlight ? color.cesium.withAlpha(0.8) : color.cesium.withAlpha(0.35);

        var line = proximityLines.add({
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                sel.lng, sel.lat, 100, tgt.lng, tgt.lat, 100
            ]),
            width: lineWidth,
            material: Cesium.Material.fromType('Color', { color: lineColor })
        });
        _linesAdded++;

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
                    sel.lng, sel.lat, 100, selEnd.lng, selEnd.lat, 100
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
                    tgt.lng, tgt.lat, 100, tgtEnd.lng, tgtEnd.lat, 100
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

    if (_linesAdded === 0 && nearbyVessels.length > 0) {
        console.warn('[proximity] renderLines: 0 lines added for', nearbyVessels.length, 'vessels! proximityLines.length=', proximityLines.length);
    } else {
        console.info('[proximity] renderLines:', _linesAdded, 'lines for', nearbyVessels.length, 'vessels');
    }

    // 2D 동기화
    if (currentMapMode === '2d') {
        setTimeout(function() { if (typeof syncProximityToLeaflet === 'function') syncProximityToLeaflet(); }, 50);
    }
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
        var hasDistRiskDot = nv.distSeverity != null;
        var DIST_DOT_COLORS = { danger: '#f43f5e', caution: '#f97316', warning: '#eab308' };
        var color = hasMlRisk
            ? { css: ML_RISK_COLORS[nv.mlRiskLevel] }
            : hasDistRiskDot
                ? { css: DIST_DOT_COLORS[nv.distSeverity] || '#f97316' }
                : isCollisionTarget
                    ? { css: '#f43f5e' }
                    : { css: '#64748b' };
        var ML_RISK_BADGE = { 3: { color: '#f43f5e', bg: 'rgba(244,63,94,0.2)' }, 2: { color: '#f97316', bg: 'rgba(249,115,22,0.2)' }, 1: { color: '#eab308', bg: 'rgba(234,179,8,0.2)' } };
        var mlBadgeStyle = hasMlRisk ? ML_RISK_BADGE[nv.mlRiskLevel] || ML_RISK_BADGE[1] : null;

        var hasDistRisk = nv.distSeverity != null;
        var DIST_RISK_BADGE = { danger: { color: '#f43f5e', bg: 'rgba(244,63,94,0.2)' }, caution: { color: '#f97316', bg: 'rgba(249,115,22,0.2)' }, warning: { color: '#eab308', bg: 'rgba(234,179,8,0.2)' } };
        var distBadgeStyle = hasDistRisk ? DIST_RISK_BADGE[nv.distSeverity] || DIST_RISK_BADGE['warning'] : null;

        var riskStyle = mlBadgeStyle || distBadgeStyle || null;
        var highlight = riskStyle
            ? 'background:' + riskStyle.bg + ';border:1px solid ' + riskStyle.color + '30;border-radius:6px;'
            : isCollisionTarget
                ? 'background:rgba(244,63,94,0.15);border:1px solid rgba(244,63,94,0.3);border-radius:6px;'
                : '';
        var mlBadge = hasMlRisk
            ? '<span class="collision-badge" style="background:' + mlBadgeStyle.bg + ';color:' + mlBadgeStyle.color + ';flex-shrink:0;">AI ' + nv.mlRiskLabel + '</span>'
            : '';
        var distBadge = hasDistRisk
            ? '<span class="collision-badge" style="background:' + distBadgeStyle.bg + ';color:' + distBadgeStyle.color + ';flex-shrink:0;">CPA ' + nv.distRiskLabel + '</span>'
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

    // 자동 추적 + 충돌 페어 초기화
    _collisionTrackingActive = false;
    if (typeof clearCollisionPair === 'function') clearCollisionPair();

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

        // 1단계: 후보를 즉시 렌더링 (land-check 없이)
        var candidates = findNearbyVesselsCandidates(mmsi, PROXIMITY_RADIUS_NM, PROXIMITY_MAX_COUNT);
        if (!candidates.selected || candidates.results.length === 0) {
            renderProximityLines(mmsi, []);
            renderNearbyPanel([]);
            return;
        }
        enrichNearbyWithMlRisk(mmsi, candidates.results);
        renderProximityLines(mmsi, candidates.results);
        renderNearbyPanel(candidates.results);

        // 2단계: land-check 비동기 후처리 (육지 차단 쌍 제거)
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

/**
 * 충돌 쌍이 백엔드 collision 데이터에서 사라졌는지 확인.
 * fetchCollisionRisks() 후 호출 — 10초마다.
 */
var _collisionTrackingActive = false;
window._collisionTrackingActive = _collisionTrackingActive;

function checkCollisionResolution() {
    if (!_collisionTrackingActive) return;
    var pairA = typeof _collisionPairMmsiA !== 'undefined' ? _collisionPairMmsiA : null;
    var pairB = collisionTargetMmsi;
    if (!pairA || !pairB) return;

    // 백엔드 collision 데이터에서 해당 쌍이 아직 존재하는지 확인
    var allRisks = [].concat(
        (collisionData.distance && collisionData.distance.risks) || [],
        (collisionData.ml && collisionData.ml.risks) || []
    );
    var stillAtRisk = allRisks.some(function(r) {
        return (r.ship_a.mmsi == pairA && r.ship_b.mmsi == pairB)
            || (r.ship_a.mmsi == pairB && r.ship_b.mmsi == pairA);
    });

    if (!stillAtRisk) {
        var selShip = shipDataMap[pairA] || shipDataMap[String(pairA)];
        var tgtShip = shipDataMap[pairB] || shipDataMap[String(pairB)];
        var nameA = (selShip && selShip.name) || String(pairA);
        var nameB = (tgtShip && tgtShip.name) || String(pairB);
        _showCollisionToast(
            '✓ 충돌 위험 해제',
            nameA + ' ↔ ' + nameB + ' — 더 이상 위험 목록에 없음'
        );
        clearProximity();
    }
}
window.checkCollisionResolution = checkCollisionResolution;
