// ── Maritime OSINT Sentry — UI Controls ──

// ── Panel Collapse/Expand ──
function toggleLeftPanel() {
    var panel = document.getElementById('feedPanel');
    panel.classList.toggle('panel-collapsed');
}
window.toggleLeftPanel = toggleLeftPanel;

function toggleCollisionDrawer() {
    var drawer = document.getElementById('collisionDrawer');
    drawer.classList.toggle('collapsed');
    setTimeout(resizeActiveMap, 320);
}
window.toggleCollisionDrawer = toggleCollisionDrawer;

function toggleRightPanel() {
    var sidebar = document.getElementById('rightSidebar');
    sidebar.classList.toggle('panel-hidden');
}
window.toggleRightPanel = toggleRightPanel;

function resizeActiveMap() {
    setTimeout(function() {
        if (currentMapMode === '3d' && typeof viewer !== 'undefined' && viewer) {
            viewer.resize();
        } else if (currentMapMode === '2d' && leafletMap) {
            leafletMap.invalidateSize();
        }
    }, 50);
}
window.resizeActiveMap = resizeActiveMap;

// ── Time Control Bar Logic ──
var SPEED_STEPS = [1, 10, 60, 300, 600];
var currentSpeedIndex = 2;
var _lastPlayingState = null;
var _lastReverseState = null;

function updateClock() {
    if (timeMode !== 'live') return;
    var now = new Date();
    var el = document.getElementById('tcb-time-display');
    if (el) el.textContent = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}
setInterval(updateClock, 1000);
updateClock();

function updatePlaybackUI() {
    var playing = viewer.clock.shouldAnimate;
    var isReverse = viewer.clock.multiplier < 0;

    if (playing === _lastPlayingState && isReverse === _lastReverseState) return;
    _lastPlayingState = playing;
    _lastReverseState = isReverse;

    var icon = document.getElementById('tcb-playpause-icon');
    if (icon) icon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';

    var reverseBtn = document.getElementById('tcb-reverse');
    if (reverseBtn) {
        if (isReverse) {
            reverseBtn.classList.add('active-reverse');
        } else {
            reverseBtn.classList.remove('active-reverse');
        }
    }

    var speed = Math.abs(viewer.clock.multiplier);
    var speedEl = document.getElementById('tcb-speed');
    if (speedEl) speedEl.textContent = speed + 'x';
}

function forceUpdatePlaybackUI() {
    _lastPlayingState = null;
    _lastReverseState = null;
    updatePlaybackUI();
}
window.forceUpdatePlaybackUI = forceUpdatePlaybackUI;

function enablePlaybackButtons(enabled) {
    var btns = ['tcb-reverse', 'tcb-playpause', 'tcb-ff'];
    btns.forEach(function(id) {
        var btn = document.getElementById(id);
        if (!btn) return;
        if (enabled) {
            btn.disabled = false;
            btn.classList.add('enabled');
        } else {
            btn.disabled = true;
            btn.classList.remove('enabled', 'active-reverse');
        }
    });
    var speedEl = document.getElementById('tcb-speed');
    if (speedEl) {
        if (enabled) {
            speedEl.classList.add('active');
        } else {
            speedEl.classList.remove('active');
            speedEl.textContent = '1x';
        }
    }
}

// Play/Pause
var tcbPlayPause = document.getElementById('tcb-playpause');
if (tcbPlayPause) {
    tcbPlayPause.addEventListener('click', function() {
        viewer.clock.shouldAnimate = !viewer.clock.shouldAnimate;
        forceUpdatePlaybackUI();
    });
}

// Reverse toggle
var tcbReverse = document.getElementById('tcb-reverse');
if (tcbReverse) {
    tcbReverse.addEventListener('click', function() {
        var m = viewer.clock.multiplier;
        viewer.clock.multiplier = m < 0 ? Math.abs(m) : -Math.abs(m);
        if (!viewer.clock.shouldAnimate) {
            viewer.clock.shouldAnimate = true;
        }
        forceUpdatePlaybackUI();
    });
}

// Fast Forward
var tcbFf = document.getElementById('tcb-ff');
if (tcbFf) {
    tcbFf.addEventListener('click', function() {
        currentSpeedIndex = (currentSpeedIndex + 1) % SPEED_STEPS.length;
        var sign = viewer.clock.multiplier < 0 ? -1 : 1;
        viewer.clock.multiplier = sign * SPEED_STEPS[currentSpeedIndex];
        if (!viewer.clock.shouldAnimate) {
            viewer.clock.shouldAnimate = true;
        }
        forceUpdatePlaybackUI();
    });
}

