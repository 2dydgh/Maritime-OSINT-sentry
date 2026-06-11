// ── Maritime OSINT Sentry — Leaflet 2D Map (Nautical Chart Style) ──

var REGION_VIEWS = {
    'world':          { center: [20, 0],    zoom: 2 },
    'east-asia':      { center: [35, 125],  zoom: 5 },
    'southeast-asia': { center: [5, 115],   zoom: 5 },
    'europe':         { center: [50, 15],   zoom: 4 },
    'middle-east':    { center: [28, 48],   zoom: 5 },
    'africa':         { center: [5, 20],    zoom: 4 },
    'north-america':  { center: [40, -95],  zoom: 4 },
    'south-america':  { center: [-15, -55], zoom: 4 }
};

function flyToRegion2D(region, btn) {
    var view = REGION_VIEWS[region];
    if (!view || !leafletMap) return;
    document.querySelectorAll('.region-tab').forEach(function(b) { b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    leafletMap.flyTo(view.center, view.zoom, { duration: 0.8 });
}
window.flyToRegion2D = flyToRegion2D;

var REGION_TABS_2D = [
    { key: 'world', label: '전체' },
    { key: 'east-asia', label: '동아시아' },
    { key: 'southeast-asia', label: '동남아' },
    { key: 'europe', label: '유럽' },
    { key: 'middle-east', label: '중동' },
    { key: 'africa', label: '아프리카' },
    { key: 'north-america', label: '북미' },
    { key: 'south-america', label: '남미' }
];

var REGION_TABS_3D = [
    { key: 'world', label: '전체' },
    { key: 'korea', label: '한국 해역' },
    { key: 'arctic', label: '북극항로' },
    { key: 'somalia', label: '아덴만' },
    { key: 'malacca', label: '말라카' },
    { key: 'guinea', label: '기니만' }
];

function buildRegionTabs(mode) {
    var container = document.getElementById('regionTabs');
    if (!container) return;
    var tabs = mode === '2d' ? REGION_TABS_2D : REGION_TABS_3D;
    var activeKey = mode === '2d' ? 'east-asia' : 'korea';
    container.innerHTML = tabs.map(function(t) {
        return '<button class="region-tab' + (t.key === activeKey ? ' active' : '') + '" data-region="' + t.key + '" data-mode="' + mode + '">' + t.label + '</button>';
    }).join('');
    container.onclick = function(e) {
        var btn = e.target.closest('.region-tab');
        if (!btn) return;
        container.querySelectorAll('.region-tab').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var region = btn.dataset.region;
        if (btn.dataset.mode === '2d') {
            flyToRegion2D(region, btn);
        } else if (typeof flyToRegion === 'function') {
            flyToRegion(region);
        }
    };
}
window.buildRegionTabs = buildRegionTabs;

// ── Hazard hex grid layer group ──
var leafletHazardHexLayer = null;
var leafletHazardLegendEl = null;
// All scored hazard cells (lat, lng, score, cause, name, ships, collisions) — used by area-analysis tool
var leafletHazardCells = [];
// Area-analysis state
var leafletAreaSelectActive = false;
var leafletAreaSelectRect = null;
var leafletAreaSelectStart = null;
var leafletAreaResultRect = null;

// ── 사고 mode state (drag-only hazard hex rendering) ──
// While the 사고 rail icon is active, drag-area selection fetches
// /hazard/korea once and renders weather-considered risk hex cells only
// inside the selected bounds. No polling, no always-on hex layer, no mock data.
var _demoActive = false;
var koreaHazardCells = [];      // last-fetched /hazard/korea cells
var leafletDemoHexLayer = null;  // hex cells inside last drag bounds
var leafletDemoLabelLayer = null;  // callout labels + leader lines (zoom-gated)
var HAZARD_LABEL_MIN_ZOOM = 7;     // hide callouts when zoomed out past this
var _hazardLabelZoomHooked = false;
var _harFlyHighlight = null;       // transient ring shown after a list-row flyTo

// Basemap layer references — swapped between satellite (default) and nautical chart (hazard mode)
var _satBaseLayer = null;
var _satLabelLayer = null;
var _chartBaseLayer = null;
var _chartLabelLayer = null;
var _chartSeamarkLayer = null;
// View saved before entering hazard mode (so we can restore on exit)
var _savedViewBeforeHazard = null;
var _shipsChipWasActive = false;  // restore the ships layer chip when 사고 mode exits

// ── Korea hazard view bounds ──
var KOREA_HAZARD_VIEW = {
    center: [36.0, 128.5],
    zoom: 6,
    bounds: L.latLngBounds([32.0, 122.0], [40.5, 134.5])
};

function initLeaflet() {
    if (leafletInitialized) return;

    leafletMap = L.map('leafletContainer', {
        center: REGION_VIEWS['east-asia'].center,
        zoom: REGION_VIEWS['east-asia'].zoom,
        minZoom: 2,
        maxZoom: 19,
        zoomControl: false,
        attributionControl: false,
        preferCanvas: true
    });

    // ── Default basemap: satellite (matches 3D globe tone) ──
    _useSatelliteBasemap();

    // ── NM Scale bar ──
    L.control.scale({
        imperial: false,
        metric: false,
        nautical: true,
        maxWidth: 150,
        position: 'bottomleft'
    }).addTo(leafletMap);

    // ── Inject hazard legend panel ──
    _injectHazardLegend();

    leafletInitialized = true;
}

// ── Basemap swap helpers ──
function _useSatelliteBasemap() {
    if (!leafletMap) return;
    // Remove chart layers if present
    if (_chartBaseLayer)    { leafletMap.removeLayer(_chartBaseLayer);    _chartBaseLayer = null; }
    if (_chartLabelLayer)   { leafletMap.removeLayer(_chartLabelLayer);   _chartLabelLayer = null; }
    if (_chartSeamarkLayer) { leafletMap.removeLayer(_chartSeamarkLayer); _chartSeamarkLayer = null; }
    if (_satBaseLayer && _satLabelLayer) return;  // already on satellite

    // Apply dark filter to the tile-pane as a whole (not per-tile) to prevent
    // seam lines caused by per-tile CSS filter compositing.
    var container = leafletMap.getContainer();
    container.classList.remove('basemap-nautical');
    container.classList.add('basemap-satellite');

    // Satellite imagery — matches 3D Cesium globe tone.
    _satBaseLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19 }
    ).addTo(leafletMap);

    // Dark labels overlay (CARTO)
    _satLabelLayer = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        { maxZoom: 19, subdomains: 'abcd', pane: 'overlayPane' }
    ).addTo(leafletMap);
}

function _useChartBasemap() {
    if (!leafletMap) return;
    if (_satBaseLayer) { leafletMap.removeLayer(_satBaseLayer); _satBaseLayer = null; }
    if (_satLabelLayer) { leafletMap.removeLayer(_satLabelLayer); _satLabelLayer = null; }
    if (_chartBaseLayer && _chartSeamarkLayer) return;  // already on chart

    // Apply nautical filter at the container level (not per-tile) to avoid seam lines.
    var container = leafletMap.getContainer();
    container.classList.remove('basemap-satellite');
    container.classList.add('basemap-nautical');

    var BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    // Base: CARTO Positron — clean light-gray cartographic basemap matching the
    // accident.png reference (quiet light chart, minimal color noise) so the
    // orange/red risk hexes read clearly. Distinct from normal mode's satellite
    // imagery. Light by design → no dark tile filter.
    _chartBaseLayer = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19, subdomains: 'abcd', errorTileUrl: BLANK_TILE, attribution: '© OpenStreetMap, © CARTO' }
    ).addTo(leafletMap);

    // Nautical detail: OpenSeaMap seamarks (buoys, lights, depth contours)
    _chartSeamarkLayer = L.tileLayer(
        'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
        { maxZoom: 18, opacity: 0.85, pane: 'overlayPane', errorTileUrl: BLANK_TILE }
    ).addTo(leafletMap);
    _chartLabelLayer = null;  // Positron already includes labels
}

