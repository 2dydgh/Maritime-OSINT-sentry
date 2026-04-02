// ── Maritime OSINT Sentry — Collision Analysis Panel ──

// ── 해역명 판별 (좌표 → 해역/지역명) ──
var _seaAreas = [
    // 한반도 주변 해역 (좁은 영역 → 넓은 영역 순서)
    { name: '제주해협',       latMin: 33.0, latMax: 34.0, lngMin: 125.5, lngMax: 127.5 },
    { name: '대한해협',       latMin: 33.5, latMax: 35.0, lngMin: 128.0, lngMax: 130.0 },
    { name: '대한해협',       latMin: 33.0, latMax: 34.5, lngMin: 127.5, lngMax: 130.0 },
    { name: '울산 앞바다',    latMin: 35.0, latMax: 36.0, lngMin: 129.2, lngMax: 130.0 },
    { name: '부산 앞바다',    latMin: 34.8, latMax: 35.3, lngMin: 128.8, lngMax: 129.5 },
    { name: '여수 앞바다',    latMin: 34.3, latMax: 34.9, lngMin: 127.3, lngMax: 128.0 },
    { name: '목포 앞바다',    latMin: 34.3, latMax: 34.9, lngMin: 125.5, lngMax: 126.5 },
    { name: '인천 앞바다',    latMin: 37.0, latMax: 37.8, lngMin: 125.5, lngMax: 126.5 },
    { name: '남해',           latMin: 33.0, latMax: 35.0, lngMin: 126.0, lngMax: 129.5 },
    { name: '서해 (황해)',    latMin: 33.0, latMax: 40.0, lngMin: 119.0, lngMax: 126.5 },
    { name: '동해 (울릉도)',  latMin: 37.0, latMax: 38.0, lngMin: 130.5, lngMax: 131.5 },
    { name: '동해 (독도)',    latMin: 37.0, latMax: 37.5, lngMin: 131.5, lngMax: 132.0 },
    { name: '동해',           latMin: 35.0, latMax: 43.0, lngMin: 129.0, lngMax: 138.0 },
    // 일본
    { name: '쓰시마해협',     latMin: 33.5, latMax: 34.5, lngMin: 129.0, lngMax: 131.0 },
    { name: '쓰가루해협',     latMin: 41.0, latMax: 42.0, lngMin: 139.0, lngMax: 141.5 },
    { name: '도쿄만',         latMin: 35.0, latMax: 35.8, lngMin: 139.5, lngMax: 140.2 },
    { name: '일본 동해안',    latMin: 33.0, latMax: 46.0, lngMin: 138.0, lngMax: 146.0 },
    // 중국
    { name: '보하이만',       latMin: 37.5, latMax: 41.0, lngMin: 117.5, lngMax: 122.0 },
    { name: '타이완해협',     latMin: 22.0, latMax: 26.0, lngMin: 117.0, lngMax: 121.0 },
    { name: '동중국해',       latMin: 25.0, latMax: 33.0, lngMin: 120.0, lngMax: 130.0 },
    // 동남아
    { name: '말라카해협',     latMin: 0.5,  latMax: 4.5,  lngMin: 99.0,  lngMax: 104.5 },
    { name: '남중국해',       latMin: 3.0,  latMax: 23.0, lngMin: 105.0, lngMax: 121.0 },
    { name: '필리핀해',       latMin: 5.0,  latMax: 20.0, lngMin: 121.0, lngMax: 135.0 },
    // 중동
    { name: '호르무즈해협',   latMin: 25.5, latMax: 27.0, lngMin: 55.5,  lngMax: 57.0 },
    { name: '페르시아만',     latMin: 24.0, latMax: 30.5, lngMin: 48.0,  lngMax: 56.5 },
    { name: '아덴만',         latMin: 11.0, latMax: 15.5, lngMin: 43.0,  lngMax: 51.0 },
    { name: '홍해',           latMin: 12.5, latMax: 30.0, lngMin: 32.0,  lngMax: 44.0 },
    { name: '수에즈운하',     latMin: 29.8, latMax: 31.3, lngMin: 32.2,  lngMax: 32.6 },
    { name: '아라비아해',     latMin: 8.0,  latMax: 25.0, lngMin: 51.0,  lngMax: 75.0 },
    // 유럽
    { name: '영국해협',       latMin: 49.5, latMax: 51.5, lngMin: -2.0,  lngMax: 2.0 },
    { name: '지브롤터해협',   latMin: 35.5, latMax: 36.5, lngMin: -6.0,  lngMax: -5.0 },
    { name: '지중해',         latMin: 30.0, latMax: 46.0, lngMin: -6.0,  lngMax: 36.0 },
    { name: '발트해',         latMin: 53.0, latMax: 66.0, lngMin: 10.0,  lngMax: 30.0 },
    { name: '북해',           latMin: 51.0, latMax: 62.0, lngMin: -5.0,  lngMax: 10.0 },
    // 대양
    { name: '북태평양',       latMin: 0.0,  latMax: 60.0, lngMin: 120.0, lngMax: 180.0 },
    { name: '북태평양',       latMin: 0.0,  latMax: 60.0, lngMin: -180.0,lngMax: -100.0 },
    { name: '남태평양',       latMin: -60.0,latMax: 0.0,  lngMin: 120.0, lngMax: 180.0 },
    { name: '인도양',         latMin: -40.0,latMax: 25.0, lngMin: 20.0,  lngMax: 120.0 },
    { name: '대서양',         latMin: -60.0,latMax: 65.0, lngMin: -80.0, lngMax: 0.0 },
];

