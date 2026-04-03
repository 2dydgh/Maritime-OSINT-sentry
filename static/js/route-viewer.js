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
    var playbackRate = 1;       // x1, x2, x4
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
    var SHIP_ICON_URL = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">' +
        '<polygon points="16,2 28,28 16,22 4,28" fill="#00d4ff" stroke="#003366" stroke-width="1.5"/>' +
        '</svg>'
    );

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

        // Playback bar (bottom)
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
                    '<button class="route-rate-btn active" data-rate="1">x1</button>' +
                    '<button class="route-rate-btn" data-rate="2">x2</button>' +
                    '<button class="route-rate-btn" data-rate="4">x4</button>' +
                '</div>' +
            '</div>' +
            '<div class="route-playbar-info">' +
                '<span id="routeInfoText">--</span>' +
            '</div>';
        wrap.appendChild(playbar);

        container.appendChild(wrap);
    }

    // ── Layer Management ──
    function hideExistingLayers() {
        hiddenLayers = [];

        // Ship billboards & labels
        if (typeof SHIP_TYPES !== 'undefined') {
            SHIP_TYPES.forEach(function(type) {
                if (shipBillboards[type]) { hiddenLayers.push(shipBillboards[type]); shipBillboards[type].show = false; }
                if (shipLabels[type]) { hiddenLayers.push(shipLabels[type]); shipLabels[type].show = false; }
            });
        }

        // COG lines
        if (typeof shipCogLines !== 'undefined' && shipCogLines) {
            hiddenLayers.push(shipCogLines); shipCogLines.show = false;
        }

        // Satellite data source
        if (typeof satDataSource !== 'undefined' && satDataSource) {
            hiddenLayers.push(satDataSource); satDataSource.show = false;
        }

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
            if (layer) { hiddenLayers.push(layer); layer.show = false; }
        });

        // Ship data sources
        if (typeof shipDataSources !== 'undefined') {
            Object.keys(shipDataSources).forEach(function(type) {
                var ds = shipDataSources[type];
                if (ds) { hiddenLayers.push(ds); ds.show = false; }
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

    // ── Port Search ──
    var searchDebounce = null;

    function setupSearch(inputId, dropdownId, coordId, which) {
        var input = document.getElementById(inputId);
        var dropdown = document.getElementById(dropdownId);
        var coordDisplay = document.getElementById(coordId);
        if (!input || !dropdown) return;

        input.addEventListener('input', function() {
            var q = input.value.trim();
            clearTimeout(searchDebounce);
            if (q.length < 1) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; return; }
            searchDebounce = setTimeout(function() {
                fetch('/api/v1/ports/search?q=' + encodeURIComponent(q))
                    .then(function(r) { return r.json(); })
                    .then(function(ports) {
                        if (!ports.length) {
                            dropdown.innerHTML = '<div class="route-dropdown-item disabled">일치하는 항구가 없습니다</div>';
                            dropdown.style.display = '';
                            return;
                        }
                        dropdown.innerHTML = ports.map(function(p) {
                            return '<div class="route-dropdown-item" data-name="' + p.name + '" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-country="' + p.country + '">' +
                                '<strong>' + p.name + '</strong> <span class="route-port-country">' + p.country + '</span>' +
                            '</div>';
                        }).join('');
                        dropdown.style.display = '';
                    })
                    .catch(function() { dropdown.style.display = 'none'; });
            }, 250);
        });

        dropdown.addEventListener('click', function(e) {
            var item = e.target.closest('.route-dropdown-item');
            if (!item || item.classList.contains('disabled')) return;
            var port = {
                name: item.dataset.name,
                lat: parseFloat(item.dataset.lat),
                lng: parseFloat(item.dataset.lng),
            };
            input.value = port.name;
            dropdown.style.display = 'none';
            coordDisplay.textContent = port.lat.toFixed(4) + ', ' + port.lng.toFixed(4);
            if (which === 'from') fromPort = port;
            else toPort = port;
            updateSearchBtn();
        });

        // Close dropdown on outside click
        document.addEventListener('click', function(e) {
            if (!input.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
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
            btn.textContent = '검색 중...';
            showError('');

            var url = '/api/v1/route?from_lat=' + fromPort.lat + '&from_lng=' + fromPort.lng +
                      '&to_lat=' + toPort.lat + '&to_lng=' + toPort.lng;

            fetch(url)
                .then(function(r) {
                    if (!r.ok) throw new Error('경로를 찾을 수 없습니다');
                    return r.json();
                })
                .then(function(data) {
                    routeCoords = data.coordinates;
                    totalDistanceKm = data.distance_km;
                    renderRoute();
                    showPlaybar();
                    updateInfoText();
                    flyToRoute();
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

        routeDataSource.entities.add({
            polyline: {
                positions: positions,
                width: 3,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.fromCssColorString('#00d4ff'),
                    dashLength: 16,
                }),
                clampToGround: true,
            }
        });

        // Start marker
        routeDataSource.entities.add({
            position: Cesium.Cartesian3.fromDegrees(routeCoords[0][0], routeCoords[0][1]),
            point: { pixelSize: 12, color: Cesium.Color.LIME, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: {
                text: fromPort ? fromPort.name : 'Start',
                font: '13px Inter, sans-serif',
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
            position: Cesium.Cartesian3.fromDegrees(last[0], last[1]),
            point: { pixelSize: 12, color: Cesium.Color.RED, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
            label: {
                text: toPort ? toPort.name : 'End',
                font: '13px Inter, sans-serif',
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
            position: Cesium.Cartesian3.fromDegrees(routeCoords[0][0], routeCoords[0][1]),
            billboard: {
                image: SHIP_ICON_URL,
                width: 28,
                height: 28,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                rotation: 0,
            }
        });

        progress = 0;
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
            { duration: 2.0, offset: new Cesium.HeadingPitchRange(0, -0.5, 0) }
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
        shipEntity.position = Cesium.Cartesian3.fromDegrees(pos[0], pos[1]);
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
    }

    function hidePlaybar() {
        var bar = document.getElementById('route-playbar');
        if (bar) bar.style.display = 'none';
    }

    function updateInfoText() {
        var el = document.getElementById('routeInfoText');
        if (!el) return;
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
            ? (totalDistanceKm / 1000).toFixed(1) + '천km'
            : Math.round(totalDistanceKm) + 'km';

        el.textContent = fromName + ' \u2192 ' + toName + '  |  ' + distStr + '  |  약 ' + timeStr + '  (' + speedKts + 'kts)';
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
    function activate() {
        if (active) return;
        active = true;

        buildUI();
        hideExistingLayers();
        moveGlobeToRoute();
        setupGlobeClickHandler();

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