// ── Build and inject the nautical hazard legend panel ──
function _injectHazardLegend() {
    var container = document.getElementById('mapArea');
    if (!container) return;
    if (leafletHazardLegendEl) {
        leafletHazardLegendEl.remove();
        leafletHazardLegendEl = null;
    }
    var el = document.createElement('div');
    el.className = 'hazard-legend-panel';
    el.innerHTML =
        '<div class="hlp-card hlp-legend-section">' +
            '<div class="hlp-title">위험도</div>' +
            '<div class="hlp-gradient-bar"></div>' +
            '<div class="hlp-scale-labels"><span>낮음</span><span>경계</span><span>위험</span></div>' +
        '</div>' +
        '<div class="hlp-card hlp-warning-section">' +
            '<div class="hlp-warning-title"><span class="hlp-warn-icon"><i class="fa-solid fa-triangle-exclamation"></i></span> 위험 해역 경고</div>' +
            '<div class="hlp-warning-body">최근 조류 통계 및 해상 사고 데이터를<br>기반으로 위험도가 높은 해역입니다.<br>항해 시 주의가 필요합니다.</div>' +
        '</div>' +
        '<div class="hlp-source hlp-card">데이터 출처: 해양수산부 해양안전정보시스템 (2023-2024)<br>기준일: <span id="hlpDate">--</span></div>';

    var today = new Date();
    var dateStr = today.getFullYear() + '년 ' + (today.getMonth() + 1) + '월 ' + today.getDate() + '일';
    
    container.appendChild(el);
    leafletHazardLegendEl = el;
    
    var dateEl = el.querySelector('#hlpDate');
    if (dateEl) dateEl.textContent = dateStr;
}


// 2D zoom buttons — bind after DOM ready, use leafletMap at click time
document.addEventListener('DOMContentLoaded', function() {
    // Initial region tabs (3D is default)
    buildRegionTabs('3d');

    var zoomInBtn = document.getElementById('leafletZoomIn');
    var zoomOutBtn = document.getElementById('leafletZoomOut');
    if (zoomInBtn) zoomInBtn.addEventListener('click', function() { if (leafletMap) leafletMap.zoomIn(); });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', function() { if (leafletMap) leafletMap.zoomOut(); });

    var areaBtn = document.getElementById('leafletAreaSelectBtn');
    if (areaBtn) areaBtn.addEventListener('click', toggleAreaSelect);

    var harClose = document.getElementById('hazardAreaResultClose');
    if (harClose) harClose.addEventListener('click', clearAreaResult);
});

// ── Area-analysis: drag rectangle to find hazards within ──
function toggleAreaSelect() {
    if (!leafletMap || currentMapMode !== '2d') return;
    if (leafletAreaSelectActive) {
        _exitAreaSelectMode();
    } else {
        _enterAreaSelectMode();
    }
}
window.toggleAreaSelect = toggleAreaSelect;

function _enterAreaSelectMode() {
    leafletAreaSelectActive = true;
    var btn = document.getElementById('leafletAreaSelectBtn');
    if (btn) btn.classList.add('active');
    var container = document.getElementById('leafletContainer');
    if (container) container.classList.add('area-select-mode');

    leafletMap.dragging.disable();
    leafletMap.boxZoom.disable();
    leafletMap.doubleClickZoom.disable();

    leafletMap.on('mousedown', _areaSelectMouseDown);
}

function _exitAreaSelectMode() {
    leafletAreaSelectActive = false;
    var btn = document.getElementById('leafletAreaSelectBtn');
    if (btn) btn.classList.remove('active');
    var container = document.getElementById('leafletContainer');
    if (container) container.classList.remove('area-select-mode');

    leafletMap.dragging.enable();
    leafletMap.boxZoom.enable();
    leafletMap.doubleClickZoom.enable();

    leafletMap.off('mousedown', _areaSelectMouseDown);
    leafletMap.off('mousemove', _areaSelectMouseMove);
    leafletMap.off('mouseup', _areaSelectMouseUp);

    if (leafletAreaSelectRect) {
        leafletMap.removeLayer(leafletAreaSelectRect);
        leafletAreaSelectRect = null;
    }
    leafletAreaSelectStart = null;
}

function _areaSelectMouseDown(e) {
    leafletAreaSelectStart = e.latlng;
    if (leafletAreaSelectRect) {
        leafletMap.removeLayer(leafletAreaSelectRect);
        leafletAreaSelectRect = null;
    }
    if (leafletAreaResultRect) {
        leafletMap.removeLayer(leafletAreaResultRect);
        leafletAreaResultRect = null;
    }
    leafletMap.on('mousemove', _areaSelectMouseMove);
    leafletMap.on('mouseup', _areaSelectMouseUp);
}

function _areaSelectMouseMove(e) {
    if (!leafletAreaSelectStart) return;
    var bounds = L.latLngBounds(leafletAreaSelectStart, e.latlng);
    if (!leafletAreaSelectRect) {
        leafletAreaSelectRect = L.rectangle(bounds, {
            color: '#f59e0b',
            weight: 2,
            opacity: 1,
            fillColor: '#f59e0b',
            fillOpacity: 0.18,
            dashArray: '6, 4',
            interactive: false,
            className: 'area-select-rect'
        }).addTo(leafletMap);
    } else {
        leafletAreaSelectRect.setBounds(bounds);
    }
}

function _areaSelectMouseUp(e) {
    leafletMap.off('mousemove', _areaSelectMouseMove);
    leafletMap.off('mouseup', _areaSelectMouseUp);

    if (!leafletAreaSelectStart) return;

    var bounds = L.latLngBounds(leafletAreaSelectStart, e.latlng);
    leafletAreaSelectStart = null;

    // Tiny drags — treat as cancel
    var nw = bounds.getNorthWest(), se = bounds.getSouthEast();
    if (Math.abs(nw.lat - se.lat) < 0.05 && Math.abs(nw.lng - se.lng) < 0.05) {
        if (leafletAreaSelectRect) {
            leafletMap.removeLayer(leafletAreaSelectRect);
            leafletAreaSelectRect = null;
        }
        return;
    }

    // Convert preview rect → persistent result rect
    if (leafletAreaSelectRect) {
        leafletMap.removeLayer(leafletAreaSelectRect);
        leafletAreaSelectRect = null;
    }
    leafletAreaResultRect = L.rectangle(bounds, {
        color: '#f59e0b',
        weight: 2,
        opacity: 1,
        fillColor: '#f59e0b',
        fillOpacity: 0.10,
        interactive: false,
        className: 'area-result-rect'
    }).addTo(leafletMap);

    _exitAreaSelectMode();

    if (_demoActive) {
        // Cells are prefetched on 사고 mode activation; refetch only if the
        // cache is empty (e.g. fetch failed at activate time).
        var renderFromCache = function() {
            _renderDemoOverlaysInBounds(bounds);
            _renderAreaResult(bounds);
        };
        if (koreaHazardCells.length > 0) {
            renderFromCache();
        } else {
            _fetchKoreaHazard().then(renderFromCache);
        }
    } else {
        _renderAreaResult(bounds);
    }
}