function getSeaAreaName(lat, lng) {
    for (var i = 0; i < _seaAreas.length; i++) {
        var a = _seaAreas[i];
        if (lat >= a.latMin && lat <= a.latMax && lng >= a.lngMin && lng <= a.lngMax) {
            return a.name;
        }
    }
    // 폴백: 위도/경도 기반 일반 표기
    var ns = lat >= 0 ? 'N' : 'S';
    var ew = lng >= 0 ? 'E' : 'W';
    return Math.abs(lat).toFixed(0) + '\u00b0' + ns + ' ' + Math.abs(lng).toFixed(0) + '\u00b0' + ew + ' 해역';
}

function collisionLocationHtml(latA, lngA, latB, lngB) {
    var midLat = (latA + latB) / 2;
    var midLng = (lngA + lngB) / 2;
    var area = getSeaAreaName(midLat, midLng);
    var coord = midLat.toFixed(2) + ', ' + midLng.toFixed(2);
    return '<div class="collision-location"><i class="fa-solid fa-location-dot"></i> ' + area + ' <span class="loc-coord">(' + coord + ')</span></div>';
}

function switchCollisionTab(tab) {
    collisionActiveTab = tab;
    document.querySelectorAll('.collision-tab-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderCollisionList();
}
window.switchCollisionTab = switchCollisionTab;

// Bind collision tab buttons (with null guards for restructured DOM)
var tabDist = document.getElementById('collisionTabDistance');
var tabMl = document.getElementById('collisionTabMl');
if (tabDist) tabDist.addEventListener('click', function() { switchCollisionTab('distance'); });
if (tabMl) tabMl.addEventListener('click', function() { switchCollisionTab('ml'); });

function collisionSeverityBadge(severity) {
    var colors = { danger: '#f43f5e', warning: '#eab308' };
    var labels = { danger: '\u26A0 위험', warning: '\u25B2 주의' };
    var bg = severity === 'danger' ? 'rgba(244,63,94,0.2)' : 'rgba(234,179,8,0.2)';
    return '<span class="collision-badge" style="background:' + bg + ';color:' + colors[severity] + '">' + labels[severity] + '</span>';
}

function mlRiskBadge(level, label) {
    var colors = { 0: '#10b981', 1: '#eab308', 2: '#f97316', 3: '#f43f5e' };
    var bgs = { 0: 'rgba(16,185,129,0.2)', 1: 'rgba(234,179,8,0.2)', 2: 'rgba(249,115,22,0.2)', 3: 'rgba(244,63,94,0.2)' };
    var icons = { 0: '\u24EA', 1: '\u2460', 2: '\u2461', 3: '\u2462' };
    return '<span class="collision-badge" style="background:' + bgs[level] + ';color:' + colors[level] + '">' + icons[level] + ' ' + label + '</span>';
}

function _renderCollisionTicker(list, cardsHtml, count) {
    // 콘텐츠가 동일하면 DOM 재구성 건너뛰기 (깜빡임 방지)
    if (list._prevHtml === cardsHtml) return;
    list._prevHtml = cardsHtml;

    // 스크롤 위치 보존
    var prevScroll = list.scrollTop;
    list.innerHTML = cardsHtml;
    list.scrollTop = prevScroll;
}

// 이벤트 위임: collisionList에 한 번만 등록
var _collisionDelegated = false;
function _ensureCollisionDelegation() {
    if (_collisionDelegated) return;
    _collisionDelegated = true;
    var list = document.getElementById('collisionList');
    if (!list) return;
    list.addEventListener('click', function(e) {
        var card = e.target.closest('.collision-row');
        if (!card) return;
        _handleCollisionCardClick(card);
    });
}

function renderCollisionList() {
    var list = document.getElementById('collisionList');
    var fixedSummary = document.getElementById('mlRiskSummaryFixed');
    if (!list) return;
    var data = collisionActiveTab === 'distance' ? collisionData.distance : collisionData.ml;
    var risks = data.risks || [];

    // Update drawer summary bar
    var summaryStats = document.getElementById('drawerSummaryStats');
    var summaryCount = document.getElementById('collision-count-summary');
    if (summaryStats && summaryCount) {
        animateCount(summaryCount, risks.length);
        var dangerN, warnN, cautionN;
        var dangerLabel, warnLabel, cautionLabel;
        if (collisionActiveTab === 'ml') {
            var countByLevel = { 1: 0, 2: 0, 3: 0 };
            risks.forEach(function(r) { if (countByLevel[r.risk_level] !== undefined) countByLevel[r.risk_level]++; });
            dangerN = countByLevel[3]; warnN = countByLevel[2]; cautionN = countByLevel[1];
            dangerLabel = '위험'; warnLabel = '경고'; cautionLabel = '주의';
        } else {
            dangerN = risks.filter(function(r) { return r.severity === 'high' || r.severity === 'danger'; }).length;
            warnN = risks.filter(function(r) { return r.severity === 'medium' || r.severity === 'warning'; }).length;
            cautionN = risks.length - dangerN - warnN;
            dangerLabel = '고위험'; warnLabel = '경고'; cautionLabel = '주의';
        }
        function pill(cls, label, count) {
            var zero = count === 0 ? ' s-zero' : '';
            return '<span class="s-pill ' + cls + zero + '" title="' + label + ' ' + count + '">' +
                '<span class="s-dot"></span><span class="s-count">' + count + '</span></span>';
        }
        summaryStats.innerHTML = pill('s-danger', dangerLabel, dangerN) + pill('s-warn', warnLabel, warnN) + pill('s-caution', cautionLabel, cautionN);

        // Bottom bar risk update — always use ML data
        if (typeof BottomBar !== 'undefined') {
            var mlRisks = (collisionData.ml && collisionData.ml.risks) || [];
            var mlByLevel = { 1: 0, 2: 0, 3: 0 };
            mlRisks.forEach(function(r) { if (mlByLevel[r.risk_level] !== undefined) mlByLevel[r.risk_level]++; });
            BottomBar.updateValue('bottomRisk', mlRisks.length);
            BottomBar.updateRiskLevels(mlByLevel[3], mlByLevel[2], mlByLevel[1]);
        }
    }

    // ML serious risks (level >= 2) — used for both badge and HUD
    var mlSerious = (collisionData.ml?.risks || []).filter(function(r) { return r.risk_level >= 2; }).length;

    // Update icon rail badge
    var badge = document.getElementById('collisionBadge');
    if (badge) {
        if (mlSerious > 0) {
            badge.style.display = '';
            badge.textContent = mlSerious;
        } else {
            badge.style.display = 'none';
        }
    }
    // HUD
    var hudCol = document.getElementById('hudCollision');
    if (hudCol) hudCol.textContent = mlSerious;

    if (collisionActiveTab !== 'ml' && fixedSummary) {
        fixedSummary.style.display = 'none';
        fixedSummary.innerHTML = '';
    }

    if (risks.length === 0) {
        list.innerHTML = '<div class="collision-empty">\ucda9\ub3cc \uc704\ud5d8 \uc5c6\uc74c</div>';
        return;
    }

    function _seaAreaShort(latA, lngA, latB, lngB) {
        var midLat = (latA + latB) / 2;
        var midLng = (lngA + lngB) / 2;
        return getSeaAreaName(midLat, midLng);
    }

    if (collisionActiveTab === 'distance') {
        var rowsHtml = risks.map(function(r) { return '\
            <div class="collision-row"\
                 data-mmsi-a="' + r.ship_a.mmsi + '" data-mmsi-b="' + r.ship_b.mmsi + '"\
                 data-lat-a="' + r.ship_a.lat + '" data-lng-a="' + r.ship_a.lng + '" data-lat-b="' + r.ship_b.lat + '" data-lng-b="' + r.ship_b.lng + '">\
                <span class="col-severity">' + collisionSeverityBadge(r.severity) + '</span>\
                <span class="col-pairs">' + r.ship_a.name + ' <small>\u2192</small> ' + r.ship_b.name + '</span>\
                <span class="col-area">' + _seaAreaShort(r.ship_a.lat, r.ship_a.lng, r.ship_b.lat, r.ship_b.lng) + '</span>\
            </div>';
        }).join('');
        _renderCollisionTicker(list, rowsHtml, risks.length);
    } else {
        var countByLevel = { 1: 0, 2: 0, 3: 0 };
        risks.forEach(function(r) { if (countByLevel[r.risk_level] !== undefined) countByLevel[r.risk_level]++; });

        var isActive = function(lvl) { return mlRiskFilter === lvl ? 'active' : ''; };
        var isDefaultActive = mlRiskFilter === null ? 'active' : '';

        if (fixedSummary) {
        fixedSummary.style.display = 'block';
        fixedSummary.innerHTML = '\
            <div class="ml-risk-summary">\
                <div class="risk-stat ' + isActive(3) + '" data-risk-filter="3" style="--stat-color: #f43f5e; --stat-bg: rgba(244,63,94,0.15);">\
                    <span class="risk-stat-count">' + countByLevel[3] + '</span>\
                    <span class="risk-stat-label">\uc704\ud5d8</span>\
                </div>\
                <div class="risk-stat ' + isActive(2) + '" data-risk-filter="2" style="--stat-color: #f97316; --stat-bg: rgba(249,115,22,0.15);">\
                    <span class="risk-stat-count">' + countByLevel[2] + '</span>\
                    <span class="risk-stat-label">\uacbd\uace0</span>\
                </div>\
                <div class="risk-stat ' + isActive(1) + '" data-risk-filter="1" style="--stat-color: #eab308; --stat-bg: rgba(234,179,8,0.15);">\
                    <span class="risk-stat-count">' + countByLevel[1] + '</span>\
                    <span class="risk-stat-label">\uc8fc\uc758</span>\
                </div>\
                <div class="risk-stat ' + isDefaultActive + '" data-risk-filter="all" style="--stat-color: var(--text-dim); --stat-bg: rgba(255,255,255,0.08);">\
                    <span class="risk-stat-count">' + risks.length + '</span>\
                    <span class="risk-stat-label">\uc804\uccb4</span>\
                </div>\
            </div>';

        fixedSummary.querySelectorAll('.risk-stat[data-risk-filter]').forEach(function(stat) {
            stat.addEventListener('click', function() {
                var val = stat.dataset.riskFilter;
                if (val === 'all') {
                    mlRiskFilter = null;
                } else {
                    var lvl = parseInt(val);
                    mlRiskFilter = mlRiskFilter === lvl ? null : lvl;
                }
                renderCollisionList();
            });
        });
        } // end if (fixedSummary)

        var filtered = mlRiskFilter === null
            ? risks.filter(function(r) { return r.risk_level >= 2; })
            : risks.filter(function(r) { return r.risk_level === mlRiskFilter; });

        if (filtered.length === 0) {
            list.innerHTML = '<div class="collision-empty">\ud574\ub2f9 \ub4f1\uae09\uc758 \uc704\ud5d8\uc774 \uc5c6\uc2b5\ub2c8\ub2e4</div>';
        } else {
            var mlRowsHtml = filtered.map(function(r) { return '\
                <div class="collision-row"\
                     data-mmsi-a="' + r.ship_a.mmsi + '" data-mmsi-b="' + r.ship_b.mmsi + '"\
                     data-lat-a="' + r.ship_a.lat + '" data-lng-a="' + r.ship_a.lng + '" data-lat-b="' + r.ship_b.lat + '" data-lng-b="' + r.ship_b.lng + '"\
                     data-sog-a="' + r.ship_a.sog + '" data-cog-a="' + r.ship_a.cog + '" data-name-a="' + r.ship_a.name + '"\
                     data-risk-level="' + r.risk_level + '">\
                    <span class="col-severity">' + mlRiskBadge(r.risk_level, r.risk_label) + '</span>\
                    <span class="col-pairs">' + r.ship_a.name + ' <small>\u2192</small> ' + r.ship_b.name + '</span>\
                    <span class="col-area">' + _seaAreaShort(r.ship_a.lat, r.ship_a.lng, r.ship_b.lat, r.ship_b.lng) + '</span>\
                </div>';
            }).join('');
            _renderCollisionTicker(list, mlRowsHtml, filtered.length);
        }
    }

    _ensureCollisionDelegation();
}

function _handleCollisionCardClick(card) {
    // Collision card selection highlight
    document.querySelectorAll('.collision-row.selected').forEach(function(c) { c.classList.remove('selected'); });
    card.classList.add('selected');

    var mmsiA = Number(card.dataset.mmsiA);
    var mmsiB = Number(card.dataset.mmsiB);

    // 실시간 위치 우선 사용, 없으면 카드 스냅샷 사용
    var shipA = shipDataMap[mmsiA] || shipDataMap[String(mmsiA)];
    var shipB = shipDataMap[mmsiB] || shipDataMap[String(mmsiB)];
    var latA = shipA ? shipA.lat : parseFloat(card.dataset.latA);
    var lngA = shipA ? shipA.lng : parseFloat(card.dataset.lngA);
    var latB = shipB ? shipB.lat : parseFloat(card.dataset.latB);
    var lngB = shipB ? shipB.lng : parseFloat(card.dataset.lngB);

    var midLat = (latA + latB) / 2;
    var midLng = (lngA + lngB) / 2;
    smoothFlyTo({
        destination: Cesium.Cartesian3.fromDegrees(midLng, midLat, 15000)
    });

    if (collisionActiveTab === 'ml') {
        // AI 분석 탭: 해당 두 선박만 표시 (근접 선박 전체 X)
        selectedProximityMmsi = null;
        collisionTargetMmsi = mmsiB;
        var distNm = haversineNm(latA, lngA, latB, lngB);
        var riskLevel = parseInt(card.dataset.riskLevel) || 1;
        // shipDataMap에 선박이 없을 때를 대비해 _selData fallback 포함
        var selFallback = { lat: latA, lng: lngA, sog: parseFloat(card.dataset.sogA) || 0, cog: parseFloat(card.dataset.cogA) || 0, name: card.dataset.nameA || '' };
        renderProximityLines(mmsiA, [{
            mmsi: mmsiB,
            lat: latB,
            lng: lngB,
            distance: distNm,
            mlRiskLevel: riskLevel,
            _selData: selFallback
        }]);
        renderNearbyPanel([]);
    } else {
        // 거리 기반 탭: 근접 선박 전체 표시
        collisionTargetMmsi = mmsiB;
        selectedProximityMmsi = mmsiA;
        proximityMissCount = 0;
        updateProximity();
    }

    // 충돌 쌍 자동 추적 시작 (카메라 따라가기 + 위험 해제 감지)
    _collisionTrackingActive = true;
    startCollisionTracking(mmsiA, mmsiB);

    if (shipA) {
        showShipInfo(mmsiA);
        highlightShip(mmsiA);
    }
}

// ── 충돌 쌍 상태 (카메라 추적과 분리) ──
// 충돌 페어 MMSI — clearProximity()에서만 초기화됨
var _collisionPairMmsiA = null;
var _collisionPairMmsiB = null;

// ── 충돌 쌍 자동 추적 (Auto-follow) ──
var _collisionTrackingTimer = null;

function startCollisionTracking(mmsiA, mmsiB) {
    stopCollisionTracking();
    _collisionPairMmsiA = mmsiA;
    _collisionPairMmsiB = mmsiB;
    _collisionTrackingTimer = setInterval(function() {
        var shipA = shipDataMap[_collisionPairMmsiA] || shipDataMap[String(_collisionPairMmsiA)];
        var shipB = shipDataMap[_collisionPairMmsiB] || shipDataMap[String(_collisionPairMmsiB)];
        if (!shipA || !shipB) { stopCollisionTracking(); return; }

        // 카메라 높이 50km 이하일 때만 자동 추적 (확대 상태)
        var camHeight = viewer.camera.positionCartographic.height;
        if (camHeight > 50000) return;

        var midLat = (shipA.lat + shipB.lat) / 2;
        var midLng = (shipA.lng + shipB.lng) / 2;

        // 현재 카메라 중심과 선박 중점 간 거리 확인
        var camCart = viewer.camera.positionCartographic;
        var camLat = Cesium.Math.toDegrees(camCart.latitude);
        var camLng = Cesium.Math.toDegrees(camCart.longitude);
        var driftNm = haversineNm(camLat, camLng, midLat, midLng);

        // 화면 기준으로 벗어났을 때만 부드럽게 이동
        var thresholdNm = Math.max(camHeight / 1852 * 0.15, 0.3);
        if (driftNm > thresholdNm) {
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(midLng, midLat, camHeight),
                duration: 1.0,
                easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
            });
        }
    }, 3000);
}
window.startCollisionTracking = startCollisionTracking;

