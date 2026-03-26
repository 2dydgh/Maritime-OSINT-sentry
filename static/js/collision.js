// ── Maritime OSINT Sentry — Collision Analysis Panel ──

function switchCollisionTab(tab) {
    collisionActiveTab = tab;
    document.querySelectorAll('.collision-tab-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderCollisionList();
}
window.switchCollisionTab = switchCollisionTab;

// Bind collision tab buttons
document.getElementById('collisionTabDistance').addEventListener('click', function() { switchCollisionTab('distance'); });
document.getElementById('collisionTabMl').addEventListener('click', function() { switchCollisionTab('ml'); });

function collisionSeverityBadge(severity) {
    var colors = { danger: '#f43f5e', warning: '#eab308' };
    var labels = { danger: 'DANGER', warning: 'WARNING' };
    var bg = severity === 'danger' ? 'rgba(244,63,94,0.2)' : 'rgba(234,179,8,0.2)';
    return '<span class="collision-badge" style="background:' + bg + ';color:' + colors[severity] + '">' + labels[severity] + '</span>';
}

function mlRiskBadge(level, label) {
    var colors = { 0: '#10b981', 1: '#eab308', 2: '#f97316', 3: '#f43f5e' };
    var bgs = { 0: 'rgba(16,185,129,0.2)', 1: 'rgba(234,179,8,0.2)', 2: 'rgba(249,115,22,0.2)', 3: 'rgba(244,63,94,0.2)' };
    return '<span class="collision-badge" style="background:' + bgs[level] + ';color:' + colors[level] + '">' + level + ' \u2014 ' + label + '</span>';
}

function _renderCollisionTicker(list, cardsHtml, count) {
    list.innerHTML = cardsHtml;
    _startCollisionAutoScroll(list);
}

var _collisionScrollTimer = null;
var _collisionScrollPaused = false;
function _startCollisionAutoScroll(list) {
    if (_collisionScrollTimer) clearInterval(_collisionScrollTimer);
    list.onmouseenter = function() { _collisionScrollPaused = true; };
    list.onmouseleave = function() { _collisionScrollPaused = false; };
    _collisionScrollTimer = setInterval(function() {
        if (_collisionScrollPaused) return;
        var cards = list.querySelectorAll('.collision-card');
        if (cards.length <= 1) return;
        var nextTop = list.scrollTop + 120;
        if (nextTop >= list.scrollHeight - list.clientHeight - 10) {
            list.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            list.scrollBy({ top: 120, behavior: 'smooth' });
        }
    }, 5000);
}

function renderCollisionList() {
    var list = document.getElementById('collisionList');
    var fixedSummary = document.getElementById('mlRiskSummaryFixed');
    var data = collisionActiveTab === 'distance' ? collisionData.distance : collisionData.ml;
    var risks = data.risks || [];

    // Update drawer summary bar
    var summaryStats = document.getElementById('drawerSummaryStats');
    var summaryCount = document.getElementById('collision-count-summary');
    if (summaryStats && summaryCount) {
        summaryCount.textContent = risks.length;
        if (collisionActiveTab === 'ml') {
            var countByLevel = { 1: 0, 2: 0, 3: 0 };
            risks.forEach(function(r) { if (countByLevel[r.risk_level] !== undefined) countByLevel[r.risk_level]++; });
            summaryStats.innerHTML =
                '<span class="s-danger">\uc704\ud5d8 ' + countByLevel[3] + '</span>' +
                '<span class="s-warn">\uacbd\uace0 ' + countByLevel[2] + '</span>' +
                '<span class="s-caution">\uc8fc\uc758 ' + countByLevel[1] + '</span>';
        } else {
            var highCount = risks.filter(function(r) { return r.severity === 'high' || r.severity === 'danger'; }).length;
            var medCount = risks.filter(function(r) { return r.severity === 'medium' || r.severity === 'warning'; }).length;
            var lowCount = risks.length - highCount - medCount;
            summaryStats.innerHTML =
                '<span class="s-danger">\uace0\uc704\ud5d8 ' + highCount + '</span>' +
                '<span class="s-warn">\uacbd\uace0 ' + medCount + '</span>' +
                '<span class="s-caution">\uc8fc\uc758 ' + lowCount + '</span>';
        }
    }

    if (collisionActiveTab !== 'ml') {
        fixedSummary.style.display = 'none';
        fixedSummary.innerHTML = '';
    }

    if (risks.length === 0) {
        list.innerHTML = '<div class="collision-empty">\ucda9\ub3cc \uc704\ud5d8 \uc5c6\uc74c</div>';
        return;
    }

    function tcpaClass(t) { return t < 5 ? 'danger' : t < 10 ? 'warn' : ''; }
    function dcpaClass(d) { return d < 0.5 ? 'danger' : d < 1.0 ? 'warn' : ''; }
    function distClass(d) { return d < 1.0 ? 'danger' : d < 2.0 ? 'warn' : ''; }

    if (collisionActiveTab === 'distance') {
        var cardsHtml = risks.map(function(r) { return '\
            <div class="collision-card"\
                 data-mmsi-a="' + r.ship_a.mmsi + '" data-mmsi-b="' + r.ship_b.mmsi + '"\
                 data-lat-a="' + r.ship_a.lat + '" data-lng-a="' + r.ship_a.lng + '" data-lat-b="' + r.ship_b.lat + '" data-lng-b="' + r.ship_b.lng + '">\
                <div class="pair-header">\
                    ' + r.ship_a.name + ' <span style="color:var(--accent);">\u2194</span> ' + r.ship_b.name + '\
                    ' + collisionSeverityBadge(r.severity) + '\
                </div>\
                <div class="pair-detail">\
                    TCPA: ' + r.tcpa_min + 'min \u00b7 DCPA: ' + r.dcpa_nm + 'nm \u00b7 DIST: ' + r.current_dist_nm + 'nm\
                </div>\
            </div>';
        }).join('');
        _renderCollisionTicker(list, cardsHtml, risks.length);
    } else {
        var countByLevel = { 1: 0, 2: 0, 3: 0 };
        risks.forEach(function(r) { if (countByLevel[r.risk_level] !== undefined) countByLevel[r.risk_level]++; });

        var isActive = function(lvl) { return mlRiskFilter === lvl ? 'active' : ''; };
        var isDefaultActive = mlRiskFilter === null ? 'active' : '';

        fixedSummary.style.display = 'block';
        fixedSummary.innerHTML = '\
            <div class="ml-risk-summary">\
                <div class="risk-stat ' + isActive(3) + '" data-risk-filter="3" style="--stat-color: #f43f5e; --stat-bg: rgba(244,63,94,0.15);">\
                    <i class="fa-solid fa-triangle-exclamation risk-stat-icon"></i>\
                    <span class="risk-stat-count">' + countByLevel[3] + '</span>\
                    <span class="risk-stat-label">\uc704\ud5d8</span>\
                </div>\
                <div class="risk-stat ' + isActive(2) + '" data-risk-filter="2" style="--stat-color: #f97316; --stat-bg: rgba(249,115,22,0.15);">\
                    <i class="fa-solid fa-circle-exclamation risk-stat-icon"></i>\
                    <span class="risk-stat-count">' + countByLevel[2] + '</span>\
                    <span class="risk-stat-label">\uacbd\uace0</span>\
                </div>\
                <div class="risk-stat ' + isActive(1) + '" data-risk-filter="1" style="--stat-color: #eab308; --stat-bg: rgba(234,179,8,0.15);">\
                    <i class="fa-solid fa-circle-info risk-stat-icon"></i>\
                    <span class="risk-stat-count">' + countByLevel[1] + '</span>\
                    <span class="risk-stat-label">\uc8fc\uc758</span>\
                </div>\
                <div class="risk-stat ' + isDefaultActive + '" data-risk-filter="all" style="--stat-color: var(--text-dim); --stat-bg: rgba(255,255,255,0.08);">\
                    <i class="fa-solid fa-list risk-stat-icon"></i>\
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

        var filtered = mlRiskFilter === null
            ? risks.filter(function(r) { return r.risk_level >= 2; })
            : risks.filter(function(r) { return r.risk_level === mlRiskFilter; });

        if (filtered.length === 0) {
            list.innerHTML = '<div class="collision-empty">\ud574\ub2f9 \ub4f1\uae09\uc758 \uc704\ud5d8\uc774 \uc5c6\uc2b5\ub2c8\ub2e4</div>';
        } else {
            var mlCardsHtml = filtered.map(function(r) { return '\
                <div class="collision-card"\
                     data-mmsi-a="' + r.ship_a.mmsi + '" data-mmsi-b="' + r.ship_b.mmsi + '"\
                     data-lat-a="' + r.ship_a.lat + '" data-lng-a="' + r.ship_a.lng + '" data-lat-b="' + r.ship_b.lat + '" data-lng-b="' + r.ship_b.lng + '"\
                     data-risk-level="' + r.risk_level + '">\
                    <div class="card-top">\
                        ' + mlRiskBadge(r.risk_level, r.risk_label) + '\
                    </div>\
                    <div class="ship-row">\
                        <span class="role-tag os">OS</span>\
                        <span class="ship-name">' + r.ship_a.name + '</span>\
                        <span class="ship-meta">' + r.ship_a.sog + 'kts ' + r.ship_a.cog + '\u00b0</span>\
                    </div>\
                    <div class="ship-row">\
                        <span class="role-tag ts">TS</span>\
                        <span class="ship-name">' + r.ship_b.name + '</span>\
                        <span class="ship-meta">' + r.ship_b.sog + 'kts ' + r.ship_b.cog + '\u00b0</span>\
                    </div>\
                    <div class="metrics-row">\
                        <div class="metric">\
                            <span class="metric-label">TCPA</span>\
                            <span class="metric-value ' + tcpaClass(r.tcpa_min) + '">' + r.tcpa_min + 'm</span>\
                        </div>\
                        <div class="metric">\
                            <span class="metric-label">DCPA</span>\
                            <span class="metric-value ' + dcpaClass(r.dcpa_nm) + '">' + r.dcpa_nm + 'nm</span>\
                        </div>\
                        <div class="metric">\
                            <span class="metric-label">DIST</span>\
                            <span class="metric-value ' + distClass(r.current_dist_nm) + '">' + r.current_dist_nm + 'nm</span>\
                        </div>\
                    </div>\
                </div>';
            }).join('');
            _renderCollisionTicker(list, mlCardsHtml, filtered.length);
        }
    }

    _bindCollisionCardClicks(list);

    // Update ECharts visualizations
    if (typeof updateCollisionCharts === 'function') updateCollisionCharts();
}

function _bindCollisionCardClicks(list) {
    list.querySelectorAll('.collision-card').forEach(function(card) {
        card.addEventListener('click', function() {
            var latA = parseFloat(card.dataset.latA);
            var lngA = parseFloat(card.dataset.lngA);
            var latB = parseFloat(card.dataset.latB);
            var lngB = parseFloat(card.dataset.lngB);
            var midLat = (latA + latB) / 2;
            var midLng = (lngA + lngB) / 2;
            smoothFlyTo({
                destination: Cesium.Cartesian3.fromDegrees(midLng, midLat, 5000)
            });

            var mmsiA = Number(card.dataset.mmsiA);
            var mmsiB = Number(card.dataset.mmsiB);

            if (collisionActiveTab === 'ml') {
                selectedProximityMmsi = null;
                collisionTargetMmsi = null;
                var distNm = haversineNm(latA, lngA, latB, lngB);
                var riskLevel = parseInt(card.dataset.riskLevel) || 1;
                renderProximityLines(mmsiA, [{
                    mmsi: mmsiB,
                    lat: latB,
                    lng: lngB,
                    distance: distNm,
                    mlRiskLevel: riskLevel
                }]);
                renderNearbyPanel([]);
            } else {
                collisionTargetMmsi = mmsiB;
                selectedProximityMmsi = mmsiA;
                proximityMissCount = 0;
                updateProximity();
            }

            // showShipInfo는 이제 mmsi도 받을 수 있음
            if (shipDataMap[mmsiA] || shipDataMap[String(mmsiA)]) {
                showShipInfo(mmsiA);
            }
        });
    });
}

async function fetchCollisionRisks() {
    try {
        var resp = await fetch('/api/v1/collision/risks');
        if (!resp.ok) return;
        collisionData = await resp.json();
        renderCollisionList();

        var mlSerious = (collisionData.ml?.risks || []).filter(function(r) { return r.risk_level >= 2; }).length;
        var total = (collisionData.distance?.total || 0) + mlSerious;
        var badge = document.getElementById('collision-count');
        if (badge) badge.textContent = total;

        // Update header collision risk counts
        _updateHeaderCollisionStats();
    } catch (e) {
        console.warn('Collision fetch failed:', e);
    }
}
window.fetchCollisionRisks = fetchCollisionRisks;

function _updateHeaderCollisionStats() {
    var mlRisks = (collisionData.ml && collisionData.ml.risks) || [];

    // ML: level 3 = 위험, level 2 = 경고
    var mlDanger = mlRisks.filter(function(r) { return r.risk_level >= 3; }).length;
    var mlWarn = mlRisks.filter(function(r) { return r.risk_level === 2; }).length;

    var dots = document.querySelectorAll('#stat-collision-risks .header-risk-dot');
    if (dots.length >= 2) {
        dots[0].textContent = mlDanger;
        dots[1].textContent = mlWarn;
    }
}