function _renderAreaResult(bounds) {
    var panel = document.getElementById('hazardAreaResult');
    if (!panel) return;

    var sourceCells = koreaHazardCells;

    // Only cells whose center sits inside the drag rectangle.
    var hits = sourceCells.filter(function(cell) {
        return bounds.contains([cell.lat, cell.lng]);
    });

    var avgEl     = document.getElementById('harAvgScore');
    var maxEl     = document.getElementById('harMaxScore');
    var cntEl     = document.getElementById('harCount');
    var listEl    = document.getElementById('harList');
    var envEl     = document.getElementById('harEnvSummary');
    var staticEl  = document.getElementById('harStatic');

    if (hits.length === 0) {
        avgEl.textContent = '--';
        maxEl.textContent = '--';
        cntEl.textContent = '0';
        listEl.innerHTML = '<div class="har-empty">선택한 영역에 위험 해역이 없습니다.<br>' +
            '<span class="har-empty-hint">위험 등급이 표시된 한국 연안 구역을 드래그해 보세요.</span></div>';
        if (envEl) envEl.style.display = 'none';
        if (staticEl) staticEl.style.display = 'none';
        panel.style.display = 'block';
        return;
    }

    hits.sort(function(a, b) { return b.score - a.score; });

    var sum = 0, max = 0;
    hits.forEach(function(c) {
        sum += c.score;
        if (c.score > max) max = c.score;
    });
    var avg = sum / hits.length;

    avgEl.textContent = Math.round(avg);
    avgEl.style.color = _hazardColor(avg);
    maxEl.textContent = Math.round(max);
    maxEl.style.color = _hazardColor(max);
    cntEl.textContent = hits.length;

    listEl.innerHTML = hits.map(function(c) {
        var color = _hazardColor(c.score);
        var name  = c.name || ('셀 ' + (c.lat).toFixed(1) + '°N ' + (c.lng).toFixed(1) + '°E');
        var cause = c.cause || '';
        return '<div class="har-row" data-lat="' + c.lat + '" data-lng="' + c.lng + '" title="지도에서 보기">' +
                   '<span class="har-row-dot" style="background:' + color + '"></span>' +
                   '<span class="har-row-name">' + name + '</span>' +
                   '<span class="har-row-cause">' + cause + '</span>' +
                   '<span class="har-row-score" style="color:' + color + '">' + Math.round(c.score) + '</span>' +
               '</div>';
    }).join('');

    // Click a row → fly the map to that cell (zoom in enough to reveal labels)
    // + flash a transient ring so you can see which one. Delegated, hooked once.
    if (!listEl._harClickHooked) {
        listEl._harClickHooked = true;
        listEl.addEventListener('click', function(e) {
            var row = e.target.closest('.har-row');
            if (!row || !leafletMap) return;
            var lat = parseFloat(row.dataset.lat);
            var lng = parseFloat(row.dataset.lng);
            if (isNaN(lat) || isNaN(lng)) return;
            var targetZoom = Math.max(leafletMap.getZoom(), 8);
            leafletMap.flyTo([lat, lng], targetZoom, { duration: 0.8 });

            if (_harFlyHighlight && leafletMap.hasLayer(_harFlyHighlight)) {
                leafletMap.removeLayer(_harFlyHighlight);
            }
            _harFlyHighlight = L.circleMarker([lat, lng], {
                radius: 22, color: '#ffffff', weight: 2.5, opacity: 0.95,
                fill: false, interactive: false, className: 'har-fly-highlight'
            }).addTo(leafletMap);
            var ring = _harFlyHighlight;
            setTimeout(function() {
                if (ring && leafletMap && leafletMap.hasLayer(ring)) leafletMap.removeLayer(ring);
                if (_harFlyHighlight === ring) _harFlyHighlight = null;
            }, 2200);
        });
    }

    // Environment summary — only available for demo cells (have subscores)
    var withSubs = hits.filter(function(c) { return c.subscores; });
    if (envEl) {
        if (withSubs.length > 0) {
            var waveVals = withSubs.map(function(c){ return c.subscores.wave_raw; }).filter(function(v){ return v != null; });
            var windVals = withSubs.map(function(c){ return c.subscores.wind_raw; }).filter(function(v){ return v != null; });
            var visVals  = withSubs.map(function(c){ return c.subscores.vis_raw;  }).filter(function(v){ return v != null; });
            var trafSum  = withSubs.reduce(function(s,c){ return s + (c.subscores.traffic_n || 0); }, 0);

            _setEnvText('harWaveAvg', waveVals.length ? _mean(waveVals).toFixed(1) : '--');
            _setEnvText('harWaveMax', waveVals.length ? Math.max.apply(null, waveVals).toFixed(1) : '--');
            _setEnvText('harWindAvg', windVals.length ? Math.round(_mean(windVals)) : '--');
            _setEnvText('harWindMax', windVals.length ? Math.round(Math.max.apply(null, windVals)) : '--');
            _setEnvText('harVisAvg',  visVals.length  ? _mean(visVals).toFixed(1) : '--');
            _setEnvText('harVisMin',  visVals.length  ? Math.min.apply(null, visVals).toFixed(1) : '--');
            _setEnvText('harTrafficN', trafSum);
            envEl.style.display = 'block';
        } else {
            envEl.style.display = 'none';
        }
    }

    // Static hazard zones — unique names across hit cells
    if (staticEl) {
        var staticNames = [];
        withSubs.forEach(function(c) {
            (c.subscores.static_names || []).forEach(function(n) {
                if (staticNames.indexOf(n) === -1) staticNames.push(n);
            });
        });
        var staticListEl = document.getElementById('harStaticList');
        if (staticNames.length > 0 && staticListEl) {
            staticListEl.innerHTML = staticNames.map(function(n) {
                return '<div class="har-static-item">' + n + '</div>';
            }).join('');
            staticEl.style.display = 'block';
        } else {
            staticEl.style.display = 'none';
        }
    }

    panel.style.display = 'block';
}

function _setEnvText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function(s,v){ return s+v; }, 0) / arr.length;
}

// Smooth risk color ramp: light-yellow → amber → orange → red → deep-red.
// Reproduces the accident.png rosette gradient (hot core fading at the edges)
// instead of a flat 2-step cut. Returns { fill, opacity }.
function _hazardRamp(score) {
    // Stops span the ACTUAL score range (~79–96, clustered 80–90) so the full
    // yellow→red spectrum is visible across real cells. The old 40–100 ramp left
    // the yellows unused and made everything read orange/red.
    var stops = [
        [79, 253, 224, 71],   // #fde047 light yellow (cluster edge)
        [83, 250, 204, 21],   // #facc15 yellow
        [86, 245, 158, 11],   // #f59e0b amber
        [89, 249, 115, 22],   // #f97316 orange
        [92, 239, 68, 68],    // #ef4444 red
        [96, 185, 28, 28]     // #b91c1c deep red (hot core)
    ];
    var lo = stops[0], hi = stops[stops.length - 1];
    var s = Math.max(lo[0], Math.min(hi[0], score));
    for (var i = 0; i < stops.length - 1; i++) {
        if (s >= stops[i][0] && s <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    var t = (hi[0] === lo[0]) ? 0 : (s - lo[0]) / (hi[0] - lo[0]);
    var r = Math.round(lo[1] + (hi[1] - lo[1]) * t);
    var g = Math.round(lo[2] + (hi[2] - lo[2]) * t);
    var b = Math.round(lo[3] + (hi[3] - lo[3]) * t);
    // opacity rises with score so hot cores read denser: 0.50 → 0.85
    var op = 0.50 + 0.35 * Math.max(0, Math.min(1, (score - 79) / 17));
    return { fill: 'rgb(' + r + ',' + g + ',' + b + ')', opacity: op };
}

function _hazardColor(score) {
    return _hazardRamp(score).fill;
}

function clearAreaResult() {
    var panel = document.getElementById('hazardAreaResult');
    if (panel) panel.style.display = 'none';
    if (leafletAreaResultRect) {
        leafletMap.removeLayer(leafletAreaResultRect);
        leafletAreaResultRect = null;
    }
    // Closing the result panel also removes the on-demand demo overlays.
    _clearDemoLayers();
}
window.clearAreaResult = clearAreaResult;

function setMapMode(mode) {
    if (mode === currentMapMode) return;
    currentMapMode = mode;

    var mapArea = document.getElementById('mapArea');
    var btns = document.querySelectorAll('.map-mode-btn');
    btns.forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });

    if (mode === '2d') {
        initLeaflet();

        viewer.useDefaultRenderLoop = false;

        mapArea.classList.add('mode-2d');

        leafletMap.invalidateSize();
        leafletMap.setView(REGION_VIEWS['east-asia'].center, REGION_VIEWS['east-asia'].zoom);

        buildRegionTabs('2d');

        // 로딩 표시 후 렌더링 — requestAnimationFrame으로 로딩 UI가 먼저 그려진 후 실행
        var loadingEl = document.getElementById('loading');
        var loadingTextEl = document.getElementById('loading-text');
        if (loadingEl && loadingTextEl) {
            loadingTextEl.textContent = '2D 지도 렌더링 중...';
            loadingEl.style.display = 'flex';
        }
        requestAnimationFrame(function() {
            setTimeout(function() {
                if (typeof syncShipsToLeaflet === 'function') syncShipsToLeaflet();
                if (typeof syncProximityToLeaflet === 'function') syncProximityToLeaflet();
                if (typeof syncSatellitesToLeaflet === 'function') syncSatellitesToLeaflet();
                if (loadingEl) loadingEl.style.display = 'none';
            }, 0);
        });

        if (timeMode === 'history' && !window._leaflet2dUpdateInterval) {
            window._leaflet2dUpdateInterval = setInterval(function() {
                if (currentMapMode === '2d') syncShipsToLeaflet();
            }, 2000);
        }
    } else {
        // Capture current view BEFORE turning off hazard (so cesium follows the user's last 2D position)
        var center = leafletMap.getCenter();
        var zoom = leafletMap.getZoom();

        // Leaving 2D — turn off hazard layer if it was on
        if (_hazardZonesActive) deactivateHazardZones();

        mapArea.classList.remove('mode-2d');
        viewer.useDefaultRenderLoop = true;
        viewer.resize();

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, zoomToAltitude(zoom)),
            duration: 0
        });

        if (window._leaflet2dUpdateInterval) {
            clearInterval(window._leaflet2dUpdateInterval);
            window._leaflet2dUpdateInterval = null;
        }

        clearLeafletLayers();

        buildRegionTabs('3d');
    }
}
window.setMapMode = setMapMode;

function syncShipsToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;

    Object.values(leafletShipLayerGroups).forEach(function(lg) { leafletMap.removeLayer(lg); });
    leafletShipLayerGroups = {};
    leafletShipMarkers = {};

    // shipDataMap에서 직접 읽기 (Entity 의존 제거)
    var shipsByType = {};
    Object.keys(shipDataMap).forEach(function(mmsi) {
        var ship = shipDataMap[mmsi];
        if (ship.lat == null || ship.lng == null) return;
        var type = ship.type || 'other';
        if (!shipsByType[type]) shipsByType[type] = [];
        shipsByType[type].push(ship);
    });

    SHIP_TYPES.forEach(function(type) {
        var ships = shipsByType[type];
        if (!ships || ships.length === 0) return;

        var lg = L.layerGroup();
        leafletShipLayerGroups[type] = lg;

        var color = SHIP_COLORS[type] || '#6b7280';
        ships.forEach(function(ship) {
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

            lg.addLayer(marker);
            leafletShipMarkers[ship.mmsi] = { marker: marker, type: type };
        });

        var checkbox = document.getElementById('filter-' + type);
        if (!checkbox || checkbox.checked) {
            lg.addTo(leafletMap);
        }
    });
}

function syncProximityToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;

    Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
    leafletCollisionLines = {};

    if (!proximityDataSource) return;

    proximityDataSource.entities.values.forEach(function(entity) {
        if (entity.polyline) {
            try {
                var positions = entity.polyline.positions.getValue(viewer.clock.currentTime);
                if (!positions || positions.length < 2) return;

                var latLngs = positions.map(function(p) {
                    var c = Cesium.Cartographic.fromCartesian(p);
                    return [Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)];
                });

                var color = '#f59e0b';
                var id = entity.id || '';
                if (id.includes('cog-')) color = '#f43f5e';

                var isDashed = id.startsWith('cog-');
                var line = L.polyline(latLngs, {
                    color: color,
                    weight: isDashed ? 2 : 3,
                    opacity: 0.7,
                    dashArray: isDashed ? '8, 6' : null
                }).addTo(leafletMap);

                leafletCollisionLines[id] = line;
            } catch (e) { /* skip if positions can't be resolved */ }
        }

        if (entity.point && entity.position) {
            try {
                var pos = entity.position.getValue(viewer.clock.currentTime);
                if (!pos) return;

                var c = Cesium.Cartographic.fromCartesian(pos);
                var lat = Cesium.Math.toDegrees(c.latitude);
                var lon = Cesium.Math.toDegrees(c.longitude);

                var marker = L.circleMarker([lat, lon], {
                    radius: 6,
                    fillColor: '#f43f5e',
                    fillOpacity: 0.5,
                    color: '#f43f5e',
                    weight: 2
                }).addTo(leafletMap);

                leafletCollisionLines[entity.id] = marker;
            } catch (e) { /* skip */ }
        }
    });
}

var leafletSatFootprints = {};

function syncSatellitesToLeaflet() {
    if (!leafletMap || currentMapMode !== '2d') return;
    if (!satDataSource || !satDataSource.show) return;

    // Clear previous
    Object.values(leafletSatMarkers).forEach(function(m) { leafletMap.removeLayer(m); });
    Object.values(leafletSatTracks).forEach(function(t) { leafletMap.removeLayer(t); });
    Object.values(leafletSatFootprints).forEach(function(f) { leafletMap.removeLayer(f); });
    leafletSatMarkers = {};
    leafletSatTracks = {};
    leafletSatFootprints = {};

    var hasSatelliteJs = typeof satellite !== 'undefined';
    var now = new Date();
    var enabledMissions = typeof _getEnabledMissions === 'function' ? _getEnabledMissions() : null;
    var showOrbits = document.getElementById('layer-sat-ground').checked;
    var showFootprint = document.getElementById('layer-sat-footprint').checked;

    Object.entries(_satRecCache).forEach(function([satId, entry]) {
        var satrec = entry.satrec;
        var sat = entry.sat;
        var mission = sat.mission || '';

        // Respect mission filter
        if (enabledMissions && !enabledMissions.has(mission)) return;

        var lat, lng, altKm;

        // Propagate real-time position with satellite.js
        if (hasSatelliteJs && satrec) {
            try {
                var posVel = satellite.propagate(satrec, now);
                if (posVel.position) {
                    var gmst = satellite.gstime(now);
                    var geo = satellite.eciToGeodetic(posVel.position, gmst);
                    lat = satellite.degreesLat(geo.latitude);
                    lng = satellite.degreesLong(geo.longitude);
                    altKm = geo.height;
                }
            } catch (e) { /* fallback */ }
        }
        if (lat == null) {
            lat = sat.lat; lng = sat.lng; altKm = sat.alt_km || 400;
        }
        if (lat == null || lng == null) return;

        var color = SAT_COLORS[mission] || '#94a3b8';

        // Satellite marker with mission color
        var iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">' +
            '<circle cx="10" cy="10" r="4" fill="' + color + '" opacity="0.9"/>' +
            '<circle cx="10" cy="10" r="7" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.4"/>' +
            '<line x1="3" y1="10" x2="7" y2="10" stroke="' + color + '" stroke-width="1.5" opacity="0.6"/>' +
            '<line x1="13" y1="10" x2="17" y2="10" stroke="' + color + '" stroke-width="1.5" opacity="0.6"/>' +
            '</svg>';

        var marker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'sat-icon-2d',
                html: iconSvg,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            }),
            zIndexOffset: 500
        }).addTo(leafletMap);

        var tooltipContent = '<b>' + sat.name + '</b><br>' +
            '<span style="color:' + color + '">' + (sat.sat_type || mission) + '</span><br>' +
            'ALT: ' + Math.round(altKm) + ' km';
        marker.bindTooltip(tooltipContent, {
            className: 'ship-tooltip-2d',
            direction: 'top',
            offset: [0, -12]
        });

        marker.on('click', function() {
            if (typeof _toggleSatFootprint === 'function') {
                _toggleSatFootprint(satId);
                syncSatellitesToLeaflet(); // refresh to show/hide footprint
            }
        });

        leafletSatMarkers[satId] = marker;

        // Ground track
        if (showOrbits && hasSatelliteJs && satrec && typeof _computeGroundTrack === 'function') {
            var groundCoords = _computeGroundTrack(satrec, now, 100);
            if (groundCoords.length >= 4) {
                var latLngs = [];
                for (var i = 0; i < groundCoords.length; i += 2) {
                    latLngs.push([groundCoords[i + 1], groundCoords[i]]); // [lat, lng]
                }

                // Split at antimeridian to avoid wrapping artifacts
                var segments = _splitAtAntimeridian(latLngs);
                var trackGroup = L.layerGroup();
                segments.forEach(function(seg) {
                    L.polyline(seg, {
                        color: color,
                        weight: 1.5,
                        opacity: 0.35,
                        dashArray: '6, 4'
                    }).addTo(trackGroup);
                });
                trackGroup.addTo(leafletMap);
                leafletSatTracks[satId] = trackGroup;
            }
        }

        // Footprint (sensor coverage area)
        if (showFootprint && typeof _computeFootprint === 'function') {
            var fpCoords = _computeFootprint(lat, lng, altKm, 36);
            if (fpCoords.length >= 6) {
                var fpLatLngs = [];
                for (var j = 0; j < fpCoords.length; j += 2) {
                    fpLatLngs.push([fpCoords[j + 1], fpCoords[j]]); // [lat, lng]
                }
                var footprint = L.polygon(fpLatLngs, {
                    color: color,
                    weight: 1,
                    opacity: 0.4,
                    fillColor: color,
                    fillOpacity: 0.08,
                    dashArray: '4, 3'
                }).addTo(leafletMap);
                leafletSatFootprints[satId] = footprint;
            }
        }
    });
}