function stopCollisionTracking() {
    if (_collisionTrackingTimer) {
        clearInterval(_collisionTrackingTimer);
        _collisionTrackingTimer = null;
    }
    // 카메라 추적만 중지 — 충돌 페어 MMSI는 유지
}
window.stopCollisionTracking = stopCollisionTracking;

function clearCollisionPair() {
    stopCollisionTracking();
    _collisionPairMmsiA = null;
    _collisionPairMmsiB = null;
}
window.clearCollisionPair = clearCollisionPair;

async function fetchCollisionRisks() {
    try {
        var resp = await fetch('/api/v1/collision/risks');
        if (!resp.ok) return;
        collisionData = await resp.json();
        renderCollisionList();

        var mlSerious = (collisionData.ml?.risks || []).filter(function(r) { return r.risk_level >= 2; }).length;
        var total = (collisionData.distance?.total || 0) + mlSerious;
        var badge = document.getElementById('collision-count');
        if (badge) animateCount(badge, total);

        // Update header collision risk counts
        _updateHeaderCollisionStats();

        // 추적 중인 충돌 쌍이 위험 목록에서 사라졌는지 확인
        if (typeof checkCollisionResolution === 'function') checkCollisionResolution();
    } catch (e) {
        console.warn('Collision fetch failed:', e);
    }
}
window.fetchCollisionRisks = fetchCollisionRisks;

function _updateHeaderCollisionStats() {
    // Removed — stats now only shown in drawer header pills
}
