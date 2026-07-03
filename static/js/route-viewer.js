// static/js/route-viewer.js
// ── OVERWATCH 4D — Route Viewer ──
// Dedicated screen for visualizing domestic customary shipping routes on a
// self-contained 2D nautical map (Leaflet + CARTO Positron + OpenSeaMap),
// independent of the home 3D globe.

var RouteViewer = (function() {

    // ── State ──
    var active = false;
    var routeCoords = [];       // [[lng, lat], ...] interpolated
    var totalDistanceKm = 0;

    // Animation state
    var animFrameId = null;
    var playing = false;
    var progress = 0;           // 0..1
    var speedKts = 14;
    var playbackRate = 500;     // x1, x10, x100, x500, x2k
    var lastFrameTime = null;

    // Ship size class (vessel length, m) — forwarded to the future depth-aware
    // route model. Bigger ships draw deeper, so navigable waters differ by class.
    var shipSizeClass = 'C';
    var SHIP_SIZE_CLASSES = {
        A: '1–20 m', B: '21–40 m', C: '41–80 m', D: '81–200 m', E: '201 m 이상'
    };

    // Curated major Korean ports — helps users who don't know port names pick
    // visually (map markers) or from a focus suggestion list. { ko, lat, lng }.
    var KR_PORTS = [
        { ko: '부산',   lat: 35.10, lng: 129.04 },
        { ko: '인천',   lat: 37.47, lng: 126.62 },
        { ko: '울산',   lat: 35.50, lng: 129.38 },
        { ko: '광양',   lat: 34.90, lng: 127.70 },
        { ko: '여수',   lat: 34.75, lng: 127.75 },
        { ko: '평택·당진', lat: 36.97, lng: 126.82 },
        { ko: '목포',   lat: 34.78, lng: 126.38 },
        { ko: '포항',   lat: 36.04, lng: 129.39 },
        { ko: '군산',   lat: 35.98, lng: 126.60 },
        { ko: '대산',   lat: 37.00, lng: 126.36 },
        { ko: '마산',   lat: 35.20, lng: 128.58 },
        { ko: '통영',   lat: 34.84, lng: 128.42 },
        { ko: '제주',   lat: 33.52, lng: 126.54 },
        { ko: '서귀포', lat: 33.24, lng: 126.56 },
        { ko: '동해',   lat: 37.49, lng: 129.14 },
        { ko: '속초',   lat: 38.21, lng: 128.60 },
        { ko: '완도',   lat: 34.31, lng: 126.76 }
    ];
    var routePortMarkers = null;  // Leaflet layerGroup of KR port markers
    var routePortMarkerList = [];  // [{ p, marker }] for per-port visibility control

    // Assign a port to the from/to slot and sync its input/coord display.
    function assignPort(slot, port) {
        var inId = slot === 'from' ? 'routeFromInput' : 'routeToInput';
        var coId = slot === 'from' ? 'routeFromCoord' : 'routeToCoord';
        if (slot === 'from') fromPort = port; else toPort = port;
        var input = document.getElementById(inId);
        var coord = document.getElementById(coId);
        if (input) input.value = port.name;
        if (coord) coord.textContent = port.lat.toFixed(4) + ', ' + port.lng.toFixed(4);
        setEmptyHint(false);  // a port is chosen — drop the guidance card
        updateSearchBtn();
        // Only recenter when the point is off-screen — panning on every pick makes
        // map clicking feel jumpy.
        if (routeMap && !routeMap.getBounds().contains([port.lat, port.lng])) {
            routeMap.panTo([port.lat, port.lng]);
        }
    }

    // Which slot the next map/marker click will fill (clickMode wins, else the
    // next empty slot; null once both are set).
    function activeTargetSlot() {
        if (clickMode === 'from' || clickMode === 'to') return clickMode;
        if (!fromPort) return 'from';
        if (!toPort) return 'to';
        return null;
    }

    // Unified pick from a map click or a port marker. Fills the active slot and
    // ignores stray clicks once both ends are set (re-arm via the crosshair btns).
    function pickLocation(lat, lng, name) {
        var slot = activeTargetSlot();
        if (!slot) return false;
        assignPort(slot, { name: name, lat: lat, lng: lng });
        clickMode = null;
        updateClickBtnStates();
        return true;
    }

    function pickPort(p) {
        pickLocation(p.lat, p.lng, p.ko);
    }

    function addKoreanPortMarkers() {
        if (!routeMap || routePortMarkers) return;
        routePortMarkers = L.layerGroup().addTo(routeMap);
        // The map uses a canvas renderer (preferCanvas), where hit-testing small
        // circle markers is unreliable. Render the port markers as SVG so hover
        // and click are crisp.
        var svgRenderer = L.svg({ padding: 0.5 });
        KR_PORTS.forEach(function(p) {
            var m = L.circleMarker([p.lat, p.lng], {
                renderer: svgRenderer,
                radius: 6,
                color: '#ffffff',
                weight: 1.5,
                fillColor: '#4d9bff',
                fillOpacity: 0.95,
                bubblingMouseEvents: false  // don't also trigger the map click
            });
            m.bindTooltip(p.ko, {
                permanent: true,
                direction: 'right',
                offset: [6, 0],
                className: 'route-port-tip',
                interactive: true  // clicking/hovering the name tag also selects the port
            });
            m.on('click', function() { pickPort(p); });
            m.on('mouseover', function() {
                // Preview the pick: green if this click sets 출발, red if 도착.
                var slot = activeTargetSlot();
                var c = slot === 'from' ? '#10b981' : slot === 'to' ? '#ef4444' : '#d9a441';
                m.setStyle({ radius: 8, fillColor: c });
            });
            m.on('mouseout', function() { m.setStyle({ radius: 6, fillColor: '#4d9bff' }); });
            routePortMarkers.addLayer(m);
            routePortMarkerList.push({ p: p, marker: m });
        });
        // Hide labels when zoomed out so they don't crowd.
        var mapEl = document.getElementById('route-leaflet');
        function syncLabelVisibility() {
            if (mapEl) mapEl.classList.toggle('route-hide-port-labels', routeMap.getZoom() < 7);
        }
        routeMap.on('zoomend', syncLabelVisibility);
        syncLabelVisibility();
    }

    // Hide the cyan KR port marker(s) that coincide with the current from/to ports
    // while a route is drawn, so its name label doesn't duplicate the 출발/도착 pin.
    function syncPortMarkerVisibility(hideSelected) {
        if (!routePortMarkers) return;
        var EPS = 0.05;
        function near(port, p) {
            return port && Math.abs(p.lat - port.lat) < EPS && Math.abs(p.lng - port.lng) < EPS;
        }
        routePortMarkerList.forEach(function(entry) {
            var coincides = near(fromPort, entry.p) || near(toPort, entry.p);
            var shouldShow = !(hideSelected && coincides);
            var shown = routePortMarkers.hasLayer(entry.marker);
            if (shouldShow && !shown) routePortMarkers.addLayer(entry.marker);
            else if (!shouldShow && shown) routePortMarkers.removeLayer(entry.marker);
        });
    }

    // Search state
    var fromPort = null;        // { name, lat, lng }
    var toPort = null;
    var clickMode = null;       // 'from' | 'to' | null

    // Layers to hide/restore (legacy globe-mode helpers, retained but unused)
    var hiddenLayers = [];

    // ── 2D route map (domestic customary-route view) ──
    // Self-contained Leaflet instance living inside the route dedicated screen,
    // with a nautical-chart basemap. Independent of the home map so the home
    // globe stays untouched.
    var routeMap = null;
    var routeLine = null;
    var routeFromMarker = null;
    var routeToMarker = null;
    var routeShipMarker = null;
    var _routeMapClickBound = false;

    // UI built flag
    var uiBuilt = false;
    // Events wired flag
    var eventsWired = false;

    // ── Constants ──
    var KTS_TO_KMH = 1.852;
    var ROUTE_ALT = 500;

    // ── Route smoothing (Centripetal Catmull-Rom on the unit sphere) ──
    // searoute returns sparse network vertices; drawing straight segments between
    // them looks angular. We round the corners with a centripetal Catmull-Rom
    // spline computed in 3D on the unit sphere, then renormalize each sample back
    // onto the sphere. Working in 3D rather than lon/lat gives geodesic-like
    // curvature on long legs for free and sidesteps antimeridian wrap entirely.
    var SMOOTH_SEG_KM = 25;      // target spacing between sampled points (km)
    var SMOOTH_MIN_PER_SEG = 3;  // min samples per original segment
    var SMOOTH_MAX_PER_SEG = 80; // cap so very long legs stay bounded

    function _lonLatToVec(c) {
        var lng = c[0] * Math.PI / 180, lat = c[1] * Math.PI / 180;
        var cl = Math.cos(lat);
        return [cl * Math.cos(lng), cl * Math.sin(lng), Math.sin(lat)];
    }
    function _vecToLonLat(v) {
        var len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
        var x = v[0] / len, y = v[1] / len, z = v[2] / len;
        var lat = Math.asin(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
        var lng = Math.atan2(y, x) * 180 / Math.PI;
        return [round6(lng), round6(lat)];
    }
    function round6(n) { return Math.round(n * 1e6) / 1e6; }
    function _vecDist(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    // Approximate great-circle distance (km) between two unit vectors via chord length.
    function _vecKm(a, b) { return 2 * 6371 * Math.asin(Math.min(1, _vecDist(a, b) / 2)); }

    // Centripetal Catmull-Rom point for params t0..t3 at u, in 3D.
    function _crPoint(p0, p1, p2, p3, t0, t1, t2, t3, u) {
        function lerp(a, b, s) { return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]; }
        var A1 = lerp(p0, p1, (u - t0) / (t1 - t0));
        var A2 = lerp(p1, p2, (u - t1) / (t2 - t1));
        var A3 = lerp(p2, p3, (u - t2) / (t3 - t2));
        var B1 = lerp(A1, A2, (u - t0) / (t2 - t0));
        var B2 = lerp(A2, A3, (u - t1) / (t3 - t1));
        return lerp(B1, B2, (u - t1) / (t2 - t1));
    }

    function smoothRouteCoords(coords) {
        if (!coords || coords.length < 3) return coords || [];
        // Drop consecutive duplicates (zero-length segments break the parameterization).
        var pts = [coords[0]];
        for (var k = 1; k < coords.length; k++) {
            var prev = pts[pts.length - 1];
            if (Math.abs(coords[k][0] - prev[0]) > 1e-9 || Math.abs(coords[k][1] - prev[1]) > 1e-9) {
                pts.push(coords[k]);
            }
        }
        if (pts.length < 3) return pts;

        var V = pts.map(_lonLatToVec);
        // Pad endpoints by reflection so the curve reaches the first/last vertex.
        var P = [V[0]].concat(V, [V[V.length - 1]]);
        var alpha = 0.5; // centripetal
        var out = [pts[0]];
        for (var i = 1; i < P.length - 2; i++) {
            var p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
            var t0 = 0;
            var t1 = t0 + Math.pow(_vecDist(p0, p1) || 1e-6, alpha);
            var t2 = t1 + Math.pow(_vecDist(p1, p2) || 1e-6, alpha);
            var t3 = t2 + Math.pow(_vecDist(p2, p3) || 1e-6, alpha);
            var segKm = _vecKm(p1, p2);
            var n = Math.max(SMOOTH_MIN_PER_SEG, Math.min(SMOOTH_MAX_PER_SEG, Math.ceil(segKm / SMOOTH_SEG_KM)));
            for (var s = 1; s <= n; s++) {
                var u = t1 + (t2 - t1) * (s / n);
                out.push(_vecToLonLat(_crPoint(p0, p1, p2, p3, t0, t1, t2, t3, u)));
            }
        }
        return out;
    }
    var SHIP_ICON_URL = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">' +
        '<polygon points="16,2 28,28 16,22 4,28" fill="#eab308" stroke="#a16207" stroke-width="1.5"/>' +
        '</svg>'
    );

    // Major sea regions / straits — [name, minLng, minLat, maxLng, maxLat]
    var SEA_REGIONS = [
        ['말라카 해협', 98.0, 0.5, 104.5, 4.5],
        ['수에즈 운하', 32.0, 29.5, 33.0, 31.5],
        ['파나마 운하', -80.5, 8.5, -79.0, 9.5],
        ['남중국해', 105.0, 3.0, 121.0, 23.0],
        ['동중국해', 120.0, 23.0, 132.0, 33.0],
        ['대한해협', 128.0, 33.5, 130.5, 35.5],
        ['홍해', 32.0, 12.0, 44.0, 29.5],
        ['아라비아해', 50.0, 8.0, 77.0, 25.0],
        ['벵골만', 77.0, 5.0, 100.0, 23.0],
        ['지중해', -6.0, 30.0, 36.5, 46.0],
        ['인도양', 40.0, -40.0, 100.0, 8.0],
        ['태평양', 120.0, -50.0, 180.0, 50.0],
        ['대서양', -80.0, -50.0, 0.0, 60.0],
        ['호르무즈 해협', 54.0, 25.5, 57.5, 27.5],
        ['바시 해협', 119.0, 19.5, 123.0, 22.0],
    ];

    function detectSeaRegions(coords) {
        var found = [];
        for (var r = 0; r < SEA_REGIONS.length; r++) {
            var reg = SEA_REGIONS[r];
            for (var i = 0; i < coords.length; i++) {
                var lng = coords[i][0], lat = coords[i][1];
                if (lng >= reg[1] && lat >= reg[2] && lng <= reg[3] && lat <= reg[4]) {
                    found.push(reg[0]);
                    break;
                }
            }
        }
        return found;
    }

    // ── UI Building ──
    function buildUI() {
        var container = document.getElementById('dedicated-route-inference');
        if (!container || uiBuilt) return;
        uiBuilt = true;

        var wrap = document.createElement('div');
        wrap.className = 'route-viewer-wrap';
        wrap.style.cssText = 'position:relative;width:100%;height:100%;pointer-events:none;';

        // Search panel overlay (top-left)
        var searchPanel = document.createElement('div');
        searchPanel.id = 'route-search-panel';
        searchPanel.className = 'route-overlay-panel';
        searchPanel.innerHTML =
            '<div class="route-panel-header">' +
                '<span class="route-panel-title">관습 항로 추론</span>' +
                '<button id="routePanelToggle" class="route-panel-toggle" title="접기"><i class="fa-solid fa-chevron-up"></i></button>' +
            '</div>' +
            '<div id="routePanelBody" class="route-panel-body">' +
                // ── Section: 구간 (origin → destination itinerary rail) ──
                // The left spine (green origin node · dotted leg · red destination
                // node) mirrors the map's start/end pin colors, so the panel reads
                // as one journey rather than two identical inputs.
                '<div class="route-section">' +
                    '<div class="route-eyebrow">구간</div>' +
                    '<div class="route-rail">' +
                        '<div class="route-rail-fields">' +
                            '<div class="route-input-group">' +
                                '<div class="route-input-row">' +
                                    '<span class="route-node route-node-from"></span>' +
                                    '<input type="text" id="routeFromInput" placeholder="출발 항구 검색..." autocomplete="off">' +
                                    '<button id="routeFromClick" class="route-click-btn" title="지도에서 직접 클릭(위경도 지정)"><i class="fa-solid fa-crosshairs"></i></button>' +
                                    '<div id="routeFromDropdown" class="route-dropdown"></div>' +
                                '</div>' +
                                '<div id="routeFromCoord" class="route-coord-display"></div>' +
                            '</div>' +
                            '<div class="route-input-group">' +
                                '<div class="route-input-row">' +
                                    '<span class="route-node route-node-to"></span>' +
                                    '<input type="text" id="routeToInput" placeholder="도착 항구 검색..." autocomplete="off">' +
                                    '<button id="routeToClick" class="route-click-btn" title="지도에서 직접 클릭(위경도 지정)"><i class="fa-solid fa-crosshairs"></i></button>' +
                                    '<div id="routeToDropdown" class="route-dropdown"></div>' +
                                '</div>' +
                                '<div id="routeToCoord" class="route-coord-display"></div>' +
                            '</div>' +
                        '</div>' +
                        '<button id="routeSwapBtn" class="route-swap-btn" title="출발·도착 교체"><i class="fa-solid fa-arrow-right-arrow-left fa-rotate-90"></i></button>' +
                    '</div>' +
                '</div>' +
                // ── Section: 운항 조건 (speed · ship size) ──
                '<div class="route-section">' +
                    '<div class="route-eyebrow">운항 조건</div>' +
                    '<div class="route-input-group">' +
                        '<div class="route-field-head">' +
                            '<label>속도</label>' +
                            '<span class="route-readout"><span id="routeSpeedLabel">14</span> kts</span>' +
                        '</div>' +
                        '<input type="range" id="routeSpeedSlider" min="5" max="30" value="14" step="1">' +
                    '</div>' +
                    '<div class="route-input-group">' +
                        '<div class="route-field-head">' +
                            '<label>선박 크기 <span class="route-size-hint">(길이)</span></label>' +
                            '<span class="route-size-range" id="routeSizeRange">C · 41–80 m</span>' +
                        '</div>' +
                        '<div class="route-size-btns" id="routeSizeBtns">' +
                            '<button class="route-size-btn" data-size="A" title="1–20 m">A</button>' +
                            '<button class="route-size-btn" data-size="B" title="21–40 m">B</button>' +
                            '<button class="route-size-btn active" data-size="C" title="41–80 m">C</button>' +
                            '<button class="route-size-btn" data-size="D" title="81–200 m">D</button>' +
                            '<button class="route-size-btn" data-size="E" title="201 m 이상">E</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="route-action-row">' +
                    '<button id="routeSearchBtn" class="route-search-btn" disabled>경로 검색</button>' +
                    '<button id="routeResetBtn" class="route-reset-btn" title="출발·도착 초기화"><i class="fa-solid fa-rotate-left"></i></button>' +
                '</div>' +
                '<div id="routeError" class="route-error"></div>' +
            '</div>';
        wrap.appendChild(searchPanel);

        // Playback bar (bottom center, compact)
        var playbar = document.createElement('div');
        playbar.id = 'route-playbar';
        playbar.className = 'route-overlay-panel route-playbar';
        playbar.style.display = 'none';
        playbar.innerHTML =
            '<div class="route-playbar-top">' +
                '<button id="routePlayBtn" class="route-play-btn" title="재생"><i class="fa-solid fa-play"></i></button>' +
                '<span class="route-time" id="routeTimeNow">0</span>' +
                '<div class="route-progress-wrap">' +
                    '<div class="route-progress-bar">' +
                        '<div id="routeProgressFill" class="route-progress-fill"><span class="route-progress-thumb"></span></div>' +
                        '<input type="range" id="routeProgressSlider" min="0" max="1000" value="0" class="route-progress-slider">' +
                    '</div>' +
                '</div>' +
                '<span class="route-time route-time-total" id="routeTimeTotal">--</span>' +
                '<div class="route-speed-btns">' +
                    '<button class="route-rate-btn" data-rate="1">x1</button>' +
                    '<button class="route-rate-btn" data-rate="10">x10</button>' +
                    '<button class="route-rate-btn" data-rate="100">x100</button>' +
                    '<button class="route-rate-btn active" data-rate="500">x500</button>' +
                    '<button class="route-rate-btn" data-rate="2000">x2k</button>' +
                '</div>' +
            '</div>';
        wrap.appendChild(playbar);

        // Route info panel (right side)
        var infoPanel = document.createElement('div');
        infoPanel.id = 'route-info-panel';
        infoPanel.className = 'route-overlay-panel route-info-panel';
        infoPanel.style.display = 'none';
        infoPanel.innerHTML =
            '<div class="route-panel-header">' +
                '<span class="route-panel-title">경로 정보</span>' +
            '</div>' +
            '<div class="route-info-body">' +
                '<div class="route-info-route-name">' +
                    '<span id="routeInfoFrom">--</span>' +
                    ' <span class="route-info-arrow">\u2192</span> ' +
                    '<span id="routeInfoTo">--</span>' +
                '</div>' +
                '<div class="route-info-grid">' +
                    '<div class="route-info-item">' +
                        '<div class="route-info-label">총 거리</div>' +
                        '<div class="route-info-value" id="routeInfoDist">--</div>' +
                    '</div>' +
                    '<div class="route-info-item">' +
                        '<div class="route-info-label">예상 소요</div>' +
                        '<div class="route-info-value" id="routeInfoTime">--</div>' +
                    '</div>' +
                    '<div class="route-info-item">' +
                        '<div class="route-info-label">운항 속도</div>' +
                        '<div class="route-info-value" id="routeInfoSpeed">--</div>' +
                    '</div>' +
                    '<div class="route-info-item">' +
                        '<div class="route-info-label">예상 도착</div>' +
                        '<div class="route-info-value" id="routeInfoETA">--</div>' +
                    '</div>' +
                '</div>' +
                '<div class="route-info-sea-section">' +
                    '<div class="route-info-label">통과 해역</div>' +
                    '<div class="route-info-sea-tags" id="routeInfoSeas">--</div>' +
                '</div>' +
            '</div>';
        wrap.appendChild(infoPanel);

        // Empty-state guidance — shown before a route is generated so the cleared
        // globe reads as "route mode awaiting input" rather than a broken home screen.
        var emptyHint = document.createElement('div');
        emptyHint.id = 'route-empty-hint';
        emptyHint.className = 'route-empty-hint';
        emptyHint.innerHTML =
            '<div class="screen-empty-card">' +
                '<i class="fa-solid fa-route"></i>' +
                '<div class="screen-empty-title">관습 항로 추론</div>' +
                '<div class="screen-empty-sub">출발 · 도착 항구를 선택해<br>항로를 생성하세요</div>' +
            '</div>';
        wrap.appendChild(emptyHint);

        container.appendChild(wrap);
    }

    // Toggle the empty-state guidance.
    function setEmptyHint(show) {
        var el = document.getElementById('route-empty-hint');
        if (el) el.classList.toggle('active', !!show);
    }

    // ── Port Search (client-side cached) ──
    var _portCache = null;
    var _portCacheLoading = false;
    var _portKoMap = {
        '부산': 'busan', '인천': 'incheon', '울산': 'ulsan', '여수': 'yeosu',
        '광양': 'gwangyang', '목포': 'mokpo', '평택': 'pyeongtaek', '마산': 'masan',
        '포항': 'pohang', '동해': 'donghae', '속초': 'sokcho', '제주': 'jeju',
        '군산': 'gunsan', '대산': 'daesan', '통영': 'tongyeong', '거제': 'geoje',
        '진해': 'jinhae', '완도': 'wando', '서귀포': 'seogwipo',
        '싱가포르': 'singapore', '상하이': 'shanghai', '도쿄': 'tokyo',
        '요코하마': 'yokohama', '오사카': 'osaka', '홍콩': 'hong kong',
        '로테르담': 'rotterdam', '함부르크': 'hamburg', '두바이': 'dubai',
    };

    function _loadPortCache(callback) {
        if (_portCache) { callback(); return; }
        if (_portCacheLoading) return;
        _portCacheLoading = true;
        fetch('/api/v1/ports/all')
            .then(function(r) { return r.json(); })
            .then(function(ports) {
                _portCache = ports;
                _portCacheLoading = false;
                callback();
            })
            .catch(function() { _portCacheLoading = false; });
    }

    function _searchPortsLocal(query) {
        if (!_portCache) return [];
        var q = query.toLowerCase();
        // Korean → English mapping
        var mapped = _portKoMap[query] || _portKoMap[q];
        var searchTerm = mapped || q;

        var results = [];
        for (var i = 0; i < _portCache.length; i++) {
            var p = _portCache[i];
            var nameLower = p.name.toLowerCase();
            if (nameLower.indexOf(searchTerm) !== -1) {
                var score = nameLower.startsWith(searchTerm) ? 0 : 1;
                results.push({ score: score, port: p });
            }
        }
        results.sort(function(a, b) { return a.score - b.score || a.port.name.localeCompare(b.port.name); });
        return results.slice(0, 10).map(function(r) { return r.port; });
    }

    function setupSearch(inputId, dropdownId, coordId, which) {
        var input = document.getElementById(inputId);
        var dropdown = document.getElementById(dropdownId);
        var coordDisplay = document.getElementById(coordId);
        if (!input || !dropdown) return;

        var highlightIdx = -1;

        function selectPort(item) {
            if (!item || item.classList.contains('disabled')) return;
            var port = {
                name: item.dataset.name,
                lat: parseFloat(item.dataset.lat),
                lng: parseFloat(item.dataset.lng),
            };
            input.value = port.name;
            dropdown.style.display = 'none';
            coordDisplay.textContent = port.lat.toFixed(4) + ', ' + port.lng.toFixed(4);
            if (which === 'from') {
                fromPort = port;
                var toInput = document.getElementById('routeToInput');
                if (toInput && !toPort) toInput.focus();
            } else {
                toPort = port;
                var slider = document.getElementById('routeSpeedSlider');
                if (slider) slider.focus();
            }
            setEmptyHint(false);  // a port is chosen — drop the guidance hint
            updateSearchBtn();
            updateClickHint();
            highlightIdx = -1;
            if (routeMap) routeMap.panTo([port.lat, port.lng]);
        }

        function updateHighlight() {
            var items = dropdown.querySelectorAll('.route-dropdown-item:not(.disabled)');
            items.forEach(function(el, i) {
                el.classList.toggle('highlighted', i === highlightIdx);
            });
        }

        function renderResults(q) {
            var ports = _searchPortsLocal(q);
            if (!ports.length) {
                dropdown.innerHTML = '<div class="route-dropdown-item disabled">일치하는 항구가 없습니다</div>';
                dropdown.style.display = 'block';
                return;
            }
            dropdown.innerHTML = ports.map(function(p) {
                return '<div class="route-dropdown-item" data-name="' + p.name + '" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-country="' + p.country + '">' +
                    '<strong>' + p.name + '</strong> <span class="route-port-country">' + p.country + '</span>' +
                '</div>';
            }).join('');
            dropdown.style.display = 'block';
            highlightIdx = 0;
            updateHighlight();
        }

        // Focus suggestions: when the field is empty, surface major Korean ports
        // so users who don't know port names can pick without typing.
        function renderKoreanSuggestions() {
            dropdown.innerHTML =
                '<div class="route-dropdown-head">주요 국내 항구</div>' +
                KR_PORTS.map(function(p) {
                    return '<div class="route-dropdown-item" data-name="' + p.ko + '" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-country="KR">' +
                        '<strong>' + p.ko + '</strong> <span class="route-port-country">KR</span>' +
                    '</div>';
                }).join('');
            dropdown.style.display = 'block';
            highlightIdx = -1;
        }

        input.addEventListener('focus', function() {
            if (input.value.trim().length < 1) renderKoreanSuggestions();
        });

        input.addEventListener('input', function() {
            var q = input.value.trim();
            highlightIdx = -1;
            if (q.length < 1) { renderKoreanSuggestions(); return; }
            if (_portCache) {
                renderResults(q);
            } else {
                _loadPortCache(function() { renderResults(q); });
            }
        });

        input.addEventListener('keydown', function(e) {
            var items = dropdown.querySelectorAll('.route-dropdown-item:not(.disabled)');
            if (!items.length || dropdown.style.display === 'none') return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
                updateHighlight();
                if (items[highlightIdx]) items[highlightIdx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                highlightIdx = Math.max(highlightIdx - 1, 0);
                updateHighlight();
                if (items[highlightIdx]) items[highlightIdx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightIdx >= 0 && items[highlightIdx]) {
                    selectPort(items[highlightIdx]);
                } else if (items[0]) {
                    selectPort(items[0]);
                }
            } else if (e.key === 'Escape') {
                dropdown.style.display = 'none';
                highlightIdx = -1;
            }
        });

        dropdown.addEventListener('click', function(e) {
            selectPort(e.target.closest('.route-dropdown-item'));
        });

        document.addEventListener('click', function(e) {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
                highlightIdx = -1;
            }
        });
    }

    // ── Globe Click Mode ──
    function setupClickMode() {
        var fromBtn = document.getElementById('routeFromClick');
        var toBtn = document.getElementById('routeToClick');

        if (fromBtn) fromBtn.addEventListener('click', function() { toggleClickMode('from'); });
        if (toBtn) toBtn.addEventListener('click', function() { toggleClickMode('to'); });
    }

    function toggleClickMode(which) {
        if (clickMode === which) {
            clickMode = null;
            updateClickBtnStates();
            return;
        }
        clickMode = which;
        updateClickBtnStates();
    }

    function updateClickBtnStates() {
        var fromBtn = document.getElementById('routeFromClick');
        var toBtn = document.getElementById('routeToClick');
        if (fromBtn) fromBtn.classList.toggle('active', clickMode === 'from');
        if (toBtn) toBtn.classList.toggle('active', clickMode === 'to');

        // Change cursor on the route map
        var mapEl = document.getElementById('route-leaflet');
        if (mapEl) {
            mapEl.style.cursor = clickMode ? 'crosshair' : '';
        }
        updateClickHint();
    }

    // Floating banner telling the user whether the next click sets 출발 or 도착.
    function updateClickHint() {
        var slot = activeTargetSlot();
        // Reflect the active slot on the map container so port name-tag hover
        // colors (CSS) match the marker-dot hover preview.
        var mapEl = document.getElementById('route-leaflet');
        if (mapEl) {
            mapEl.classList.remove('route-target-from', 'route-target-to');
            if (slot) mapEl.classList.add('route-target-' + slot);
        }
        var el = document.getElementById('route-click-hint');
        if (!el) return;
        if (!slot) { el.classList.remove('active'); return; }
        var isFrom = slot === 'from';
        el.innerHTML =
            '<span class="rp-tag ' + (isFrom ? 'rp-from' : 'rp-to') + '">' + (isFrom ? '출발' : '도착') + '</span>' +
            '<i class="fa-solid fa-hand-pointer"></i> 지도에서 ' + (isFrom ? '출발' : '도착') + ' 항구를 클릭하세요';
        el.className = 'route-click-hint active ' + (isFrom ? 'hint-from' : 'hint-to');
    }

    var ROUTE_BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    // Create (or re-show) the self-contained nautical 2D map for the route screen.
    function initRouteMap() {
        var container = document.getElementById('dedicated-route-inference');
        if (!container || typeof L === 'undefined') return;

        if (routeMap) {
            // Already built \u2014 the dedicated view was just re-shown; recompute size
            // (twice: once now, once after the screen's slide-in transition).
            _refreshRouteMapSize();
            return;
        }

        var mapEl = document.getElementById('route-leaflet');
        if (!mapEl) {
            mapEl = document.createElement('div');
            mapEl.id = 'route-leaflet';
            container.insertBefore(mapEl, container.firstChild);
        }

        routeMap = L.map(mapEl, {
            center: [35.5, 128.5],   // Korean waters \u2014 domestic customary routes
            zoom: 6,
            minZoom: 3,
            maxZoom: 18,
            zoomControl: true,
            attributionControl: false,
            preferCanvas: true,
            worldCopyJump: true
        });
        // Move zoom control clear of the top-left search panel.
        if (routeMap.zoomControl) routeMap.zoomControl.setPosition('bottomright');

        // Satellite basemap — same look/tone as the home 2D map (ArcGIS World
        // Imagery + CARTO dark labels). The `basemap-satellite` class applies the
        // shared dark tile-pane filter (main.css) for tonal consistency.
        mapEl.classList.add('basemap-satellite');
        L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            { maxZoom: 19, errorTileUrl: ROUTE_BLANK_TILE }
        ).addTo(routeMap);
        L.tileLayer(
            'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
            { maxZoom: 19, subdomains: 'abcd', pane: 'overlayPane', errorTileUrl: ROUTE_BLANK_TILE }
        ).addTo(routeMap);

        setupRouteMapClick();
        addKoreanPortMarkers();
        _refreshRouteMapSize();
    }

    // Recompute Leaflet's size after the dedicated screen becomes visible /
    // finishes its slide-in transition (it measures 0 while display:none).
    function _refreshRouteMapSize() {
        [60, 250, 480].forEach(function(ms) {
            setTimeout(function() { if (routeMap) routeMap.invalidateSize(); }, ms);
        });
    }

    function setupRouteMapClick() {
        if (!routeMap || _routeMapClickBound) return;
        _routeMapClickBound = true;
        routeMap.on('click', function(e) {
            // Arbitrary lat/lng picking only when the crosshair button is armed \u2014
            // otherwise a click that just misses a port would select open water.
            if (!clickMode) return;
            var lat = e.latlng.lat, lng = e.latlng.lng;
            pickLocation(lat, lng, lat.toFixed(2) + '\u00b0, ' + lng.toFixed(2) + '\u00b0');
        });
    }

    function destroyGlobeClickHandler() {
        // Leaflet click handler lives with routeMap; nothing to tear down here.
        clickMode = null;
    }

    // ── Route Search ──
    function updateSearchBtn() {
        var btn = document.getElementById('routeSearchBtn');
        if (btn) btn.disabled = !(fromPort && toPort);
    }

    function setupSearchButton() {
        var btn = document.getElementById('routeSearchBtn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            if (!fromPort || !toPort) return;

            // Same origin/dest check
            if (Math.abs(fromPort.lat - toPort.lat) < 0.01 && Math.abs(fromPort.lng - toPort.lng) < 0.01) {
                showError('출발지와 도착지가 같습니다');
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<span class="route-btn-spinner"></span> 검색 중...';
            showError('');

            // size_class is forward-compatible: the current searoute backend
            // ignores unknown query params; the future depth-aware model will use it.
            var url = '/api/v1/route?from_lat=' + fromPort.lat + '&from_lng=' + fromPort.lng +
                      '&to_lat=' + toPort.lat + '&to_lng=' + toPort.lng +
                      '&size_class=' + shipSizeClass;

            console.time('[Route] total');
            console.time('[Route] fetch');
            fetch(url)
                .then(function(r) {
                    if (!r.ok) throw new Error('경로를 찾을 수 없습니다');
                    return r.json();
                })
                .then(function(data) {
                    console.timeEnd('[Route] fetch');
                    // searoute can collapse two nearby / same-area ports onto a single
                    // network node, returning a degenerate <2-point "route". There's no
                    // navigable path to draw — a straight line would cut across land —
                    // so warn instead of rendering. (e.g. 속초↔동해)
                    if (!data.coordinates || data.coordinates.length < 2) {
                        clearRoute();
                        hidePlaybar();
                        showError('이 구간의 항로를 계산할 수 없습니다. 두 항구가 너무 가깝거나 같은 해역일 수 있습니다.');
                        return;
                    }
                    // Smooth the sparse searoute vertices so the drawn line (and the
                    // ship that plays back along it) follows a natural, rounded path.
                    routeCoords = smoothRouteCoords(data.coordinates);
                    // Anchor the path to the actually-selected ports. searoute snaps
                    // origin/destination to its coarse (~0.1°) offshore network nodes,
                    // so its endpoints can sit far out at sea; pin the line to the real
                    // port coords instead so markers/ship don't float in open water.
                    _anchorRouteEnds();
                    totalDistanceKm = data.distance_km;
                    console.time('[Route] render');
                    renderRoute();
                    console.timeEnd('[Route] render');
                    showPlaybar();
                    updateInfoText();
                    console.time('[Route] flyTo');
                    flyToRoute();
                    console.timeEnd('[Route] flyTo');
                    console.timeEnd('[Route] total');
                })
                .catch(function(err) {
                    showError(err.message || '경로 검색 실패');
                })
                .finally(function() {
                    btn.disabled = false;
                    btn.textContent = '경로 검색';
                    updateSearchBtn();
                });
        });
    }

    function showError(msg) {
        var el = document.getElementById('routeError');
        if (el) el.textContent = msg;
    }

    // Clear the current selection + drawn route so the user can start a new one.
    function resetRoute() {
        fromPort = null;
        toPort = null;
        clickMode = null;
        routeCoords = [];
        totalDistanceKm = 0;
        ['routeFromInput', 'routeToInput'].forEach(function(id) {
            var e = document.getElementById(id); if (e) e.value = '';
        });
        ['routeFromCoord', 'routeToCoord'].forEach(function(id) {
            var e = document.getElementById(id); if (e) e.textContent = '';
        });
        clearRoute();          // removes line/markers, restores cyan markers, empty hint
        hidePlaybar();
        showError('');
        updateSearchBtn();
        updateClickBtnStates();  // refreshes cursor + the 출발/도착 hint
    }

    function setupResetButton() {
        var btn = document.getElementById('routeResetBtn');
        if (btn) btn.addEventListener('click', resetRoute);
    }

    // Reflect the current fromPort/toPort into their inputs + coord readouts
    // (used after a swap, where both slots change at once).
    function syncSlotInputs() {
        [['routeFromInput', 'routeFromCoord', fromPort],
         ['routeToInput',   'routeToCoord',   toPort]].forEach(function(s) {
            var input = document.getElementById(s[0]);
            var coord = document.getElementById(s[1]);
            if (input) input.value = s[2] ? s[2].name : '';
            if (coord) coord.textContent = s[2] ? (s[2].lat.toFixed(4) + ', ' + s[2].lng.toFixed(4)) : '';
        });
    }

    // Swap 출발 ↔ 도착. Only updates the inputs; the user re-runs 경로 검색 to
    // redraw (an already-drawn line reflects the previous direction until then).
    function setupSwap() {
        var btn = document.getElementById('routeSwapBtn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            if (!fromPort && !toPort) return;
            var tmp = fromPort; fromPort = toPort; toPort = tmp;
            syncSlotInputs();
            updateSearchBtn();
            updateClickHint();
        });
    }

    // Replace the searoute-snapped endpoints with the real selected port coords
    // (skip if already within ~3km so we don't add a redundant point).
    function _anchorRouteEnds() {
        if (routeCoords.length < 2) return;
        var EPS = 0.03;  // ~3km in degrees
        if (fromPort) {
            var f = routeCoords[0];
            if (Math.abs(f[0] - fromPort.lng) > EPS || Math.abs(f[1] - fromPort.lat) > EPS) {
                routeCoords.unshift([fromPort.lng, fromPort.lat]);
            }
        }
        if (toPort) {
            var l = routeCoords[routeCoords.length - 1];
            if (Math.abs(l[0] - toPort.lng) > EPS || Math.abs(l[1] - toPort.lat) > EPS) {
                routeCoords.push([toPort.lng, toPort.lat]);
            }
        }
    }

    // Teardrop pin image (shared by start/end markers)
    function _routePinImage(fillColor) {
        var c = document.createElement('canvas');
        c.width = 32; c.height = 40;
        var ctx = c.getContext('2d');
        ctx.beginPath();
        ctx.arc(16, 14, 10, Math.PI, 0, false);
        ctx.quadraticCurveTo(26, 28, 16, 38);
        ctx.quadraticCurveTo(6, 28, 6, 14);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(16, 14, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        return c.toDataURL();
    }

    function _pinIcon(fillColor) {
        return L.icon({
            iconUrl: _routePinImage(fillColor),
            iconSize: [28, 35],
            iconAnchor: [14, 35],
            tooltipAnchor: [0, -34]
        });
    }

    // ── Route Rendering on the 2D nautical map ──
    function renderRoute() {
        if (!routeMap) initRouteMap();
        if (!routeMap || routeCoords.length < 2) return;

        clearRoute();
        setEmptyHint(false);  // a route now exists

        // [lng,lat] → Leaflet [lat,lng]
        var latlngs = routeCoords.map(function(c) { return [c[1], c[0]]; });

        routeLine = L.polyline(latlngs, {
            // 위성 지도 위에서 파랑은 바다에 묻힌다 — 항로선은 노랑(사용자 확정).
            // 선박 마커는 파랑을 유지해 선(항로) vs 점(선박)이 서로 구분된다.
            color: '#eab308',
            weight: 4,
            opacity: 0.95,
            dashArray: '8,8',
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(routeMap);

        var first = latlngs[0];
        var last = latlngs[latlngs.length - 1];

        routeFromMarker = L.marker(first, { icon: _pinIcon('#10b981'), interactive: false })
            .addTo(routeMap)
            .bindTooltip('<span class="rp-tag rp-from">출발</span>' + (fromPort ? fromPort.name : 'Start'),
                { permanent: true, direction: 'top', className: 'route-pin-label route-pin-from' });

        routeToMarker = L.marker(last, { icon: _pinIcon('#ef4444'), interactive: false })
            .addTo(routeMap)
            .bindTooltip('<span class="rp-tag rp-to">도착</span>' + (toPort ? toPort.name : 'End'),
                { permanent: true, direction: 'top', className: 'route-pin-label route-pin-to' });

        // Animated ship marker — DivIcon with an inner element we can rotate
        // (Leaflet uses the outer marker element's transform for positioning).
        var shipIcon = L.divIcon({
            className: 'route-ship-divicon',
            html: '<div class="route-ship-ico">' +
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28">' +
                  '<polygon points="16,2 28,28 16,22 4,28" fill="#eab308" stroke="#a16207" stroke-width="1.5"/>' +
                  '</svg></div>',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        routeShipMarker = L.marker(first, { icon: shipIcon, interactive: false, zIndexOffset: 1000 }).addTo(routeMap);

        // Avoid the duplicate port name: hide the cyan markers under the 출발/도착 pins.
        syncPortMarkerVisibility(true);

        progress = 0;
        updateShipPosition();
    }

    function clearRoute() {
        stopAnimation();
        if (routeMap) {
            [routeLine, routeFromMarker, routeToMarker, routeShipMarker].forEach(function(lyr) {
                if (lyr) routeMap.removeLayer(lyr);
            });
        }
        routeLine = routeFromMarker = routeToMarker = routeShipMarker = null;
        syncPortMarkerVisibility(false);  // restore all cyan port markers
        progress = 0;
        if (active) setEmptyHint(true);  // back to awaiting-input state
    }

    function flyToRoute() {
        if (!routeMap || routeCoords.length < 2) return;
        var latlngs = routeCoords.map(function(c) { return [c[1], c[0]]; });
        routeMap.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60], maxZoom: 12 });
    }

    // ── Animation ──
    function getPositionAtProgress(t) {
        if (routeCoords.length < 2) return routeCoords[0] || [0, 0];
        var idx = t * (routeCoords.length - 1);
        var i = Math.floor(idx);
        var frac = idx - i;
        if (i >= routeCoords.length - 1) return routeCoords[routeCoords.length - 1];
        var a = routeCoords[i];
        var b = routeCoords[i + 1];
        return [
            a[0] + (b[0] - a[0]) * frac,
            a[1] + (b[1] - a[1]) * frac,
        ];
    }

    function getHeadingAtProgress(t) {
        var idx = t * (routeCoords.length - 1);
        var i = Math.min(Math.floor(idx), routeCoords.length - 2);
        if (i < 0) i = 0;
        var a = routeCoords[i];
        var b = routeCoords[Math.min(i + 1, routeCoords.length - 1)];
        var dlng = b[0] - a[0];
        var dlat = b[1] - a[1];
        return Math.atan2(dlng, dlat);
    }

    function updateShipPosition() {
        if (!routeShipMarker || routeCoords.length < 2) return;
        var pos = getPositionAtProgress(progress);       // [lng, lat]
        var heading = getHeadingAtProgress(progress);    // radians, 0 = north
        routeShipMarker.setLatLng([pos[1], pos[0]]);
        var el = routeShipMarker.getElement();
        if (el) {
            var ico = el.querySelector('.route-ship-ico');
            if (ico) ico.style.transform = 'rotate(' + (heading * 180 / Math.PI) + 'deg)';
        }

        // Update progress bar
        var fill = document.getElementById('routeProgressFill');
        var slider = document.getElementById('routeProgressSlider');
        if (fill) fill.style.width = (progress * 100) + '%';
        if (slider) slider.value = Math.round(progress * 1000);
        updatePlaybarReadout();
    }

    // Format a duration (hours) compactly: 일 for ≥1 day, else 시간.
    function _fmtDur(hours) {
        if (!isFinite(hours) || hours <= 0) return '0';
        var days = hours / 24;
        return days >= 1 ? days.toFixed(1) + '일' : hours.toFixed(1) + '시간';
    }

    // Elapsed / total voyage time flanking the scrubber (mono, matches the panels).
    function updatePlaybarReadout() {
        var speedKmh = speedKts * KTS_TO_KMH;
        var totalHours = speedKmh > 0 ? totalDistanceKm / speedKmh : 0;
        var nowEl = document.getElementById('routeTimeNow');
        var totEl = document.getElementById('routeTimeTotal');
        if (nowEl) nowEl.textContent = _fmtDur(totalHours * progress);
        if (totEl) totEl.textContent = _fmtDur(totalHours);
    }

    function animationLoop(timestamp) {
        if (!playing) return;
        if (lastFrameTime === null) { lastFrameTime = timestamp; }

        var dt = (timestamp - lastFrameTime) / 1000;
        lastFrameTime = timestamp;

        var speedKmh = speedKts * KTS_TO_KMH * playbackRate;
        var totalTimeHours = totalDistanceKm / speedKmh;
        var totalTimeSeconds = totalTimeHours * 3600;

        var dp = dt / totalTimeSeconds;
        progress = Math.min(progress + dp, 1);

        updateShipPosition();
        updateInfoText();

        if (progress >= 1) {
            playing = false;
            updatePlayBtn();
            return;
        }

        animFrameId = requestAnimationFrame(animationLoop);
    }

    function startAnimation() {
        if (routeCoords.length < 2) return;
        if (progress >= 1) progress = 0;
        playing = true;
        lastFrameTime = null;
        updatePlayBtn();
        animFrameId = requestAnimationFrame(animationLoop);
    }

    function stopAnimation() {
        playing = false;
        lastFrameTime = null;
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        updatePlayBtn();
    }

    function updatePlayBtn() {
        var btn = document.getElementById('routePlayBtn');
        if (!btn) return;
        btn.innerHTML = playing
            ? '<i class="fa-solid fa-pause"></i>'
            : '<i class="fa-solid fa-play"></i>';
    }

    // ── Playbar ──
    function showPlaybar() {
        var bar = document.getElementById('route-playbar');
        if (bar) bar.style.display = '';
        var info = document.getElementById('route-info-panel');
        if (info) info.style.display = '';
    }

    function hidePlaybar() {
        var bar = document.getElementById('route-playbar');
        if (bar) bar.style.display = 'none';
        var info = document.getElementById('route-info-panel');
        if (info) info.style.display = 'none';
    }

    function updateInfoText() {
        var fromName = fromPort ? fromPort.name : '?';
        var toName = toPort ? toPort.name : '?';
        var speedKmh = speedKts * KTS_TO_KMH;
        var totalHours = totalDistanceKm / speedKmh;
        var days = totalHours / 24;

        var timeStr;
        if (days >= 1) {
            timeStr = days.toFixed(1) + '일';
        } else {
            timeStr = totalHours.toFixed(1) + '시간';
        }

        var distStr = totalDistanceKm >= 1000
            ? Number((totalDistanceKm / 1000).toFixed(1)).toLocaleString() + '천km'
            : Math.round(totalDistanceKm).toLocaleString() + 'km';

        var distNm = Math.round(totalDistanceKm / 1.852).toLocaleString() + 'NM';

        // ETA calculation
        var eta = new Date(Date.now() + totalHours * 3600000);
        var etaMonth = eta.getMonth() + 1;
        var etaDay = eta.getDate();
        var etaHour = eta.getHours();
        var etaStr = etaMonth + '/' + etaDay + ' ' + (etaHour < 10 ? '0' : '') + etaHour + ':00';

        var elFrom = document.getElementById('routeInfoFrom');
        var elTo = document.getElementById('routeInfoTo');
        var elDist = document.getElementById('routeInfoDist');
        var elTime = document.getElementById('routeInfoTime');
        var elSpeed = document.getElementById('routeInfoSpeed');
        var elETA = document.getElementById('routeInfoETA');
        var elSeas = document.getElementById('routeInfoSeas');

        if (elFrom) elFrom.textContent = fromName;
        if (elTo) elTo.textContent = toName;
        if (elDist) elDist.innerHTML = distStr + ' <span class="route-info-sub">' + distNm + '</span>';
        if (elTime) elTime.textContent = '약 ' + timeStr;
        if (elSpeed) elSpeed.textContent = speedKts + ' kts';
        if (elETA) elETA.textContent = etaStr;

        if (elSeas && routeCoords && routeCoords.length > 0) {
            var seas = detectSeaRegions(routeCoords);
            if (seas.length > 0) {
                elSeas.innerHTML = seas.map(function(s) {
                    return '<span class="route-sea-tag">' + s + '</span>';
                }).join('');
            } else {
                elSeas.textContent = '--';
            }
        }

        updatePlaybarReadout();
    }

    function setupPlaybar() {
        var playBtn = document.getElementById('routePlayBtn');
        if (playBtn) {
            playBtn.addEventListener('click', function() {
                if (playing) stopAnimation();
                else startAnimation();
            });
        }

        var slider = document.getElementById('routeProgressSlider');
        if (slider) {
            slider.addEventListener('input', function() {
                progress = parseInt(slider.value) / 1000;
                updateShipPosition();
                updateInfoText();
            });
        }

        document.querySelectorAll('.route-rate-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                playbackRate = parseInt(btn.dataset.rate);
                document.querySelectorAll('.route-rate-btn').forEach(function(b) {
                    b.classList.toggle('active', b === btn);
                });
            });
        });
    }

    function setupSpeedSlider() {
        var slider = document.getElementById('routeSpeedSlider');
        var label = document.getElementById('routeSpeedLabel');
        if (!slider) return;
        function setSpeedFill() {
            var min = parseFloat(slider.min) || 0, max = parseFloat(slider.max) || 100;
            var pct = ((parseFloat(slider.value) - min) / (max - min)) * 100;
            slider.style.setProperty('--route-speed-fill', pct + '%');
        }
        setSpeedFill();   // initial fill for the default value
        slider.addEventListener('input', function() {
            speedKts = parseInt(slider.value);
            if (label) label.textContent = speedKts;
            setSpeedFill();
            updateInfoText();
        });
        slider.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                slider.blur();
                var btn = document.getElementById('routeSearchBtn');
                if (btn && !btn.disabled) btn.click();
            }
        });
    }

    function setupSizeSelector() {
        var btns = document.getElementById('routeSizeBtns');
        var rangeEl = document.getElementById('routeSizeRange');
        if (!btns) return;
        btns.addEventListener('click', function(e) {
            var btn = e.target.closest('.route-size-btn');
            if (!btn) return;
            shipSizeClass = btn.dataset.size;
            btns.querySelectorAll('.route-size-btn').forEach(function(b) {
                b.classList.toggle('active', b === btn);
            });
            if (rangeEl) rangeEl.textContent = shipSizeClass + ' · ' + SHIP_SIZE_CLASSES[shipSizeClass];
        });
    }

    function setupPanelToggle() {
        var btn = document.getElementById('routePanelToggle');
        var body = document.getElementById('routePanelBody');
        if (!btn || !body) return;
        btn.addEventListener('click', function() {
            var collapsed = body.style.display === 'none';
            body.style.display = collapsed ? '' : 'none';
            btn.innerHTML = collapsed
                ? '<i class="fa-solid fa-chevron-up"></i>'
                : '<i class="fa-solid fa-chevron-down"></i>';
        });
    }

    // ── Lifecycle ──
    // Warm up searoute server on first activate
    var warmedUp = false;
    function warmUpServer() {
        if (warmedUp) return;
        warmedUp = true;
        fetch('/api/v1/route?from_lat=35.1&from_lng=129.0&to_lat=1.3&to_lng=103.8')
            .catch(function() {});
    }

    function showRouteOverlay() {
        // Vignette
        var vig = document.getElementById('route-vignette');
        if (!vig) {
            vig = document.createElement('div');
            vig.id = 'route-vignette';
            vig.className = 'route-vignette';
            document.getElementById('dedicated-route-inference').appendChild(vig);
        }
        vig.classList.add('active');

        // Mode bar
        var bar = document.getElementById('route-mode-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'route-mode-bar';
            bar.className = 'route-mode-bar';
            bar.innerHTML = '<span class="route-mode-bar-dot"></span><i class="fa-solid fa-route"></i> 항로 추론 모드';
            document.getElementById('dedicated-route-inference').appendChild(bar);
        }
        bar.classList.add('active');

        // Click-target hint banner (shows whether the next click sets 출발/도착)
        if (!document.getElementById('route-click-hint')) {
            var hint = document.createElement('div');
            hint.id = 'route-click-hint';
            hint.className = 'route-click-hint';
            document.getElementById('dedicated-route-inference').appendChild(hint);
        }
        updateClickHint();

        // One-shot entrance flash — gives the mode switch a clear "moment" so it's
        // obvious the view changed even though the camera position is preserved.
        var container = document.getElementById('dedicated-route-inference');
        if (container) {
            var oldFlash = document.getElementById('route-enter-flash');
            if (oldFlash && oldFlash.parentNode) oldFlash.parentNode.removeChild(oldFlash);
            var flash = document.createElement('div');
            flash.id = 'route-enter-flash';
            flash.className = 'route-enter-flash';
            container.appendChild(flash);
            setTimeout(function() {
                if (flash && flash.parentNode) flash.parentNode.removeChild(flash);
            }, 850);
        }
    }

    function hideRouteOverlay() {
        var vig = document.getElementById('route-vignette');
        if (vig) vig.classList.remove('active');
        var bar = document.getElementById('route-mode-bar');
        if (bar) bar.classList.remove('active');
    }

    function activate() {
        if (active) return;
        active = true;

        buildUI();
        warmUpServer();
        // Close any open home-screen right panel (e.g. a ship info card) so it
        // doesn't linger over the route screen.
        if (window.LayoutManager && LayoutManager.closeRightPanel) LayoutManager.closeRightPanel();
        // Opaque dedicated screen hosts its own nautical 2D map — no globe behind.
        initRouteMap();
        showRouteOverlay();

        if (!eventsWired) {
            eventsWired = true;
            setupSearch('routeFromInput', 'routeFromDropdown', 'routeFromCoord', 'from');
            setupSearch('routeToInput', 'routeToDropdown', 'routeToCoord', 'to');
            setupClickMode();
            setupSearchButton();
            setupResetButton();
            setupSwap();
            setupPlaybar();
            setupSpeedSlider();
            setupSizeSelector();
            setupPanelToggle();
        }

        // Restore previous route if exists
        if (routeCoords.length > 1 && !routeLine) {
            renderRoute();
            showPlaybar();
            updateInfoText();
        } else if (routeLine) {
            showPlaybar();
        }
        // Guide the user when no route is loaded yet.
        setEmptyHint(routeCoords.length < 2);
        updateClickHint();

        // Restore input values
        if (fromPort) {
            var fi = document.getElementById('routeFromInput');
            var fc = document.getElementById('routeFromCoord');
            if (fi) fi.value = fromPort.name;
            if (fc) fc.textContent = fromPort.lat.toFixed(4) + ', ' + fromPort.lng.toFixed(4);
        }
        if (toPort) {
            var ti = document.getElementById('routeToInput');
            var tc = document.getElementById('routeToCoord');
            if (ti) ti.value = toPort.name;
            if (tc) tc.textContent = toPort.lat.toFixed(4) + ', ' + toPort.lng.toFixed(4);
        }
        updateSearchBtn();
    }

    function deactivate() {
        if (!active) return;
        active = false;

        hideRouteOverlay();
        stopAnimation();
        hidePlaybar();

        // Route layers persist on the (now-hidden) 2D map so they're restored on
        // re-entry. Just reset transient click state.
        clickMode = null;
        updateClickBtnStates();
    }

    // ── 외부(챗봇) 구동용 공개 API ──
    function _applySizeClass(cls) {
        if (!cls || !SHIP_SIZE_CLASSES[cls]) return;
        shipSizeClass = cls;
        var btns = document.getElementById('routeSizeBtns');
        var rangeEl = document.getElementById('routeSizeRange');
        if (btns) btns.querySelectorAll('.route-size-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.size === cls);
        });
        if (rangeEl) rangeEl.textContent = cls + ' · ' + SHIP_SIZE_CLASSES[cls];
    }

    // 출발/도착 좌표 + 선박 크기를 설정하고 경로 검색을 실행한다 (챗봇 plan_route).
    function planRoute(opts) {
        opts = opts || {};
        if (opts.sizeClass) _applySizeClass(opts.sizeClass);
        var fIn = document.getElementById('routeFromInput');
        var tIn = document.getElementById('routeToInput');
        var fCoord = document.getElementById('routeFromCoord');
        var tCoord = document.getElementById('routeToCoord');
        if (opts.fromLat != null && opts.fromLng != null) {
            fromPort = { name: opts.fromName || (opts.fromLat.toFixed(2) + ', ' + opts.fromLng.toFixed(2)), lat: opts.fromLat, lng: opts.fromLng };
            if (fIn) fIn.value = fromPort.name;
            if (fCoord) fCoord.textContent = fromPort.lat.toFixed(4) + ', ' + fromPort.lng.toFixed(4);
        }
        if (opts.toLat != null && opts.toLng != null) {
            toPort = { name: opts.toName || (opts.toLat.toFixed(2) + ', ' + opts.toLng.toFixed(2)), lat: opts.toLat, lng: opts.toLng };
            if (tIn) tIn.value = toPort.name;
            if (tCoord) tCoord.textContent = toPort.lat.toFixed(4) + ', ' + toPort.lng.toFixed(4);
        }
        // 프로그램적으로(AI 등) 출발/도착이 채워졌으니 클릭 안내 상태도 동기화한다.
        // 이게 없으면 화면 열릴 때 떠 있던 "지도에서 출발 항구를 클릭하세요" 배너가
        // 출발지가 이미 지정됐는데도 그대로 남아 있었다(클릭 전 안내가 클릭 후에도 잔존).
        clickMode = null;
        if (typeof updateClickBtnStates === 'function') updateClickBtnStates();
        if (typeof updateClickHint === 'function') updateClickHint();
        if (typeof setEmptyHint === 'function') setEmptyHint(false);
        updateSearchBtn();
        var btn = document.getElementById('routeSearchBtn');
        if (btn && !btn.disabled) btn.click();
    }

    // 현재 항로 화면 상태(챗 컨텍스트용)
    function getState() {
        return {
            active: !!document.querySelector('#dedicated-route-inference.active') ||
                    !!document.getElementById('route-search-panel'),
            from: fromPort ? fromPort.name : null,
            to: toPort ? toPort.name : null,
            size_class: shipSizeClass,
        };
    }

    // Programmatic playback control (AI 어시스턴트용).
    //   opts.rate : 배속 프리셋(1·10·100·500·2000) — 비프리셋이면 가장 가까운 값으로 스냅.
    //   opts.play : true=재생 시작, false=정지. (undefined면 재생상태 변경 없음 — 배속만 조정)
    function setPlayback(opts) {
        opts = opts || {};
        showPlaybar();
        if (opts.rate != null) {
            var r = parseInt(opts.rate, 10);
            var presets = [1, 10, 100, 500, 2000];
            if (presets.indexOf(r) === -1) {
                r = presets.reduce(function (a, b) {
                    return Math.abs(b - r) < Math.abs(a - r) ? b : a;
                });
            }
            playbackRate = r;
            document.querySelectorAll('.route-rate-btn').forEach(function (b) {
                b.classList.toggle('active', parseInt(b.dataset.rate, 10) === r);
            });
        }
        if (opts.play === true) {
            if (routeCoords.length >= 2) startAnimation();
        } else if (opts.play === false) {
            stopAnimation();
        }
        return { rate: playbackRate, playing: playing, hasRoute: routeCoords.length >= 2 };
    }

    return {
        activate: activate,
        deactivate: deactivate,
        planRoute: planRoute,
        setSizeClass: _applySizeClass,
        setPlayback: setPlayback,
        getState: getState,
    };
})();

window.RouteViewer = RouteViewer;