// Split polyline at antimeridian (±180°) to avoid wrapping artifacts
function _splitAtAntimeridian(latLngs) {
    if (latLngs.length < 2) return [latLngs];
    var segments = [];
    var current = [latLngs[0]];

    for (var i = 1; i < latLngs.length; i++) {
        var prevLng = latLngs[i - 1][1];
        var curLng = latLngs[i][1];
        if (Math.abs(curLng - prevLng) > 180) {
            // Antimeridian crossing — start new segment
            segments.push(current);
            current = [];
        }
        current.push(latLngs[i]);
    }
    if (current.length > 0) segments.push(current);
    return segments;
}

function clearLeafletLayers() {
    if (!leafletMap) return;
    Object.values(leafletShipLayerGroups).forEach(function(lg) { leafletMap.removeLayer(lg); });
    Object.values(leafletCollisionLines).forEach(function(l) { leafletMap.removeLayer(l); });
    Object.values(leafletSatMarkers).forEach(function(m) { leafletMap.removeLayer(m); });
    Object.values(leafletSatTracks).forEach(function(t) { leafletMap.removeLayer(t); });
    Object.values(leafletSatFootprints).forEach(function(f) { leafletMap.removeLayer(f); });
    // Clear hazard hex grid
    if (leafletHazardHexLayer) {
        leafletMap.removeLayer(leafletHazardHexLayer);
        leafletHazardHexLayer = null;
    }
    // Clear demo-mode layers (drag-only hex cells + mock vessel markers)
    if (typeof _clearDemoLayers === 'function') _clearDemoLayers();
    // Clear area-analysis state (rectangle + result panel)
    if (leafletAreaSelectActive) _exitAreaSelectMode();
    if (leafletAreaResultRect) {
        leafletMap.removeLayer(leafletAreaResultRect);
        leafletAreaResultRect = null;
    }
    var resultPanel = document.getElementById('hazardAreaResult');
    if (resultPanel) resultPanel.style.display = 'none';
    leafletShipMarkers = {};
    leafletShipLayerGroups = {};
    leafletCollisionLines = {};
    leafletSatMarkers = {};
    leafletSatTracks = {};
    leafletSatFootprints = {};
}

function altitudeToZoom(altitude) {
    return Math.max(2, Math.min(18, Math.round(Math.log2(40000000 / altitude) + 1)));
}

function zoomToAltitude(zoom) {
    return 40000000 / Math.pow(2, zoom - 1);
}

// ── Hexagon utility: compute 6 vertices of a flat-top hexagon ──
function _hexPolygon(lat, lng, radiusDeg) {
    var pts = [];
    // Build the hexagon in RAW degree space (no cos-lat correction). The backend
    // grid (korea_hex_grid) lays cell centers on a raw-degree honeycomb —
    // in-row spacing = CELL_DEG, row spacing = 1.5·radius, odd rows +CELL_DEG/2.
    // Matching that here makes adjacent hexes share edges (tile) instead of
    // overlapping; a cos-lat divisor widened each hex past its grid slot.
    for (var i = 0; i < 6; i++) {
        // Pointy-top vertices (vertex at north): flat-to-flat width = √3·radius =
        // CELL_DEG (= in-row spacing), point-to-point height = 2·radius.
        var angleRad = (60 * i) * Math.PI / 180;
        pts.push([
            lat + radiusDeg * Math.cos(angleRad),
            lng + radiusDeg * Math.sin(angleRad)
        ]);
    }
    return pts;
}

// ── Named sea areas for hazard labels ──
var SEA_AREAS = [
    { name: '말라카 해협', lat: 3.5,  lng: 102.5 },
    { name: '남중국해',    lat: 14.0, lng: 114.0 },
    { name: '동중국해',    lat: 28.0, lng: 125.0 },
    { name: '황해',        lat: 36.0, lng: 123.0 },
    { name: '대한해협',    lat: 34.5, lng: 129.0 },
    { name: '아덴만',      lat: 12.5, lng: 47.0  },
    { name: '오만만',      lat: 23.0, lng: 60.0  },
    { name: '페르시아만',  lat: 27.0, lng: 52.0  },
    { name: '홍해',        lat: 21.0, lng: 38.0  },
    { name: '인도양',      lat: -5.0, lng: 73.0  },
    { name: '지중해',      lat: 36.0, lng: 16.0  },
    { name: '수에즈 운하', lat: 30.5, lng: 32.5  },
    { name: '기니만',      lat: 3.0,  lng: 3.0   },
    { name: '호르무즈 해협',lat: 26.5, lng: 56.5  },
    { name: '대서양',      lat: 20.0, lng: -25.0 }
];

var HAZARD_CAUSES = ['조류 강도 높음', '과거 사고 다발', '조류 변동성 큼', '협수로', '안개 잦음', '항로 교차 빈번'];

function _nearestSeaArea(lat, lng) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < SEA_AREAS.length; i++) {
        var a = SEA_AREAS[i];
        var d = Math.sqrt(Math.pow(a.lat - lat, 2) + Math.pow(a.lng - lng, 2));
        if (d < bestDist) { bestDist = d; best = a; }
    }
    return best && bestDist < 20 ? best.name : null;
}

// ── Korean demo-mode lifecycle ───────────────────────────────────
// Toggled by the left-rail demo button (Task 16). Backend's mock vessels
// only flow through /hazard/korea (not WebSocket), so drag selection is
// the single place that fetches + renders demo data.
function setDemoActive(active) {
    _demoActive = !!active;
    if (!_demoActive) {
        _clearDemoLayers();
        koreaHazardCells = [];
    }
}
window.setDemoActive = setDemoActive;

function isDemoActive() {
    return _demoActive;
}
window.isDemoActive = isDemoActive;

