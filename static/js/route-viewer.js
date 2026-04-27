// static/js/route-viewer.js
// ── OVERWATCH 4D — Route Viewer ──
// Dedicated screen for visualizing shipping routes on the Cesium globe.
// Reuses existing Cesium viewer via DOM reparenting.

var RouteViewer = (function() {

    // ── State ──
    var active = false;
    var routeDataSource = null;
    var shipEntity = null;
    var routeCoords = [];       // [[lng, lat], ...] interpolated
    var totalDistanceKm = 0;

    // Animation state
    var animFrameId = null;
    var playing = false;
    var progress = 0;           // 0..1
    var speedKts = 14;
    var playbackRate = 500;     // x1, x10, x100, x500, x2k
    var lastFrameTime = null;

    // Search state
    var fromPort = null;        // { name, lat, lng }
    var toPort = null;
    var clickMode = null;       // 'from' | 'to' | null
    var clickHandler = null;

    // Layers to hide/restore
    var hiddenLayers = [];

    // UI built flag
    var uiBuilt = false;
    // Events wired flag
    var eventsWired = false;

    // ── Constants ──
    var KTS_TO_KMH = 1.852;
    var ROUTE_ALT = 500;
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
        wrap.style.cssText = 'position:relative;width:100%;height:100%;';

        // Globe container (cesium will be moved here)
        var globeSlot = document.createElement('div');
        globeSlot.id = 'route-globe-slot';
        globeSlot.style.cssText = 'width:100%;height:100%;';
        wrap.appendChild(globeSlot);

        // Search panel overlay (top-left)
        var searchPanel = document.createElement('div');
        searchPanel.id = 'route-search-panel';
        searchPanel.className = 'route-overlay-panel';
        searchPanel.innerHTML =
            '<div class="route-panel-header">' +
                '<span class="route-panel-title"><i class="fa-solid fa-route"></i> 관습 항로 추론</span>' +
                '<button id="routePanelToggle" class="route-panel-toggle" title="접기"><i class="fa-solid fa-chevron-up"></i></button>' +
            '</div>' +
            '<div id="routePanelBody" class="route-panel-body">' +
                '<div class="route-input-group">' +
                    '<label>출발지</label>' +
                    '<div class="route-input-row">' +
                        '<input type="text" id="routeFromInput" placeholder="항구명 검색..." autocomplete="off">' +
                        '<button id="routeFromClick" class="route-click-btn" title="지도에서 클릭"><i class="fa-solid fa-crosshairs"></i></button>' +
                    '</div>' +
                    '<div id="routeFromDropdown" class="route-dropdown"></div>' +
                    '<div id="routeFromCoord" class="route-coord-display"></div>' +
                '</div>' +
                '<div class="route-input-group">' +
                    '<label>도착지</label>' +
                    '<div class="route-input-row">' +
                        '<input type="text" id="routeToInput" placeholder="항구명 검색..." autocomplete="off">' +
                        '<button id="routeToClick" class="route-click-btn" title="지도에서 클릭"><i class="fa-solid fa-crosshairs"></i></button>' +
                    '</div>' +
                    '<div id="routeToDropdown" class="route-dropdown"></div>' +
                    '<div id="routeToCoord" class="route-coord-display"></div>' +
                '</div>' +
                '<div class="route-input-group">' +
                    '<label>속도: <span id="routeSpeedLabel">14</span> kts</label>' +
                    '<input type="range" id="routeSpeedSlider" min="5" max="30" value="14" step="1">' +
                '</div>' +
                '<button id="routeSearchBtn" class="route-search-btn" disabled>경로 검색</button>' +
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
                '<div class="route-progress-wrap">' +
                    '<div class="route-progress-bar">' +
                        '<div id="routeProgressFill" class="route-progress-fill"></div>' +
                        '<input type="range" id="routeProgressSlider" min="0" max="1000" value="0" class="route-progress-slider">' +
                    '</div>' +
                '</div>' +
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
                '<span class="route-panel-title"><i class="fa-solid fa-chart-line"></i> 경로 정보</span>' +
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

        container.appendChild(wrap);
    }

    // ── Layer Management ──
    function hideExistingLayers() {
        hiddenLayers = [];

        function hideIfVisible(layer) {
            if (layer && layer.show) {
                hiddenLayers.push(layer);
                layer.show = false;
            }
        }

        // Ship billboards & labels
        if (typeof SHIP_TYPES !== 'undefined') {
            SHIP_TYPES.forEach(function(type) {
                hideIfVisible(shipBillboards[type]);
                hideIfVisible(shipLabels[type]);
            });
        }

        // COG lines
        if (typeof shipCogLines !== 'undefined') hideIfVisible(shipCogLines);

        // Satellite data source
        if (typeof satDataSource !== 'undefined') hideIfVisible(satDataSource);

        // Proximity layers
        var proxLayers = [
            typeof proximityDataSource !== 'undefined' ? proximityDataSource : null,
            typeof proximityLines !== 'undefined' ? proximityLines : null,
            typeof proximityLabels !== 'undefined' ? proximityLabels : null,
            typeof proximityCogLines !== 'undefined' ? proximityCogLines : null,
            typeof proximityCpaPoints !== 'undefined' ? proximityCpaPoints : null,
            typeof proximityCpaLabels !== 'undefined' ? proximityCpaLabels : null,
        ];
        proxLayers.forEach(function(layer) {
            hideIfVisible(layer);
        });

        // Ship data sources
        if (typeof shipDataSources !== 'undefined') {
            Object.keys(shipDataSources).forEach(function(type) {
                var ds = shipDataSources[type];
                hideIfVisible(ds);
            });
        }
    }

    function restoreExistingLayers() {
        hiddenLayers.forEach(function(layer) {
            layer.show = true;
        });
        hiddenLayers = [];
    }

    // ── Globe Reparenting ──
    function moveGlobeToRoute() {
        var cesiumEl = document.getElementById('cesiumContainer');
        var slot = document.getElementById('route-globe-slot');
        if (cesiumEl && slot) {
            slot.appendChild(cesiumEl);
            cesiumEl.style.width = '100%';
            cesiumEl.style.height = '100%';
            if (typeof viewer !== 'undefined') {
                viewer.resize();
                viewer.scene.requestRender();
            }
        }
    }

    function moveGlobeBack() {
        var cesiumEl = document.getElementById('cesiumContainer');
        var mapArea = document.getElementById('mapArea');
        if (cesiumEl && mapArea) {
            mapArea.insertBefore(cesiumEl, mapArea.firstChild);
            cesiumEl.style.width = '';
            cesiumEl.style.height = '';
            if (typeof viewer !== 'undefined') {
                viewer.resize();
                viewer.scene.requestRender();
            }
        }
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
            updateSearchBtn();
            highlightIdx = -1;
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

        input.addEventListener('input', function() {
            var q = input.value.trim();
            highlightIdx = -1;
            if (q.length < 1) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; return; }
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

        // Change cursor
        var cesiumEl = document.getElementById('cesiumContainer');
        if (cesiumEl) {
            cesiumEl.style.cursor = clickMode ? 'crosshair' : '';
        }
    }

    function setupGlobeClickHandler() {
        if (typeof viewer === 'undefined') return;

        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(function(click) {
            if (!clickMode) return;

            var ray = viewer.camera.getPickRay(click.position);
            var cartesian = viewer.scene.globe.pick(ray, viewer.scene);
            if (!cartesian) return;

            var carto = Cesium.Cartographic.fromCartesian(cartesian);
            var lat = Cesium.Math.toDegrees(carto.latitude);
            var lng = Cesium.Math.toDegrees(carto.longitude);

            var port = { name: lat.toFixed(2) + '\u00b0, ' + lng.toFixed(2) + '\u00b0', lat: lat, lng: lng };
            var input, coordDisplay;

            if (clickMode === 'from') {
                fromPort = port;
                input = document.getElementById('routeFromInput');
                coordDisplay = document.getElementById('routeFromCoord');
            } else {
                toPort = port;
                input = document.getElementById('routeToInput');
                coordDisplay = document.getElementById('routeToCoord');
            }

            if (input) input.value = port.name;
            if (coordDisplay) coordDisplay.textContent = lat.toFixed(4) + ', ' + lng.toFixed(4);

            clickMode = null;
            updateClickBtnStates();
            updateSearchBtn();
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function destroyGlobeClickHandler() {
        if (clickHandler) {
            clickHandler.destroy();
            clickHandler = null;
        }
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

            var url = '/api/v1/route?from_lat=' + fromPort.lat + '&from_lng=' + fromPort.lng +
                      '&to_lat=' + toPort.lat + '&to_lng=' + toPort.lng;

            console.time('[Route] total');
            console.time('[Route] fetch');
            fetch(url)
                .then(function(r) {
                    if (!r.ok) throw new Error('경로를 찾을 수 없습니다');
                    return r.json();
                })
                .then(function(data) {
                    console.timeEnd('[Route] fetch');
                    routeCoords = data.coordinates;
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

    // ── Route Rendering on Cesium ──
    function renderRoute() {
        if (typeof viewer === 'undefined') return;

        clearRoute();

        routeDataSource = new Cesium.CustomDataSource('Route');
        viewer.dataSources.add(routeDataSource);

        // Route polyline
        var positions = routeCoords.map(function(c) {
            return Cesium.Cartesian3.fromDegrees(c[0], c[1]);
        });

        var dashPositions = routeCoords.map(function(c) {
            return Cesium.Cartesian3.fromDegrees(c[0], c[1], ROUTE_ALT);
        });
        routeDataSource.entities.add({
            polyline: {
                positions: dashPositions,
                width: 5,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.fromCssColorString('#eab308'),
                    dashLength: 8,
                }),
                arcType: Cesium.ArcType.RHUMB,
            }
        });

        // Start marker
        routeDataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(routeCoords[0][0], routeCoords[0][1], ROUTE_ALT),
            point: { pixelSize: 12, color: Cesium.Color.LIME, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: {
                text: fromPort ? fromPort.name : 'Start',
                font: '13px Pretendard Variable, Inter, sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -16),
            }
        });

        // End marker
        var last = routeCoords[routeCoords.length - 1];
        routeDataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(last[0], last[1], ROUTE_ALT),
            point: { pixelSize: 12, color: Cesium.Color.RED, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: {
                text: toPort ? toPort.name : 'End',
                font: '13px Pretendard Variable, Inter, sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -16),
            }
        });

        // Ship entity (animated)
        shipEntity = routeDataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(routeCoords[0][0], routeCoords[0][1], ROUTE_ALT),
            billboard: {
                image: SHIP_ICON_URL,
                width: 28,
                height: 28,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                rotation: 0,
            }
        });

        progress = 0;

        // Force render to ensure route is visible immediately
        if (viewer.scene) {
            viewer.scene.requestRender();
        }
    }

    function clearRoute() {
        stopAnimation();
        if (routeDataSource && typeof viewer !== 'undefined') {
            viewer.dataSources.remove(routeDataSource, true);
        }
        routeDataSource = null;
        shipEntity = null;
        progress = 0;
    }

    function flyToRoute() {
        if (typeof viewer === 'undefined' || routeCoords.length < 2) return;
        var positions = routeCoords.map(function(c) {
            return Cesium.Cartesian3.fromDegrees(c[0], c[1]);
        });
        viewer.camera.flyToBoundingSphere(
            Cesium.BoundingSphere.fromPoints(positions),
            { duration: 0.8, offset: new Cesium.HeadingPitchRange(0, -Math.PI / 2, 0) }
        );
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
        if (!shipEntity || routeCoords.length < 2) return;
        var pos = getPositionAtProgress(progress);
        var heading = getHeadingAtProgress(progress);
        shipEntity.position = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], ROUTE_ALT);
        shipEntity.billboard.rotation = -heading;

        // Update progress bar
        var fill = document.getElementById('routeProgressFill');
        var slider = document.getElementById('routeProgressSlider');
        if (fill) fill.style.width = (progress * 100) + '%';
        if (slider) slider.value = Math.round(progress * 1000);
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
        slider.addEventListener('input', function() {
            speedKts = parseInt(slider.value);
            if (label) label.textContent = speedKts;
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
            bar.innerHTML = '<i class="fa-solid fa-route"></i> 항로 추론 모드';
            document.getElementById('dedicated-route-inference').appendChild(bar);
        }
        bar.classList.add('active');
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
        hideExistingLayers();
        moveGlobeToRoute();
        setupGlobeClickHandler();
        showRouteOverlay();

        if (!eventsWired) {
            eventsWired = true;
            setupSearch('routeFromInput', 'routeFromDropdown', 'routeFromCoord', 'from');
            setupSearch('routeToInput', 'routeToDropdown', 'routeToCoord', 'to');
            setupClickMode();
            setupSearchButton();
            setupPlaybar();
            setupSpeedSlider();
            setupPanelToggle();
        }
    }

    function deactivate() {
        if (!active) return;
        active = false;

        hideRouteOverlay();
        clearRoute();
        hidePlaybar();
        destroyGlobeClickHandler();
        moveGlobeBack();
        restoreExistingLayers();

        clickMode = null;
        updateClickBtnStates();
    }

    return {
        activate: activate,
        deactivate: deactivate,
    };
})();

window.RouteViewer = RouteViewer;