// ── Time Travel Mode ──
var liveClockIntervalId = null;
var historyRange = { min: null, max: null };

var WINDOW_HALF_MS = 30 * 60 * 1000;
var currentWindowCenter = null;
var currentWindowStart = null;
var currentWindowEnd = null;
var isLoadingWindow = false;
var historyInterpolationLoaded = false;

function debounce(func, wait) {
    var timeout;
    return function() {
        var args = arguments;
        var context = this;
        var later = function() {
            clearTimeout(timeout);
            func.apply(context, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function getViewportBbox() {
    var rect = viewer.camera.computeViewRectangle();
    if (!rect) return '';
    var buffer = 0.5;
    var west = Cesium.Math.toDegrees(rect.west) - buffer;
    var south = Cesium.Math.toDegrees(rect.south) - buffer;
    var east = Cesium.Math.toDegrees(rect.east) + buffer;
    var north = Cesium.Math.toDegrees(rect.north) + buffer;
    return '&west=' + west.toFixed(4) + '&south=' + south.toFixed(4) + '&east=' + east.toFixed(4) + '&north=' + north.toFixed(4);
}

function fetchWithTimeout(url, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    var controller = new AbortController();
    var id = setTimeout(function() { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(function() { clearTimeout(id); });
}

async function loadHistoryWindow(centerDate, opts) {
    opts = opts || {};
    var silent = opts.silent || false;
    if (isLoadingWindow) return;
    isLoadingWindow = true;

    if (!silent) {
        document.getElementById('loading').style.display = 'flex';
        document.getElementById('loading').innerHTML = '<i class="fa-solid fa-clock-rotate-left fa-spin"></i> LOADING HISTORY...';
    }

    var windowStart = new Date(centerDate.getTime() - WINDOW_HALF_MS);
    var windowEnd = new Date(centerDate.getTime() + WINDOW_HALF_MS);
    var startIso = windowStart.toISOString();
    var endIso = windowEnd.toISOString();

    console.log('[HISTORY] Loading window:', startIso, 'to', endIso, silent ? '(silent)' : '');

    try {
        var bbox = getViewportBbox();
        var res = await fetchWithTimeout(
            '/api/v1/history/trajectories?start=' + encodeURIComponent(startIso) + '&end=' + encodeURIComponent(endIso) + '&limit_per_ship=60' + bbox,
            15000
        );
        if (!res.ok) {
            console.error('[HISTORY] Trajectory API error:', res.status);
            if (!silent) {
                document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> LOAD ERROR';
                setTimeout(function() { document.getElementById('loading').style.display = 'none'; }, 2000);
            }
            return;
        }

        var data = await res.json();
        var ships = data.ships || {};
        var shipCount = Object.keys(ships).length;
        console.log('[HISTORY] Loaded trajectories for', shipCount, 'ships');

        var newEntities = [];
        for (var mmsi in ships) {
            var shipData = ships[mmsi];
            if (shipData.points.length < 2) continue;

            var type = shipData.type || 'other';
            var ds = shipDataSources[type] || shipDataSources['other'];
            if (!ds) continue;

            var positionProperty = new Cesium.SampledPositionProperty();
            positionProperty.setInterpolationOptions({
                interpolationDegree: 1,
                interpolationAlgorithm: Cesium.LinearApproximation
            });

            var headingProperty = new Cesium.SampledProperty(Number);

            shipData.points.forEach(function(pt) {
                var time = Cesium.JulianDate.fromIso8601(pt.time);
                var position = Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat);
                positionProperty.addSample(time, position);
                headingProperty.addSample(time, pt.heading || 0);
            });

            newEntities.push({
                ds: ds, def: {
                    id: mmsi,
                    name: shipData.name || 'UNKNOWN',
                    description: '\
                    <table class="cesium-infoBox-defaultTable">\
                        <tbody>\
                            <tr><th>Name</th><td>' + shipData.name + '</td></tr>\
                            <tr><th>MMSI</th><td>' + mmsi + '</td></tr>\
                            <tr><th>Type</th><td>' + shipData.type + '</td></tr>\
                            <tr><th>Country</th><td>' + shipData.country + '</td></tr>\
                        </tbody>\
                    </table>\
                ',
                    position: positionProperty,
                    billboard: {
                        image: getShipIcon(SHIP_COLORS[type] || SHIP_COLORS['other'], type || 'other'),
                        width: getShipSize(shipData.length, shipData.beam).width,
                        height: getShipSize(shipData.length, shipData.beam).height,
                        scaleByDistance: new Cesium.NearFarScalar(5e5, 1.6, 1.5e7, 0.6),
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        rotation: new Cesium.CallbackProperty(function() {
                            var heading = headingProperty.getValue(viewer.clock.currentTime);
                            return Cesium.Math.toRadians(-(heading || 0));
                        }, false)
                    }
                }
            });
        }

        SHIP_TYPES.forEach(function(type) {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });
        newEntities.forEach(function(item) { item.ds.entities.add(item.def); });

        currentWindowCenter = centerDate;
        currentWindowStart = windowStart;
        currentWindowEnd = windowEnd;
        historyInterpolationLoaded = true;

        document.getElementById('total-ships').textContent = shipCount.toLocaleString();

        if (!silent) {
            document.getElementById('loading').style.display = 'none';
        }
        console.log('[HISTORY] Window loaded:', shipCount, 'ships');

        if (currentMapMode === '2d' && leafletMap) {
            syncShipsToLeaflet();
        }

    } catch (err) {
        console.error('[HISTORY] Error loading window:', err);
        if (!silent) {
            document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> LOAD ERROR';
            setTimeout(function() {
                document.getElementById('loading').style.display = 'none';
                setTimeMode('live');
            }, 2000);
        }
    } finally {
        isLoadingWindow = false;
    }
}

async function loadHistoryRange() {
    try {
        var res = await fetchWithTimeout('/api/v1/history/range');
        if (!res.ok) {
            console.warn('History range API not available');
            return false;
        }
        var range = await res.json();

        if (range.min_time && range.max_time) {
            historyRange.min = range.min_time;
            historyRange.max = range.max_time;

            var start = Cesium.JulianDate.fromIso8601(range.min_time);
            var stop = Cesium.JulianDate.fromIso8601(range.max_time);

            viewer.timeline.zoomTo(start, stop);
            viewer.clock.startTime = start.clone();
            viewer.clock.stopTime = stop.clone();
            viewer.clock.currentTime = stop.clone();
            viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
            viewer.clock.multiplier = 60;

            return true;
        }
        return false;
    } catch (err) {
        console.warn('Error loading history range:', err);
        return false;
    }
}

async function setTimeMode(mode) {
    var btnLive = document.getElementById('tcb-btn-live');
    var btnHistory = document.getElementById('tcb-btn-history');
    var controlBar = document.getElementById('timeControlBar');
    var timeDisplay = document.getElementById('tcb-time-display');

    if (mode === 'live') {
        timeMode = 'live';

        if (btnLive) btnLive.classList.add('active');
        if (btnHistory) btnHistory.classList.remove('active');
        if (controlBar) controlBar.classList.remove('history-active');
        if (timeDisplay) timeDisplay.classList.remove('history');

        enablePlaybackButtons(false);

        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = Cesium.JulianDate.now();

        if (!liveClockIntervalId) {
            liveClockIntervalId = setInterval(function() {
                if (timeMode === 'live') {
                    viewer.clock.currentTime = Cesium.JulianDate.now();
                }
            }, 1000);
        }

        SHIP_TYPES.forEach(function(type) {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });

        currentWindowCenter = null;
        currentWindowStart = null;
        currentWindowEnd = null;
        historyInterpolationLoaded = false;

        console.log('Switched to LIVE mode');

    } else if (mode === 'history') {
        timeMode = 'history';
        clearProximity();

        if (btnLive) btnLive.classList.remove('active');
        if (btnHistory) btnHistory.classList.add('active');
        if (controlBar) controlBar.classList.add('history-active');
        if (timeDisplay) timeDisplay.classList.add('history');

        enablePlaybackButtons(true);

        currentSpeedIndex = 2;

        if (liveClockIntervalId) {
            clearInterval(liveClockIntervalId);
            liveClockIntervalId = null;
        }

        SHIP_TYPES.forEach(function(type) {
            if (shipDataSources[type]) {
                shipDataSources[type].entities.removeAll();
            }
        });

        var rangeLoaded = await loadHistoryRange();

        if (rangeLoaded) {
            var initialCenter = new Date(historyRange.max);
            await loadHistoryWindow(initialCenter);

            viewer.clock.shouldAnimate = true;
            viewer.clock.multiplier = 60;
            forceUpdatePlaybackUI();
        } else {
            timeDisplay.textContent = 'No history data \u2014 returning to LIVE';
            setTimeout(function() { setTimeMode('live'); }, 2000);
        }

        console.log('Switched to HISTORY mode with sliding window');
    }
}
window.setTimeMode = setTimeMode;

// Clock tick listener for history mode
viewer.clock.onTick.addEventListener(function(clock) {
    if (timeMode !== 'history') return;

    var jsDate = Cesium.JulianDate.toDate(clock.currentTime);
    var displayTime = jsDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    var tdEl = document.getElementById('tcb-time-display');
    if (tdEl) tdEl.textContent = displayTime;
    var luEl = document.getElementById('last-update');
    if (luEl) luEl.textContent = displayTime.substring(11, 19);

    updatePlaybackUI();

    if (!currentWindowStart || !currentWindowEnd || isLoadingWindow) return;

    var windowDuration = currentWindowEnd.getTime() - currentWindowStart.getTime();
    var elapsed = jsDate.getTime() - currentWindowStart.getTime();
    var progress = elapsed / windowDuration;

    if (progress > 0.7 || progress < -0.1) {
        console.log('[HISTORY] Window boundary reached, progress:', (progress * 100).toFixed(0) + '%');
        loadHistoryWindow(jsDate, { silent: true });
    }
});

// Timeline scrub: detect large time jumps
var debouncedWindowJump = debounce(function(julianDate) {
    if (timeMode !== 'history' || isLoadingWindow) return;

    var jsDate = Cesium.JulianDate.toDate(julianDate);

    if (!currentWindowStart || !currentWindowEnd) {
        loadHistoryWindow(jsDate);
        return;
    }

    if (jsDate < currentWindowStart || jsDate > currentWindowEnd) {
        console.log('[HISTORY] Timeline jump detected, loading new window');
        loadHistoryWindow(jsDate);
    }
}, 500);

viewer.timeline.addEventListener('settime', function() {
    if (timeMode === 'history') {
        debouncedWindowJump(viewer.clock.currentTime);
    }
});

// Camera move: reload history data for new viewport
var debouncedViewportReload = debounce(function() {
    if (timeMode !== 'history' || isLoadingWindow || !currentWindowCenter) return;
    if (viewer.clock.shouldAnimate) return;
    console.log('[HISTORY] Viewport changed, reloading for new bbox');
    loadHistoryWindow(currentWindowCenter, { silent: true });
}, 800);

viewer.camera.moveEnd.addEventListener(function() {
    if (timeMode === 'history') {
        debouncedViewportReload();
    }
});

// Mode toggle button listeners
var tcbBtnLive = document.getElementById('tcb-btn-live');
if (tcbBtnLive) tcbBtnLive.addEventListener('click', function() { setTimeMode('live'); });
var tcbBtnHistory = document.getElementById('tcb-btn-history');
if (tcbBtnHistory) tcbBtnHistory.addEventListener('click', function() { setTimeMode('history'); });

// Initialize: Start live clock sync
liveClockIntervalId = setInterval(function() {
    if (timeMode === 'live') {
        viewer.clock.currentTime = Cesium.JulianDate.now();
    }
}, 1000);

// ── fetchData ──
async function fetchData() {
    document.getElementById('loading').style.display = 'flex';
    try {
        var restrictedAreas = await Cesium.GeoJsonDataSource.load('/api/v1/restricted-areas', {
            stroke: Cesium.Color.RED,
            fill: Cesium.Color.RED.withAlpha(0.3),
            strokeWidth: 3
        });
        await viewer.dataSources.add(restrictedAreas);

        var eventsResponse = await fetch('/api/v1/events');
        var eventsJson = await eventsResponse.json();
        var features = eventsJson.features || [];

        var eventsSrc = await Cesium.GeoJsonDataSource.load(eventsJson, {
            markerSymbol: 'cross',
            markerColor: Cesium.Color.fromCssColorString('#38bdf8'),
            markerSize: 40
        });
        await viewer.dataSources.add(eventsSrc);

        // Live Feed - AIS Anomaly Alert Polling
        var seenAlertIds = new Set();

        function alertIcon(type) {
            if (type === 'speeding') return { icon: 'fa-gauge-high', color: '#ef4444', label: 'SPEEDING' };
            if (type === 'signal_lost') return { icon: 'fa-satellite-dish', color: '#f97316', label: 'SIGNAL LOST' };
            if (type === 'dest_change') return { icon: 'fa-right-left', color: '#a78bfa', label: 'DEST CHANGE' };
            return { icon: 'fa-triangle-exclamation', color: '#facc15', label: 'ALERT' };
        }

        function _rebuildFeedTicker(container) {
            var items = window._feedAlerts || [];
            if (items.length === 0) return;

            var cardsHtml = items.map(function(item) {
                var alert = item.alert;
                return '\
                <div class="feed-card" style="border-left: 3px solid ' + item.borderColor + '; cursor: pointer;"\
                     data-lat="' + (alert.lat || '') + '" data-lng="' + (alert.lng || '') + '" data-mmsi="' + (alert.mmsi || '') + '">\
                    <div class="feed-meta" style="display:flex;justify-content:space-between;align-items:center;">\
                        <span style="color:' + item.color + ';font-weight:700;font-size:0.7rem;letter-spacing:0.08em;">\
                            <i class="fa-solid ' + item.icon + '" style="margin-right:5px;"></i>' + item.label + '\
                        </span>\
                        <span style="color:var(--text-dim);font-size:0.7rem;"><i class="fa-solid fa-clock" style="margin-right:3px;"></i>' + item.timeStr + '</span>\
                    </div>\
                    <h3 class="feed-title" style="margin:6px 0 4px;font-size:0.85rem;">' + (alert.name || 'UNKNOWN VESSEL') + '</h3>\
                    <div style="color:var(--text-dim);font-size:0.75rem;line-height:1.5;">\
                        ' + (alert.message || '') + '\
                        ' + (alert.country ? '<span style="margin-left:6px;opacity:0.7;">\ud83c\udff4 ' + alert.country + '</span>' : '') + '\
                    </div>\
                </div>';
            }).join('');

            if (items.length <= 3) {
                container.innerHTML = cardsHtml;
            } else {
                var dur = Math.max(20, items.length * 4);
                container.innerHTML = '<div class="feed-ticker-wrap" style="--feed-ticker-duration: ' + dur + 's;">' + cardsHtml + cardsHtml + '</div>';
            }

            container.querySelectorAll('.feed-card[data-lat]').forEach(function(card) {
                var lat = parseFloat(card.dataset.lat);
                var lng = parseFloat(card.dataset.lng);
                var mmsi = card.dataset.mmsi;
                if (!lat || !lng) return;
                card.addEventListener('click', function() {
                    smoothFlyTo({
                        destination: Cesium.Cartesian3.fromDegrees(lng, lat, 5000.0),
                        complete: function() {
                            setTimeout(function() {
                                for (var type in shipDataSources) {
                                    var ds = shipDataSources[type];
                                    var entity = ds.entities.getById(mmsi) || ds.entities.getById(String(mmsi)) || ds.entities.getById(Number(mmsi));
                                    if (entity) { viewer.selectedEntity = entity; showShipInfo(entity); break; }
                                }
                            }, 500);
                        }
                    });
                });
            });
        }

        async function fetchAndRenderAlerts() {
            try {
                var resp = await fetch('/api/v1/alerts?limit=50');
                if (!resp.ok) return;
                var alerts = await resp.json();
                if (!alerts || alerts.length === 0) return;

                var feedContainer = document.getElementById('eventFeed');

                var placeholder = feedContainer.querySelector('div[style]:not(.feed-ticker-wrap)');
                if (placeholder) placeholder.remove();

                var newCount = 0;
                for (var i = 0; i < alerts.length; i++) {
                    var alert = alerts[i];
                    if (seenAlertIds.has(alert.id)) continue;
                    seenAlertIds.add(alert.id);
                    newCount++;

                    var iconInfo = alertIcon(alert.type);
                    var timeStr = new Date(alert.ts).toISOString().substring(11, 19) + 'Z';
                    var severity = alert.severity || 'medium';
                    var borderColor = severity === 'high' ? '#ef4444' : severity === 'medium' ? '#f97316' : '#a78bfa';

                    if (!window._feedAlerts) window._feedAlerts = [];
                    window._feedAlerts.unshift({ alert: alert, icon: iconInfo.icon, color: iconInfo.color, label: iconInfo.label, timeStr: timeStr, borderColor: borderColor });
                }

                if (window._feedAlerts && window._feedAlerts.length > 50) {
                    window._feedAlerts = window._feedAlerts.slice(0, 50);
                }

                if (newCount > 0 && window._feedAlerts && window._feedAlerts.length > 0) {
                    _rebuildFeedTicker(feedContainer);
                }
            } catch (e) {
                console.warn('Alert fetch failed:', e);
            }
        }

        fetchAndRenderAlerts();
        setInterval(fetchAndRenderAlerts, 30000);

        // Collision Analysis Panel (init polling)
        fetchCollisionRisks();
        setInterval(fetchCollisionRisks, 10000);

        // Restore websocket for real-time data
        initWebSocket();

    } catch (error) {
        console.error("Error fetching map data:", error);
        document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> SYSTEM ERROR';
    } finally {
        if (document.getElementById('loading').innerHTML.includes('\uCD08\uAE30\uD654')) {
            document.getElementById('loading').style.display = 'none';
        }
    }
}

fetchData();

// ── Sentinel-2 Right-click Imagery Search ──
document.body.insertAdjacentHTML('beforeend', '\
    <div id="sentinelMenu" style="\
        display:none; position:fixed; z-index:9999;\
        background:rgba(10,14,27,0.96); border:1px solid rgba(99,102,241,0.4);\
        border-radius:8px; padding:6px 0; min-width:210px;\
        backdrop-filter:blur(12px); box-shadow:0 8px 32px rgba(0,0,0,0.6);\
        font-family:\'JetBrains Mono\',monospace;">\
        <div id="sentinelMenuBtn" style="\
            padding:10px 16px; cursor:pointer; color:#a5b4fc; font-size:0.78rem;\
            display:flex; align-items:center; gap:8px;"\
            onmouseover="this.style.background=\'rgba(99,102,241,0.15)\'"\
            onmouseout="this.style.background=\'transparent\'">\
            <i class="fa-solid fa-satellite-dish"></i>&nbsp;\uc704\uc131 \uc601\uc0c1 \uac80\uc0c9 (Sentinel-2)\
        </div>\
        <div style="padding:4px 16px 8px; color:rgba(165,180,252,0.45); font-size:0.68rem;">\
            <span id="sentinelMenuCoords">--</span>\
        </div>\
    </div>\
    <div id="sentinelCard" class="drag-panel">\
        <div id="sentinelCardHeader" class="drag-panel-header">\
            <span class="title">\
                <i class="fa-solid fa-satellite-dish"></i>&nbsp; SENTINEL-2 IMAGERY\
            </span>\
            <button class="close-btn" onclick="document.getElementById(\'sentinelCard\').classList.remove(\'visible\')">&#x2715;</button>\
        </div>\
        <div id="sentinelCardBody" class="drag-panel-body"></div>\
    </div>\
');

var _sentinelLat = null, _sentinelLng = null;

viewer.cesiumWidget.canvas.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var cart = viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(e.offsetX, e.offsetY),
        viewer.scene.globe.ellipsoid
    );
    if (!cart) return;
    var carto = Cesium.Cartographic.fromCartesian(cart);
    _sentinelLat = +(Cesium.Math.toDegrees(carto.latitude).toFixed(4));
    _sentinelLng = +(Cesium.Math.toDegrees(carto.longitude).toFixed(4));
    var menu = document.getElementById('sentinelMenu');
    document.getElementById('sentinelMenuCoords').textContent = _sentinelLat + '\u00b0, ' + _sentinelLng + '\u00b0';
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
});

document.addEventListener('click', function() {
    document.getElementById('sentinelMenu').style.display = 'none';
});

document.getElementById('sentinelMenuBtn').addEventListener('click', async function(e) {
    e.stopPropagation();
    document.getElementById('sentinelMenu').style.display = 'none';
    var card = document.getElementById('sentinelCard');
    var body = document.getElementById('sentinelCardBody');

    card.style.top = Math.max(100, (window.innerHeight - 400) / 2) + 'px';
    card.style.left = Math.max(20, (window.innerWidth - 260) / 2) + 'px';
    card.style.right = 'auto';

    card.classList.add('visible');
    body.innerHTML = '<div style="text-align:center;color:#6b7280;font-family:\'JetBrains Mono\',monospace;font-size:0.75rem;padding:30px 0;"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;Searching Sentinel-2...</div>';

    try {
        var res = await fetch('/api/v1/sentinel?lat=' + _sentinelLat + '&lng=' + _sentinelLng);
        var data = await res.json();

        if (!data.found) {
            body.innerHTML = '<div style="text-align:center;color:#ef4444;font-size:0.75rem;padding:30px;">' + (data.message || data.error || 'No result') + '</div>';
            return;
        }

        var dt = data.datetime ? new Date(data.datetime).toLocaleDateString('ko-KR') : '-';
        var cc = data.cloud_cover !== null ? data.cloud_cover + '%' : '-';
        var ccColor = parseFloat(data.cloud_cover) < 15 ? '#10b981' : parseFloat(data.cloud_cover) < 30 ? '#eab308' : '#ef4444';
        var href = data.fullres_url ? 'href="' + data.fullres_url + '" target="_blank"' : '';

        body.innerHTML =
            (data.thumbnail_url ? '<a ' + href + '><img src="' + data.thumbnail_url + '" style="width:100%;border-radius:8px;border:1px solid var(--panel-border);display:block;margin-bottom:14px;"></a>' : '') +
            '<table>' +
            '<tr><th>\ucd2c\uc601\uc77c</th><td>' + dt + '</td></tr>' +
            '<tr><th>\uad6c\ub984\ub7c9</th><td style="color:' + ccColor + ';">' + cc + '</td></tr>' +
            '<tr><th>\ud50c\ub7ab\ud3fc</th><td>' + (data.platform || 'Sentinel-2') + '</td></tr>' +
            '<tr><th>\uc88c\ud45c</th><td>' + _sentinelLat + '\u00b0, ' + _sentinelLng + '\u00b0</td></tr>' +
            '</table>' +
            (href ? '<a ' + href + ' style="display:block;margin-top:16px;text-align:center;color:var(--accent);font-family:\'Inter\',sans-serif;font-size:0.8rem;text-decoration:none;border:1px solid var(--panel-border);border-radius:6px;padding:10px;background:rgba(20,184,166,0.06);transition:background 0.2s;" onmouseover="this.style.background=\'rgba(20,184,166,0.12)\'" onmouseout="this.style.background=\'rgba(20,184,166,0.06)\'"><i class="fa-solid fa-expand"></i> \uc804\uccb4 \ud654\uc9c8\ub85c \ubdf0\uc5b4 \uc5f4\uae30</a>' : '');
    } catch (err) {
        body.innerHTML = '<div style="text-align:center;color:#ef4444;font-size:0.75rem;padding:20px;">Error: ' + err.message + '</div>';
    }
});

// ── Draggable Panels ──
function makeDraggable(panel, handle) {
    var isDragging = false, startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        var rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        handle.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        panel.style.left = (startLeft + dx) + 'px';
        panel.style.top = (startTop + dy) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function() {
        if (!isDragging) return;
        isDragging = false;
        handle.style.cursor = 'grab';
    });
}

makeDraggable(
    document.getElementById('sentinelCard'),
    document.getElementById('sentinelCardHeader')
);

makeDraggable(
    document.getElementById('shipInfoPanel'),
    document.getElementById('shipInfoHeader')
);

// Close button
document.getElementById('shipInfoClose').addEventListener('click', function() {
    document.getElementById('shipInfoPanel').classList.remove('visible');
    clearProximity();
});

// Show custom ship info panel when entity is clicked
function showShipInfo(entityOrMmsi) {
    var panel = document.getElementById('shipInfoPanel');
    var title = document.getElementById('shipInfoTitle');
    var body = document.getElementById('shipInfoBody');

    // Entity 객체 또는 mmsi 문자열 둘 다 지원 (히스토리 모드 호환)
    var s;
    if (typeof entityOrMmsi === 'object' && entityOrMmsi !== null) {
        // Entity 객체 (히스토리 모드)
        var entityId = entityOrMmsi.id !== undefined ? entityOrMmsi.id : entityOrMmsi;
        s = shipDataMap[entityId];
        if (!s) {
            // 히스토리 모드 Entity — 기존 description 로직
            var name = entityOrMmsi.name || 'UNKNOWN';
            title.textContent = name;
            var descHtml = '';
            if (entityOrMmsi.description) {
                if (entityOrMmsi.description.getValue) {
                    descHtml = entityOrMmsi.description.getValue(viewer.clock.currentTime);
                } else {
                    descHtml = entityOrMmsi.description;
                }
            }
            body.innerHTML = descHtml || '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
            panel.classList.add('visible');
            return;
        }
    } else {
        s = shipDataMap[entityOrMmsi];
    }

    if (!s) {
        body.innerHTML = '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
        panel.classList.add('visible');
        return;
    }

    title.textContent = s.name || 'UNKNOWN';

    var rows = '\
        <tr><th>Name</th><td>' + (s.name || 'UNKNOWN') + '</td></tr>\
        <tr><th>MMSI</th><td>' + s.mmsi + '</td></tr>\
        <tr><th>Type</th><td>' + (s.type || 'unknown') + '</td></tr>\
        <tr><th>Country</th><td>' + (s.country || 'UNKNOWN') + '</td></tr>\
        <tr><th>SOG</th><td>' + (s.sog || 0) + ' kts</td></tr>\
        <tr><th>COG</th><td>' + (s.cog || 0) + '\u00b0</td></tr>\
        <tr><th>Heading</th><td>' + (s.heading || 0) + '\u00b0</td></tr>';
    if (s.length) rows += '<tr><th>Length</th><td>' + s.length + ' m</td></tr>';
    if (s.beam) rows += '<tr><th>Beam</th><td>' + s.beam + ' m</td></tr>';
    if (s.draught) rows += '<tr><th>Draught</th><td>' + s.draught + ' m</td></tr>';
    if (s.destination && s.destination !== 'UNKNOWN') rows += '<tr><th>Destination</th><td>' + s.destination + '</td></tr>';
    if (s.eta) rows += '<tr><th>ETA</th><td>' + s.eta + '</td></tr>';
    if (s.callsign) rows += '<tr><th>Callsign</th><td>' + s.callsign + '</td></tr>';
    if (s.imo) rows += '<tr><th>IMO</th><td>' + s.imo + '</td></tr>';

    body.innerHTML = '<table class="cesium-infoBox-defaultTable"><tbody>' + rows + '</tbody></table>';
    panel.classList.add('visible');
}
window.showShipInfo = showShipInfo;

// ── Entity click handler (ScreenSpaceEventHandler) ──
var handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction(function(click) {
    var picked = viewer.scene.pick(click.position);

    if (Cesium.defined(picked)) {
        // Case 1: Entity (위성, 히스토리 모드 선박)
        if (picked.id) {
            var entityId = picked.id.id !== undefined ? picked.id.id : picked.id;

            // Satellite click
            if (_satRecCache[entityId]) {
                _toggleSatFootprint(entityId);
                if (_activeFootprintSatId === entityId) {
                    var pos = _getSatRealTimePosition(entityId);
                    if (pos) {
                        var horizonAngle = Math.acos(6371 / (6371 + pos.altKm));
                        var footprintRadiusKm = 6371 * horizonAngle;
                        var viewAlt = Math.max(footprintRadiusKm * 4 * 1000, 8000000);
                        smoothFlyTo({
                            destination: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, viewAlt)
                        });
                    }
                }
                return;
            }

            // 히스토리 모드 Entity 선박
            showShipInfo(picked.id);
            if (shipDataMap[entityId]) {
                selectedProximityMmsi = entityId;
                collisionTargetMmsi = null;
                proximityMissCount = 0;
                updateProximity();
            } else {
                clearProximity();
            }
            return;
        }

        // Case 2: Primitive billboard (라이브 모드 선박)
        if (picked.primitive && picked.primitive._mmsi) {
            var mmsi = picked.primitive._mmsi;
            showShipInfo(mmsi);
            selectedProximityMmsi = mmsi;
            collisionTargetMmsi = null;
            proximityMissCount = 0;
            updateProximity();
            return;
        }
    }

    // 빈 공간 클릭 — 패널 닫기
    document.getElementById('shipInfoPanel').classList.remove('visible');
    clearProximity();
    if (_activeFootprintSatId) {
        var old = satDataSource.entities.getById('footprint-' + _activeFootprintSatId);
        if (old) satDataSource.entities.remove(old);
        _activeFootprintSatId = null;
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