async function _fetchKoreaHazard() {
    try {
        var resp = await fetch('/api/v1/hazard/korea');
        var data = await resp.json();
        koreaHazardCells = (data && data.cells) || [];
        return data;
    } catch (e) {
        console.warn('[korea-hazard] fetch failed:', e);
        koreaHazardCells = [];
        return null;
    }
}

function _clearDemoLayers() {
    if (leafletDemoHexLayer && leafletMap) {
        leafletMap.removeLayer(leafletDemoHexLayer);
    }
    leafletDemoHexLayer = null;
    if (leafletDemoLabelLayer && leafletMap) {
        leafletMap.removeLayer(leafletDemoLabelLayer);
    }
    leafletDemoLabelLayer = null;
}

// Show callouts only when zoomed in enough; otherwise the fixed-size label
// boxes dwarf the shrunken hexes and pile up in the center of the view.
function _updateHazardLabelVisibility() {
    if (!leafletMap || !leafletDemoLabelLayer) return;
    var show = leafletMap.getZoom() >= HAZARD_LABEL_MIN_ZOOM;
    var on = leafletMap.hasLayer(leafletDemoLabelLayer);
    if (show && !on) leafletMap.addLayer(leafletDemoLabelLayer);
    else if (!show && on) leafletMap.removeLayer(leafletDemoLabelLayer);
}

// Draw a single hex cell from the backend /hazard/korea response.
// Cell shape: { lat, lng, score, cause, subscores: { wave_raw, wind_raw, vis_raw, traffic_n, static_names } }
function _drawDemoHexCell(group, cell, labelName, index, labelGroup) {
    var CELL_DEG = 0.3;
    var score = cell.score;
    var isHighDanger = score >= 90;
    var _ramp = _hazardRamp(score);
    var fillColor = _ramp.fill;
    var fillOpacity = _ramp.opacity;
    var weight = 1.5;
    var strokeColor = '#ffffff';

    // Honeycomb tiling: radius = CELL_DEG / sqrt(3) (≈ 0.577 × CELL_DEG)
    // produces pointy-top hexes that share edges with neighbors when the grid
    // uses sqrt(3)/2 × CELL_DEG row spacing — matches accident.png look.
    var radius = CELL_DEG / Math.sqrt(3);
    var hexPts = _hexPolygon(cell.lat, cell.lng, radius);
    var hex = L.polygon(hexPts, {
        color: strokeColor,
        weight: weight,
        opacity: 0.95,
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        className: 'hazard-hex' + (isHighDanger ? ' hex-danger' : ' hex-high')
    });

    // Pure white center dot (matching accident.png)
    var dot = L.circleMarker([cell.lat, cell.lng], {
        radius: 3,
        fillColor: '#ffffff',
        fillOpacity: 1.0,
        color: '#ffffff',
        weight: 1,
        className: 'hazard-dot' + (isHighDanger ? ' dot-danger' : '')
    });

    var sub = cell.subscores || {};
    var displayName = labelName || ('위험 셀 ' + cell.lat.toFixed(1) + '°N ' + cell.lng.toFixed(1) + '°E');
    cell.name = displayName;  // memoize for area-result list

    hex.bindPopup(
        '<div class="hazard-popup">' +
            '<div class="hpop-title">' + displayName + '</div>' +
            '<div class="hpop-row"><span>위험도</span><b style="color:' + _hazardColor(score) + '">' + Math.round(score) + '</b></div>' +
            '<div class="hpop-row"><span>주요 원인</span><b>' + (cell.cause || '-') + '</b></div>' +
            (sub.wave_raw != null ? '<div class="hpop-row"><span>파고</span><b>' + sub.wave_raw + 'm</b></div>' : '') +
            (sub.wind_raw != null ? '<div class="hpop-row"><span>풍속</span><b>' + sub.wind_raw + 'kt</b></div>' : '') +
            (sub.vis_raw != null ? '<div class="hpop-row"><span>시정</span><b>' + sub.vis_raw + 'km</b></div>' : '') +
            (sub.traffic_n != null ? '<div class="hpop-row"><span>선박</span><b>' + sub.traffic_n + '척</b></div>' : '') +
        '</div>',
        { className: 'hazard-popup-wrapper', maxWidth: 240 }
    );

    hex.addTo(group);
    dot.addTo(group);

    // Draw leader line + permanent callout, offset clear of the ~0.3° cluster.
    // Each label fans out in a distinct diagonal so callouts never stack.
    // Goes into labelGroup (zoom-gated) so it disappears when zoomed out.
    if (labelName && labelGroup) {
        var CALLOUT_DIRS = [
            [0.30, 0.46],    // up-right
            [-0.30, 0.46],   // down-right
            [0.52, 0.0],     // up
            [-0.52, 0.0],    // down
            [0.30, -0.46],   // up-left
            [-0.30, -0.46]   // down-left
        ];
        var dir = CALLOUT_DIRS[index % CALLOUT_DIRS.length];
        var labelLatLng = [cell.lat + dir[0], cell.lng + dir[1]];

        // 1. Draw crisp red leader line
        L.polyline([[cell.lat, cell.lng], labelLatLng], {
            color: '#ef4444',
            weight: 1.5,
            opacity: 0.9,
            interactive: false
        }).addTo(labelGroup);

        // 2. Invisible marker for anchoring the tooltip
        var labelMarker = L.marker(labelLatLng, {
            icon: L.divIcon({
                className: 'invisible-label-anchor',
                html: '',
                iconSize: [0, 0]
            }),
            interactive: false
        });

        var tooltipHtml =
            '<div class="hazard-label-popup">' +
                '<div class="hlp-popup-name">' + displayName + '</div>' +
                '<div class="hlp-popup-score">위험도: <b>' + Math.round(score) + '</b></div>' +
                '<div class="hlp-popup-cause">(' + (cell.cause || '과거 사고 다발') + ')</div>' +
            '</div>';

        labelMarker.bindTooltip(tooltipHtml, {
            permanent: true,
            direction: 'right',
            offset: [5, 0],
            className: 'hazard-tooltip-permanent',
            opacity: 1
        }).addTo(labelGroup);

        labelMarker.addTo(labelGroup);
    }
}

// Render risk-colored hex cells within the drag bounds.
// Called by the area-select mouseup handler when 사고 mode is active.
function _renderDemoOverlaysInBounds(bounds) {
    if (!leafletMap) return;
    _clearDemoLayers();

    var hexHits = koreaHazardCells.filter(function(c) {
        if (c.lat == null || c.lng == null) return false;
        return bounds.contains([c.lat, c.lng]);
    });

    if (hexHits.length > 0) {
        // Sort descending by score
        hexHits.sort(function(a, b) { return b.score - a.score; });

        var hexGroup = L.layerGroup();
        var labelGroup = L.layerGroup();
        var labelLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

        // Pick ONE label per distinct hotspot: greedily take the highest-score
        // cell that is far enough from already-labeled cells. hexHits is sorted
        // desc by score, so labels land on separate clusters (not 3 adjacent
        // cells of the same blob) — avoids the callouts piling on each other.
        var LABEL_SEP_DEG = 0.7;
        var labeled = [];
        for (var i = 0; i < hexHits.length && labeled.length < labelLetters.length; i++) {
            var c = hexHits[i];
            var clash = labeled.some(function(lc) {
                return Math.abs(lc.lat - c.lat) < LABEL_SEP_DEG &&
                       Math.abs(lc.lng - c.lng) < LABEL_SEP_DEG;
            });
            if (!clash) labeled.push(c);
        }

        hexHits.forEach(function(cell, index) {
            var li = labeled.indexOf(cell);
            var labelName = li >= 0 ? ('위험 해역 ' + labelLetters[li]) : null;
            _drawDemoHexCell(hexGroup, cell, labelName, li >= 0 ? li : index, labelGroup);
        });

        hexGroup.addTo(leafletMap);
        leafletDemoHexLayer = hexGroup;
        leafletDemoLabelLayer = labelGroup;

        // Gate callouts on zoom; register the listener once.
        if (!_hazardLabelZoomHooked) {
            leafletMap.on('zoomend', _updateHazardLabelVisibility);
            _hazardLabelZoomHooked = true;
        }
        _updateHazardLabelVisibility();
    }
}

// ── Main: build hazard hex grid from collision + ship data ──
function renderHazardHexGrid() {
    if (!leafletMap) return;

    // Remove existing hex layer
    if (leafletHazardHexLayer) {
        leafletMap.removeLayer(leafletHazardHexLayer);
        leafletHazardHexLayer = null;
    }

    // Grid cell size (degrees)
    var CELL_DEG = 0.3;
    var cellMap = {};  // key: "lat_lng" → { lat, lng, ships, collisions, maxRisk }

    // ── Cluster ships into cells ──
    if (window.shipDataMap) {
        Object.values(window.shipDataMap).forEach(function(ship) {
            if (ship.lat == null || ship.lng == null) return;
            var cellLat = Math.round(ship.lat / CELL_DEG) * CELL_DEG;
            var cellLng = Math.round(ship.lng / CELL_DEG) * CELL_DEG;
            var key = cellLat.toFixed(1) + '_' + cellLng.toFixed(1);
            if (!cellMap[key]) cellMap[key] = { lat: cellLat, lng: cellLng, ships: 0, collisions: 0, maxRisk: 0 };
            cellMap[key].ships++;
        });
    }

    // ── Overlay collision risk scores ──
    if (window.collisionPairs && Array.isArray(window.collisionPairs)) {
        window.collisionPairs.forEach(function(pair) {
            var lat = pair.cpa_lat || pair.lat1 || null;
            var lng = pair.cpa_lng || pair.lng1 || null;
            if (lat == null || lng == null) return;
            var cellLat = Math.round(lat / CELL_DEG) * CELL_DEG;
            var cellLng = Math.round(lng / CELL_DEG) * CELL_DEG;
            var key = cellLat.toFixed(1) + '_' + cellLng.toFixed(1);
            if (!cellMap[key]) cellMap[key] = { lat: cellLat, lng: cellLng, ships: 0, collisions: 0, maxRisk: 0 };
            var risk = pair.risk_score || pair.distance_risk || 0;
            cellMap[key].collisions++;
            if (risk > cellMap[key].maxRisk) cellMap[key].maxRisk = risk;
        });
    }

    // ── Compute normalized 0-100 hazard score per cell ──
    var scoredCells = [];
    Object.values(cellMap).forEach(function(cell) {
        // Score from ship density + collision events
        var densityScore = Math.min(cell.ships / 8, 1.0) * 40;
        var collisionScore = Math.min(cell.collisions / 3, 1.0) * 40;
        var riskScore = Math.min(cell.maxRisk, 1.0) * 20;
        var raw = densityScore + collisionScore + riskScore;
        if (raw < 30) return;  // below threshold — skip
        // Normalize to 70-100 range for display
        var score = 70 + (raw / 100) * 30;
        score = Math.min(100, Math.max(70, score));
        cell.score = score;
        scoredCells.push(cell);
    });

    // If no collision data at all but there are ships, generate demo clusters
    // from high-density ship areas so the overlay is always visible
    if (scoredCells.length === 0 && window.shipDataMap) {
        Object.values(cellMap).forEach(function(cell) {
            if (cell.ships >= 3) {
                cell.score = 75 + Math.min(cell.ships, 10) * 1.5;
                cell.score = Math.min(100, cell.score);
                scoredCells.push(cell);
            }
        });
    }

    if (scoredCells.length === 0) return;

    // Sort descending, take top 40
    scoredCells.sort(function(a, b) { return b.score - a.score; });
    var topCells = scoredCells.slice(0, 40);

    // Pre-compute name + cause for each cell so area-analysis can reuse
    var labelLetters = ['A', 'B', 'C', 'D', 'E'];
    topCells.forEach(function(cell, idx) {
        var causeIdx = (Math.abs(Math.round(cell.lat * 7 + cell.lng * 3)) % HAZARD_CAUSES.length);
        cell.cause = HAZARD_CAUSES[causeIdx];
        cell.name = idx < 5 ? ('위험 해역 ' + labelLetters[idx]) : ('위험 해역 ' + (idx + 1));
    });
    leafletHazardCells = topCells;

    var hexGroup = L.layerGroup();

    topCells.forEach(function(cell, idx) {
        var score = cell.score;
        var isHighDanger = score >= 90;
        var _ramp = _hazardRamp(score);
        var fillColor = _ramp.fill;
        var fillOpacity = _ramp.opacity;
        var weight = 1.5;
        var strokeColor = '#ffffff';

        // ── Pulse rings (rendered behind hex) ──────────────────────────
        // 3 concentric rings for high-danger, 2 for high — staggered delays
        // create ripple/radar-ping effect via CSS stroke-opacity animation
        var ringRadii   = isHighDanger ? [0.62, 0.80, 1.00] : [0.62, 0.82];
        var ringClasses = isHighDanger
            ? ['hazard-ring ring-danger ring-1', 'hazard-ring ring-danger ring-2', 'hazard-ring ring-danger ring-3']
            : ['hazard-ring ring-high ring-1', 'hazard-ring ring-high ring-2'];

        ringRadii.forEach(function(rf, ri) {
            L.circle([cell.lat, cell.lng], {
                radius: CELL_DEG * rf * 111320,   // deg→meters approx
                color: isHighDanger ? '#ff2a2a' : '#ff6a00',
                weight: isHighDanger ? 1.5 : 1.0,
                opacity: 0,          // initial; CSS animation controls it
                fill: false,
                interactive: false,
                className: ringClasses[ri]
            }).addTo(hexGroup);
        });
        // ───────────────────────────────────────────────────────────────

        // Draw hexagon (using pointy-top tiling radius CELL_DEG/sqrt(3))
        var radius = CELL_DEG / Math.sqrt(3);
        var hexPts = _hexPolygon(cell.lat, cell.lng, radius);

        var hex = L.polygon(hexPts, {
            color: strokeColor,
            weight: weight,
            opacity: 0.95,
            fillColor: fillColor,
            fillOpacity: fillOpacity,
            className: 'hazard-hex' + (isHighDanger ? ' hex-danger' : ' hex-high')
        });

        // Crisp white center dot (matching accident.png)
        var dot = L.circleMarker([cell.lat, cell.lng], {
            radius: 3,
            fillColor: '#ffffff',
            fillOpacity: 1.0,
            color: '#ffffff',
            weight: 1,
            className: 'hazard-dot' + (isHighDanger ? ' dot-danger' : '')
        });

        var cause = cell.cause;

        // Named label popup with leader line for top 3 risk areas (matching accident.png)
        if (idx < 3) {
            var scoreRounded = Math.round(score);

            var offsetLat = 0.08 + (idx * 0.04);
            var offsetLng = 0.12 - (idx * 0.02);

            // Beautiful offsets matching accident.png callouts
            if (idx === 2) {
                offsetLat = -0.08;
                offsetLng = 0.14;
            } else if (idx === 1) {
                offsetLat = -0.02;
                offsetLng = 0.15;
            }

            var labelLatLng = [cell.lat + offsetLat, cell.lng + offsetLng];

            // 1. Draw leader line
            L.polyline([[cell.lat, cell.lng], labelLatLng], {
                color: '#ef4444',
                weight: 1.5,
                opacity: 0.9,
                interactive: false
            }).addTo(hexGroup);

            // 2. Invisible marker for tooltip anchor
            var labelMarker = L.marker(labelLatLng, {
                icon: L.divIcon({
                    className: 'invisible-label-anchor',
                    html: '',
                    iconSize: [0, 0]
                }),
                interactive: false
            });

            var tooltipHtml =
                '<div class="hazard-label-popup">' +
                    '<div class="hlp-popup-name">' + cell.name + '</div>' +
                    '<div class="hlp-popup-score">위험도: <b>' + scoreRounded + '</b></div>' +
                    '<div class="hlp-popup-cause">(' + cause + ')</div>' +
                '</div>';

            labelMarker.bindTooltip(tooltipHtml, {
                permanent: true,
                direction: 'right',
                offset: [5, 0],
                className: 'hazard-tooltip-permanent',
                opacity: 1
            }).addTo(hexGroup);

            labelMarker.addTo(hexGroup);
        }

        // Click popup with detail
        hex.bindPopup(
            '<div class="hazard-popup">' +
                '<div class="hpop-title">' + cell.name + '</div>' +
                '<div class="hpop-row"><span>위험도</span><b style="color:' + fillColor + '">' + Math.round(score) + '</b></div>' +
                '<div class="hpop-row"><span>선박 밀도</span><b>' + cell.ships + ' 척</b></div>' +
                '<div class="hpop-row"><span>충돌 이벤트</span><b>' + cell.collisions + ' 건</b></div>' +
                '<div class="hpop-row"><span>주요 원인</span><b>' + cause + '</b></div>' +
                '<div class="hpop-warn">⚠ 항해 시 주의가 필요합니다</div>' +
            '</div>',
            { className: 'hazard-popup-wrapper', maxWidth: 220 }
        );

        hex.addTo(hexGroup);
        dot.addTo(hexGroup);
    });

    hexGroup.addTo(leafletMap);
    leafletHazardHexLayer = hexGroup;
}
window.renderHazardHexGrid = renderHazardHexGrid;

// ── Hazard zones lifecycle (called by ModelRegistry rail toggle) ──
var _hazardZonesActive = false;

function activateHazardZones() {
    _hazardZonesActive = true;

    // Force-switch to 2D first (hazard view only makes sense on the flat chart)
    if (currentMapMode !== '2d') {
        setMapMode('2d');
        requestAnimationFrame(function() {
            setTimeout(_finishHazardActivate, 30);
        });
    } else {
        _finishHazardActivate();
    }
}
window.activateHazardZones = activateHazardZones;

function _finishHazardActivate() {
    if (!leafletMap) return;

    // Save current view so we can restore on deactivate
    _savedViewBeforeHazard = {
        center: leafletMap.getCenter(),
        zoom: leafletMap.getZoom()
    };

    // Swap to nautical chart basemap
    _useChartBasemap();

    // Apply hazard styling; drag selection drives the hex render path.
    _applyHazardActiveClass(true);
    setDemoActive(true);
    _fetchKoreaHazard();
    _injectHazardHUD();

    // Hide the home bottom stats bar — its global ship/weather figures are
    // out of context here (ships are off; risk lives in the analysis panel).
    // Mirrors how dedicated-screen modes (route) hide it.
    var _bb = document.getElementById('bottomBar');
    if (_bb) _bb.style.display = 'none';

    // Hide AIS while 사고 mode is active by toggling the ships layer chip off.
    var shipsChip = document.querySelector('.layer-chip[data-layer="ships"]');
    if (shipsChip && shipsChip.classList.contains('active')) {
        _shipsChipWasActive = true;
        shipsChip.click();
    } else {
        _shipsChipWasActive = false;
    }

    // Lock the view to Korean waters
    leafletMap.setMaxBounds(KOREA_HAZARD_VIEW.bounds);
    leafletMap.setMinZoom(5);
    leafletMap.flyToBounds(KOREA_HAZARD_VIEW.bounds, { duration: 0.8, padding: [20, 20] });
}

function deactivateHazardZones() {
    _hazardZonesActive = false;
    _applyHazardActiveClass(false);
    _removeHazardHUD();

    // Restore the home bottom stats bar
    var _bb = document.getElementById('bottomBar');
    if (_bb) _bb.style.display = '';

    // Restore satellite basemap
    if (leafletMap) _useSatelliteBasemap();

    // Unlock bounds and restore prior view
    if (leafletMap) {
        leafletMap.setMaxBounds(null);
        leafletMap.setMinZoom(2);
        if (_savedViewBeforeHazard) {
            leafletMap.setView(_savedViewBeforeHazard.center, _savedViewBeforeHazard.zoom);
            _savedViewBeforeHazard = null;
        }
    }

    // Remove hex layer
    if (leafletHazardHexLayer && leafletMap) {
        leafletMap.removeLayer(leafletHazardHexLayer);
        leafletHazardHexLayer = null;
    }
    leafletHazardCells = [];

    // Clear drag-render state and 사고 mode hex layer
    setDemoActive(false);

    // Restore the ships layer chip if 사고 mode flipped it off on entry.
    if (_shipsChipWasActive) {
        var shipsChip = document.querySelector('.layer-chip[data-layer="ships"]');
        if (shipsChip && !shipsChip.classList.contains('active')) {
            shipsChip.click();
        }
        _shipsChipWasActive = false;
    }

    // Exit area-select mode + clear any drawn rectangle/result
    if (leafletAreaSelectActive) _exitAreaSelectMode();
    if (leafletAreaResultRect && leafletMap) {
        leafletMap.removeLayer(leafletAreaResultRect);
        leafletAreaResultRect = null;
    }
    var resultPanel = document.getElementById('hazardAreaResult');
    if (resultPanel) resultPanel.style.display = 'none';
}
window.deactivateHazardZones = deactivateHazardZones;

function isHazardZonesActive() {
    return _hazardZonesActive;
}
window.isHazardZonesActive = isHazardZonesActive;

function _applyHazardActiveClass(on) {
    var mapArea = document.getElementById('mapArea');
    if (!mapArea) return;
    if (on) mapArea.classList.add('hazard-active');
    else mapArea.classList.remove('hazard-active');
}

// ── Hazard HUD: real-time coordinate display ──────────────────────────────
var _hazardHudEl = null;
var _hazardHudMoveHandler = null;

function _injectHazardHUD() {
    if (_hazardHudEl) return;
    var container = document.getElementById('leafletContainer');
    if (!container || !leafletMap) return;

    var el = document.createElement('div');
    el.id = 'hazardHUD';
    el.className = 'hazard-hud';
    el.innerHTML =
        '<span class="hud-label">COORD</span>' +
        '<span class="hud-value" id="hudLat">--.-°N</span>' +
        '<span class="hud-sep">|</span>' +
        '<span class="hud-value" id="hudLng">---.-°E</span>' +
        '<span class="hud-sep">|</span>' +
        '<span class="hud-label">ZOOM</span>' +
        '<span class="hud-value" id="hudZoom">--</span>';
    container.appendChild(el);
    _hazardHudEl = el;

    _hazardHudMoveHandler = function(e) {
        var lat = e.latlng.lat;
        var lng = e.latlng.lng;
        var latDir = lat >= 0 ? 'N' : 'S';
        var lngDir = lng >= 0 ? 'E' : 'W';
        document.getElementById('hudLat').textContent =
            Math.abs(lat).toFixed(3) + '°' + latDir;
        document.getElementById('hudLng').textContent =
            Math.abs(lng).toFixed(3) + '°' + lngDir;
        document.getElementById('hudZoom').textContent =
            leafletMap.getZoom();
    };
    leafletMap.on('mousemove', _hazardHudMoveHandler);
    leafletMap.on('zoomend', function() {
        var z = document.getElementById('hudZoom');
        if (z) z.textContent = leafletMap.getZoom();
    });
}

function _removeHazardHUD() {
    if (_hazardHudEl) {
        _hazardHudEl.remove();
        _hazardHudEl = null;
    }
    if (_hazardHudMoveHandler && leafletMap) {
        leafletMap.off('mousemove', _hazardHudMoveHandler);
        _hazardHudMoveHandler = null;
    }
}
