// ── Maritime OSINT Sentry — UI Controls ──

// ── Header KST Clock ──
function updateHeaderClock() {
    var el = document.getElementById('headerUtcClock');
    if (!el) return;
    var now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    var h = String(now.getHours()).padStart(2, '0');
    var m = String(now.getMinutes()).padStart(2, '0');
    var s = String(now.getSeconds()).padStart(2, '0');
    el.textContent = h + ':' + m + ':' + s + ' KST';
}
setInterval(updateHeaderClock, 1000);
updateHeaderClock();

// ── WebSocket Status LED ──
function setWsStatus(status) {
    var led = document.getElementById('headerWsLed');
    if (!led) return;
    led.className = 'ws-led ' + status;
    var titles = { connected: 'WebSocket 연결됨', disconnected: '연결 끊김', connecting: '연결 중...' };
    led.title = titles[status] || '';
}
window.setWsStatus = setWsStatus;

// ── Number Count-Up Animation ──
function animateCount(el, newValue) {
    if (!el) return;
    var oldText = el.textContent;
    var newText = String(newValue);
    if (oldText === newText) return;
    el.textContent = newText;
    el.classList.remove('count-up');
    void el.offsetWidth; // force reflow
    el.classList.add('count-up');
    // Auto-sync HUD + chip when total-ships updates
    if (el.id === 'total-ships') {
        var h = document.getElementById('hudShips');
        if (h) h.textContent = newText;
        var c = document.getElementById('chipShipCount');
        if (c) c.textContent = newText;
    }
    if (el.id === 'total-aircraft') {
        var hAc = document.getElementById('hudAircraft');
        if (hAc) hAc.textContent = newText;
        var cAc = document.getElementById('chipAircraftCount');
        if (cAc) cAc.textContent = newText;
    }
}
window.animateCount = animateCount;

// ── Panel Collapse/Expand ──
function switchRailPanel(name) {
    // Legacy: delegate to LayoutManager
    if (typeof LayoutManager !== 'undefined') {
        var btn = document.querySelector('.rail-icon[data-panel="' + name + '"]');
        var action = btn ? btn.dataset.action : 'right-panel';
        LayoutManager.handleIconClick(name, action);
    }
}
window.switchRailPanel = switchRailPanel;

function toggleLeftSidebar() {}
window.toggleLeftSidebar = toggleLeftSidebar;

// Icon rail click delegation now handled by layout-manager.js
document.addEventListener('DOMContentLoaded', function() {

    // Layer chip toggle (on/off) + dropdown
    var chips = document.getElementById('layerChips');
    if (chips) {
        chips.addEventListener('click', function(e) {
            // Expand button → open dropdown
            var expandBtn = e.target.closest('.chip-expand');
            if (expandBtn) {
                e.stopPropagation();
                var ddId = expandBtn.dataset.dropdown;
                var dd = document.getElementById(ddId);
                if (!dd) return;
                // Close all other dropdowns
                document.querySelectorAll('.layer-dropdown.open').forEach(function(d) {
                    if (d.id !== ddId) d.classList.remove('open');
                });
                dd.classList.toggle('open');
                // Position dropdown below its parent chip
                if (dd.classList.contains('open')) {
                    var chip = expandBtn.closest('.layer-chip');
                    var container = dd.offsetParent || document.body;
                    if (chip && container) {
                        var chipRect = chip.getBoundingClientRect();
                        var containerRect = container.getBoundingClientRect();
                        dd.style.right = (containerRect.right - chipRect.right) + 'px';
                        dd.style.top = (chipRect.bottom - containerRect.top + 4) + 'px';
                    }
                }
                return;
            }
            // Chip body → toggle layer
            var chip = e.target.closest('.layer-chip');
            if (!chip) return;
            chip.classList.toggle('active');
            var layer = chip.dataset.layer;
            if (layer === 'ships') {
                var checked = chip.classList.contains('active');
                document.querySelectorAll('[id^="filter-"]').forEach(function(cb) {
                    if (cb.type === 'checkbox' && !cb.id.startsWith('filter-ac-')) {
                        cb.checked = checked; cb.dispatchEvent(new Event('change'));
                    }
                });
            } else if (layer === 'aircraft') {
                var acChecked = chip.classList.contains('active');
                AIRCRAFT_TYPES.forEach(function(t) {
                    var cb = document.getElementById('filter-ac-' + t);
                    if (cb) { cb.checked = acChecked; cb.dispatchEvent(new Event('change')); }
                });
            } else if (layer === 'satellites') {
                var satCb = document.getElementById('layer-sats');
                if (satCb) { satCb.checked = chip.classList.contains('active'); satCb.dispatchEvent(new Event('change')); }
            } else if (layer === 'weather') {
                var wxOn = chip.classList.contains('active');
                // 강수 레이더
                if (typeof cloudLayer !== 'undefined' && cloudLayer) {
                    cloudLayer.show = wxOn;
                    if (wxOn && typeof viewer !== 'undefined') viewer.imageryLayers.raiseToTop(cloudLayer);
                }
                var wxPrecip = document.getElementById('wx-precipitation');
                if (wxPrecip) wxPrecip.checked = wxOn;
                // 파고/풍향 오버레이
                var wxWave = document.getElementById('wx-wave-height');
                var wxWind = document.getElementById('wx-wind');
                if (!wxOn) {
                    if (wxWave) { wxWave.checked = false; }
                    if (wxWind) { wxWind.checked = false; }
                }
                if (typeof renderWeatherOverlays === 'function') renderWeatherOverlays();
            }
        });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.layer-dropdown') && !e.target.closest('.chip-expand')) {
            document.querySelectorAll('.layer-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
        }
    });
});

function _updateSlimBadge() {
    var badge = document.getElementById('slimAlertCount');
    if (!badge) return;
    var count = (window._feedAlerts || []).length;
    if (count > 0) {
        badge.style.display = '';
        badge.textContent = count > 99 ? '99+' : count;
    } else {
        badge.style.display = 'none';
    }
}
window._updateSlimBadge = _updateSlimBadge;

function toggleLeftPanel() {
    var panel = document.getElementById('feedPanel');
    panel.classList.toggle('panel-collapsed');
}
window.toggleLeftPanel = toggleLeftPanel;

function toggleCollisionDrawer() {}
window.toggleCollisionDrawer = toggleCollisionDrawer;

function _syncShipPanelHeight() {}
window._syncShipPanelHeight = _syncShipPanelHeight;

function toggleRightPanel() {
    // Right sidebar removed — collision analysis now in left rail panel
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
            if (shipBillboards[type]) shipBillboards[type].removeAll();
            if (shipLabels[type]) shipLabels[type].removeAll();
        });
        shipBillboardMap = {};
        shipLabelMap = {};
        if (shipCogLines) { shipCogLines.removeAll(); shipCogLineMap = {}; }
        newEntities.forEach(function(item) { item.ds.entities.add(item.def); });

        currentWindowCenter = centerDate;
        currentWindowStart = windowStart;
        currentWindowEnd = windowEnd;
        historyInterpolationLoaded = true;

        animateCount(document.getElementById('total-ships'), shipCount.toLocaleString());

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
            if (shipBillboards[type]) shipBillboards[type].removeAll();
            if (shipLabels[type]) shipLabels[type].removeAll();
        });
        shipBillboardMap = {};
        shipLabelMap = {};
        if (shipCogLines) { shipCogLines.removeAll(); shipCogLineMap = {}; }

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
            if (shipBillboards[type]) shipBillboards[type].removeAll();
            if (shipLabels[type]) shipLabels[type].removeAll();
        });
        shipBillboardMap = {};
        shipLabelMap = {};
        if (shipCogLines) { shipCogLines.removeAll(); shipCogLineMap = {}; }

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
    var kst = new Date(jsDate.getTime() + 9 * 60 * 60 * 1000);
    var displayTime = kst.toISOString().replace('T', ' ').substring(0, 19) + ' KST';
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
            markerColor: Cesium.Color.fromCssColorString('#406FD8'),
            markerSize: 40
        });
        await viewer.dataSources.add(eventsSrc);

        // Live Feed - AIS Anomaly Alert Polling
        var seenAlertIds = new Set();

        function alertIcon(type) {
            if (type === 'speeding') return { icon: 'fa-gauge-high', color: '#f59e0b', label: 'SPEEDING' };
            if (type === 'signal_lost') return { icon: 'fa-satellite-dish', color: '#f97316', label: 'SIGNAL LOST' };
            if (type === 'dest_change') return { icon: 'fa-right-left', color: '#406FD8', label: 'DEST CHANGE' };
            return { icon: 'fa-triangle-exclamation', color: '#facc15', label: 'ALERT' };
        }

        function _rebuildFeedTicker(container) {
            var items = window._feedAlerts || [];
            if (items.length === 0) return;

            var cardsHtml = items.map(function(item) {
                var alert = item.alert;
                return '\
                <div class="feed-card" style="border-left-color: ' + item.borderColor + ';"\
                     data-lat="' + (alert.lat || '') + '" data-lng="' + (alert.lng || '') + '" data-mmsi="' + (alert.mmsi || '') + '">\
                    <div class="feed-meta">\
                        <span class="feed-alert-type" style="color:' + item.color + ';">\
                            <i class="fa-solid ' + item.icon + '" style="margin-right:4px;"></i>' + item.label + '\
                        </span>\
                        <span class="feed-time">' + item.timeStr + '</span>\
                    </div>\
                    <h3 class="feed-title">' + (alert.name || 'UNKNOWN VESSEL') + '</h3>\
                    <div class="feed-body">\
                        ' + (alert.message || '') + '\
                        ' + (alert.country ? '<span class="feed-country">' + alert.country + '</span>' : '') + '\
                    </div>\
                    ' + (alert.mmsi ? '<div class="feed-mmsi">MMSI ' + alert.mmsi + '</div>' : '') + '\
                </div>';
            }).join('');

            if (items.length <= 3) {
                container.innerHTML = cardsHtml;
            } else {
                var dur = Math.max(20, items.length * 4);
                // 카드 복제로 무한 흐름 + 호버 시 스크롤 모드
                container.innerHTML = '<div class="feed-ticker-wrap" style="--feed-ticker-duration: ' + dur + 's;">' + cardsHtml + cardsHtml + '</div>';
                container.onmouseenter = function() {
                    var wrap = container.querySelector('.feed-ticker-wrap');
                    if (!wrap) return;
                    // 1. 현재 애니메이션 위치에서 스크롤 오프셋 계산
                    var computed = getComputedStyle(wrap);
                    var matrix = computed.transform; // "matrix(1,0,0,1,0,-Y)"
                    var currentY = 0;
                    if (matrix && matrix !== 'none') {
                        var parts = matrix.match(/matrix.*\((.+)\)/);
                        if (parts) currentY = Math.abs(parseFloat(parts[1].split(',')[5]));
                    }
                    // 2. 복제 제거 → 단일 콘텐츠로 전환
                    wrap.innerHTML = cardsHtml;
                    // 3. 스크롤 모드 전환
                    container.classList.add('scrolling');
                    // 4. 캡처한 위치로 스크롤 설정
                    container.scrollTop = currentY;
                    _bindFeedCardClicks(container);
                };
                container.onmouseleave = function() {
                    container.classList.remove('scrolling');
                    container.scrollTop = 0;
                    // 복제 복원 + 애니메이션 재시작
                    var wrap = container.querySelector('.feed-ticker-wrap');
                    if (wrap) wrap.innerHTML = cardsHtml + cardsHtml;
                    _bindFeedCardClicks(container);
                };
            }

            _bindFeedCardClicks(container);
        }

        // 이벤트 위임: DOM 교체에 영향받지 않도록 컨테이너에 한 번만 등록
        var _feedDelegated = false;
        function _bindFeedCardClicks(el) {
            if (_feedDelegated) return;
            _feedDelegated = true;
            el.addEventListener('click', function(e) {
                var card = e.target.closest('.feed-card[data-lat]');
                if (!card) return;
                var lat = parseFloat(card.dataset.lat);
                var lng = parseFloat(card.dataset.lng);
                var mmsi = card.dataset.mmsi;
                if (!lat || !lng) return;
                smoothFlyTo({
                    destination: Cesium.Cartesian3.fromDegrees(lng, lat, 5000.0),
                    complete: function() {
                        setTimeout(function() {
                            if (shipDataMap[mmsi] || shipDataMap[String(mmsi)]) {
                                showShipInfo(mmsi);
                                highlightShip(mmsi);
                                selectedProximityMmsi = mmsi;
                                updateProximity();
                            }
                        }, 500);
                    }
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
                    var borderColor = iconInfo.color;

                    if (!window._feedAlerts) window._feedAlerts = [];
                    window._feedAlerts.unshift({ alert: alert, icon: iconInfo.icon, color: iconInfo.color, label: iconInfo.label, timeStr: timeStr, borderColor: borderColor });
                }

                if (window._feedAlerts && window._feedAlerts.length > 50) {
                    window._feedAlerts = window._feedAlerts.slice(0, 50);
                }

                if (newCount > 0 && window._feedAlerts && window._feedAlerts.length > 0) {
                    // 호버 중이면 리빌드 건너뛰기 (위치 점프 방지)
                    if (!feedContainer.classList.contains('scrolling')) {
                        _rebuildFeedTicker(feedContainer);
                    }
                    // Update slim rail badge
                    if (typeof _updateSlimBadge === 'function') _updateSlimBadge();
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
        background:rgba(10,14,27,0.96); border:1px solid rgba(0,40,120,0.4);\
        border-radius:8px; padding:6px 0; min-width:210px;\
        backdrop-filter:blur(12px); box-shadow:0 8px 32px rgba(0,0,0,0.6);\
        font-family:\'JetBrains Mono\',monospace;">\
        <div id="sentinelMenuBtn" style="\
            padding:10px 16px; cursor:pointer; color:#fafafa; font-size:0.78rem;\
            display:flex; align-items:center; gap:8px;"\
            onmouseover="this.style.background=\'rgba(0,40,120,0.15)\'"\
            onmouseout="this.style.background=\'transparent\'">\
            \uc704\uc131 \uc601\uc0c1 \uac80\uc0c9 (Sentinel-2)\
        </div>\
        <div style="padding:4px 16px 8px; color:rgba(64,111,216,0.45); font-size:0.68rem;">\
            <span id="sentinelMenuCoords">--</span>\
        </div>\
    </div>\
    <div id="sentinelCard" class="drag-panel">\
        <div id="sentinelCardHeader" class="drag-panel-header">\
            <span class="title">\
                SENTINEL-2 IMAGERY\
            </span>\
            <button class="close-btn" onclick="document.getElementById(\'sentinelCard\').classList.remove(\'visible\');_removeSentinelMarker();">&#x2715;</button>\
        </div>\
        <div id="sentinelCardBody" class="drag-panel-body"></div>\
    </div>\
');

var _sentinelLat = null, _sentinelLng = null;
var _sentinelMarkerEntity = null;

function _addSentinelMarker(lat, lng) {
    _removeSentinelMarker();
    _sentinelMarkerEntity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lng, lat),
        billboard: {
            image: (function() {
                var c = document.createElement('canvas');
                c.width = 32; c.height = 40;
                var ctx = c.getContext('2d');
                // Pin shape
                ctx.beginPath();
                ctx.arc(16, 14, 10, Math.PI, 0, false);
                ctx.quadraticCurveTo(26, 28, 16, 38);
                ctx.quadraticCurveTo(6, 28, 6, 14);
                ctx.fillStyle = '#406FD8';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                // Satellite icon (small circle)
                ctx.beginPath();
                ctx.arc(16, 14, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
                return c.toDataURL();
            })(),
            width: 28,
            height: 35,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            pixelOffset: new Cesium.Cartesian2(0, 0)
        },
        label: {
            text: 'Sentinel-2',
            font: '10px JetBrains Mono, monospace',
            fillColor: Cesium.Color.fromCssColorString('#406FD8'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -42),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
    });
}

function _removeSentinelMarker() {
    if (_sentinelMarkerEntity) {
        viewer.entities.remove(_sentinelMarkerEntity);
        _sentinelMarkerEntity = null;
    }
}

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

        _addSentinelMarker(_sentinelLat, _sentinelLng);

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
            (href ? '<a ' + href + ' style="display:block;margin-top:16px;text-align:center;color:var(--accent);font-family:\'Inter\',sans-serif;font-size:0.8rem;text-decoration:none;border:1px solid var(--panel-border);border-radius:6px;padding:10px;background:rgba(59,130,246,0.06);transition:background 0.2s;" onmouseover="this.style.background=\'rgba(59,130,246,0.12)\'" onmouseout="this.style.background=\'rgba(59,130,246,0.06)\'"><i class="fa-solid fa-expand"></i> \uc804\uccb4 \ud654\uc9c8\ub85c \ubdf0\uc5b4 \uc5f4\uae30</a>' : '');
    } catch (err) {
        body.innerHTML = '<div style="text-align:center;color:#ef4444;font-size:0.75rem;padding:20px;">Error: ' + err.message + '</div>';
    }
});

// ── Draggable Panels ──
function makeDraggable(panel, handle) {
    if (!panel || !handle) return;
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

// shipInfoPanel drag removed — ship info now lives in right panel

// Back button — clear ship highlights when navigating back
var shipInfoBackBtn = document.getElementById('shipInfoBack');
if (shipInfoBackBtn) {
    shipInfoBackBtn.addEventListener('click', function() {
        clearProximity();
        clearShipHighlight();
    });
}

// Show custom ship info panel when entity is clicked
function showShipInfo(entityOrMmsi) {
    var title = document.getElementById('shipInfoTitle');
    var body = document.getElementById('shipInfoBody');
    if (!title || !body) return;

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
            if (typeof LayoutManager !== 'undefined') {
                LayoutManager.showShipInfo();
            }
            return;
        }
    } else {
        s = shipDataMap[entityOrMmsi];
    }

    if (!s) {
        body.innerHTML = '<p style="color:var(--text-dim);font-size:0.8rem;">No details available</p>';
        if (typeof LayoutManager !== 'undefined') {
            LayoutManager.showShipInfo();
        }
        return;
    }

    title.textContent = s.name || 'UNKNOWN';

    var rows = '\
        <tr><th>Name</th><td>' + (s.name || 'UNKNOWN') + '</td></tr>\
        <tr><th>MMSI</th><td>' + s.mmsi + '</td></tr>\
        <tr><th>Type</th><td>' + (s.type || 'unknown') + '</td></tr>\
        <tr><th>Country</th><td>' + (s.country || 'UNKNOWN') + '</td></tr>\
        <tr><th>SOG</th><td>' + (s.sog && Math.abs(parseFloat(s.sog) - 102.3) < 0.2 ? '신호없음 (SOG N/A)' : (s.sog || 0) + ' kts') + '</td></tr>\
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

    // Render model summary cards from registry
    if (window.ModelRegistry) {
        ModelRegistry.renderShipModelCards(s.mmsi, body);
    }

    if (typeof LayoutManager !== 'undefined') {
        LayoutManager.showShipInfo();
    }
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
            highlightShip(entityId);
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

        // Check if clicked billboard is an aircraft
        if (picked && picked.primitive && picked.primitive._isAircraft) {
            showAircraftInfo(picked.primitive._icao24);
            return;
        }

        // Case 2: Primitive billboard (라이브 모드 선박)
        if (picked.primitive && picked.primitive._mmsi) {
            var mmsi = picked.primitive._mmsi;
            showShipInfo(mmsi);
            highlightShip(mmsi);
            selectedProximityMmsi = mmsi;
            collisionTargetMmsi = null;
            proximityMissCount = 0;
            updateProximity();
            return;
        }
    }

    // 빈 공간 클릭 — 패널 닫기
    if (typeof LayoutManager !== 'undefined') {
        LayoutManager.closeRightPanel();
    }
    clearProximity();
    clearShipHighlight();
    if (_activeFootprintSatId) {
        var old = satDataSource.entities.getById('footprint-' + _activeFootprintSatId);
        if (old) satDataSource.entities.remove(old);
        _activeFootprintSatId = null;
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ── Map Place Search (Nominatim Geocoding + Local Cache) ──
var _searchMarkerBillboards = null;
var _searchMarkerLabels = null;
var _searchLeafletMarker = null;

(function() {
    var input = document.getElementById('mapSearchInput');
    var results = document.getElementById('mapSearchResults');
    var searchIcon = document.getElementById('mapSearchIcon');
    if (!input || !results) return;

    var debounceTimer = null;
    var abortCtrl = null;

    // ── Local harbour/place cache for instant results ──
    var LOCAL_PLACES = [
        { name: '인천항', nameEn: 'Incheon Port', wiki: '인천항', lat: 37.4500, lon: 126.6322, type: 'harbour', region: '인천광역시, 대한민국' },
        { name: '부산항', nameEn: 'Busan Port', wiki: '부산항', lat: 35.0950, lon: 129.0450, type: 'harbour', region: '부산광역시, 대한민국' },
        { name: '평택당진항', nameEn: 'Pyeongtaek-Dangjin Port', wiki: '평택·당진항', lat: 36.9600, lon: 126.8200, type: 'harbour', region: '경기도, 대한민국' },
        { name: '울산항', nameEn: 'Ulsan Port', wiki: '울산항', lat: 35.4900, lon: 129.3800, type: 'harbour', region: '울산광역시, 대한민국' },
        { name: '광양항', nameEn: 'Gwangyang Port', wiki: '광양항', lat: 34.9100, lon: 127.6800, type: 'harbour', region: '전라남도, 대한민국' },
        { name: '목포항', nameEn: 'Mokpo Port', wiki: '목포항', lat: 34.7800, lon: 126.3800, type: 'harbour', region: '전라남도, 대한민국' },
        { name: '여수항', nameEn: 'Yeosu Port', wiki: '여수항', lat: 34.7400, lon: 127.7400, type: 'harbour', region: '전라남도, 대한민국' },
        { name: '포항항', nameEn: 'Pohang Port', wiki: '포항항', lat: 36.0300, lon: 129.3800, type: 'harbour', region: '경상북도, 대한민국' },
        { name: '군산항', nameEn: 'Gunsan Port', wiki: '군산항', lat: 35.9800, lon: 126.6100, type: 'harbour', region: '전라북도, 대한민국' },
        { name: '대산항', nameEn: 'Daesan Port', wiki: '대산항', lat: 37.0100, lon: 126.3500, type: 'harbour', region: '충청남도, 대한민국' },
        { name: '제주항', nameEn: 'Jeju Port', wiki: '제주항', lat: 33.5200, lon: 126.5300, type: 'harbour', region: '제주도, 대한민국' },
        { name: '동해항', nameEn: 'Donghae Port', wiki: '동해항', lat: 37.4900, lon: 129.1200, type: 'harbour', region: '강원도, 대한민국' },
        { name: '속초항', nameEn: 'Sokcho Port', wiki: '속초항', lat: 38.2100, lon: 128.5900, type: 'harbour', region: '강원도, 대한민국' },
        { name: '싱가포르항', nameEn: 'Port of Singapore', wiki: 'Port of Singapore', lat: 1.2646, lon: 103.8200, type: 'harbour', region: 'Singapore' },
        { name: '상하이항', nameEn: 'Port of Shanghai', wiki: 'Port of Shanghai', lat: 31.3600, lon: 121.6200, type: 'harbour', region: 'Shanghai, China' },
        { name: '로테르담항', nameEn: 'Port of Rotterdam', wiki: 'Port of Rotterdam', lat: 51.9036, lon: 4.4620, type: 'harbour', region: 'Netherlands' },
        { name: '함부르크항', nameEn: 'Port of Hamburg', wiki: 'Port of Hamburg', lat: 53.5400, lon: 9.9700, type: 'harbour', region: 'Germany' },
        { name: '요코하마항', nameEn: 'Port of Yokohama', wiki: 'Port of Yokohama', lat: 35.4500, lon: 139.6500, type: 'harbour', region: 'Japan' },
        { name: '수에즈 운하', nameEn: 'Suez Canal', wiki: 'Suez Canal', lat: 30.4550, lon: 32.3500, type: 'strait', region: 'Egypt' },
        { name: '말라카 해협', nameEn: 'Strait of Malacca', wiki: 'Strait of Malacca', lat: 2.5000, lon: 101.5000, type: 'strait', region: 'Southeast Asia' },
        { name: '호르무즈 해협', nameEn: 'Strait of Hormuz', wiki: 'Strait of Hormuz', lat: 26.5900, lon: 56.2500, type: 'strait', region: 'Middle East' },
        { name: '파나마 운하', nameEn: 'Panama Canal', wiki: 'Panama Canal', lat: 9.0800, lon: -79.6800, type: 'strait', region: 'Panama' },
        { name: '아덴만', nameEn: 'Gulf of Aden', wiki: 'Gulf of Aden', lat: 12.0000, lon: 48.0000, type: 'sea', region: 'East Africa' },
        { name: '기니만', nameEn: 'Gulf of Guinea', wiki: 'Gulf of Guinea', lat: 3.0000, lon: 3.0000, type: 'sea', region: 'West Africa' },
        { name: '대한해협', nameEn: 'Korea Strait', wiki: '대한해협', lat: 34.0000, lon: 129.0000, type: 'strait', region: '대한민국 / 일본' },
        { name: '남중국해', nameEn: 'South China Sea', wiki: 'South China Sea', lat: 12.0000, lon: 113.0000, type: 'sea', region: 'Southeast Asia' },
        { name: '북극항로', nameEn: 'Northern Sea Route', wiki: 'Northern Sea Route', lat: 75.0000, lon: 100.0000, type: 'sea', region: 'Arctic' },
        { name: '동중국해', nameEn: 'East China Sea', wiki: 'East China Sea', lat: 28.0000, lon: 125.0000, type: 'sea', region: 'East Asia' },
    ];

    function searchLocalCache(query) {
        var q = query.toLowerCase();
        return LOCAL_PLACES.filter(function(p) {
            return p.name.toLowerCase().indexOf(q) !== -1 ||
                   p.nameEn.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 4);
    }

    function typeIcon(type) {
        if (type === 'harbour' || type === 'port') return 'fa-anchor';
        if (type === 'city' || type === 'town' || type === 'village') return 'fa-city';
        if (type === 'island' || type === 'archipelago') return 'fa-mountain-sun';
        if (type === 'strait' || type === 'bay' || type === 'sea' || type === 'ocean' || type === 'water') return 'fa-water';
        if (type === 'country' || type === 'state') return 'fa-flag';
        return 'fa-location-dot';
    }

    function closeResults() {
        results.classList.remove('open');
        results.innerHTML = '';
    }

    function setSearching(on) {
        if (searchIcon) {
            searchIcon.classList.toggle('fa-magnifying-glass', !on);
            searchIcon.classList.toggle('fa-circle-notch', on);
            searchIcon.classList.toggle('searching', on);
        }
    }

    function renderResultItem(name, detail, lat, lon, bb, type, isLocal) {
        var icon = isLocal ? 'fa-anchor' : typeIcon(type || '');
        return '<div class="search-result-item" data-lat="' + lat + '" data-lon="' + lon + '" data-bb="' + (bb || '') + '" data-name="' + name.replace(/"/g, '&quot;') + '" data-type="' + (type || '') + '" data-detail="' + (detail || '').replace(/"/g, '&quot;') + '">'
            + '<i class="fa-solid ' + icon + ' sri-icon"></i>'
            + '<span class="sri-name">' + name + '</span>'
            + '<span class="sri-detail">' + detail + '</span>'
            + '</div>';
    }

    function showResults(localItems, nominatimItems) {
        var html = '';
        localItems.forEach(function(p) {
            html += renderResultItem(p.name, p.nameEn + ', ' + p.region, p.lat, p.lon, '', p.type, true);
        });
        nominatimItems.forEach(function(item) {
            var parts = (item.display_name || '').split(',');
            var name = parts[0].trim();
            var detail = parts.slice(1, 3).join(',').trim();
            html += renderResultItem(name, detail, item.lat, item.lon, (item.boundingbox || []).join(','), item.type, false);
        });
        if (!html) {
            html = '<div class="search-no-result">검색 결과 없음</div>';
        }
        results.innerHTML = html;
        results.classList.add('open');
    }

    function doSearch(query) {
        if (abortCtrl) abortCtrl.abort();
        abortCtrl = new AbortController();

        // Show local results immediately
        var localItems = searchLocalCache(query);
        if (localItems.length > 0) {
            showResults(localItems, []);
        }

        setSearching(true);
        var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=ko,en&q=' + encodeURIComponent(query);

        fetch(url, { signal: abortCtrl.signal })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                setSearching(false);
                var localNames = localItems.map(function(p) { return p.name; });
                var filtered = (data || []).filter(function(item) {
                    var n = (item.display_name || '').split(',')[0].trim();
                    return localNames.indexOf(n) === -1;
                });
                showResults(localItems, filtered);
            })
            .catch(function(e) {
                setSearching(false);
                if (e.name !== 'AbortError') console.warn('Search failed:', e);
            });
    }

    // ── Search marker management ──
    function clearSearchMarker() {
        if (_searchMarkerBillboards) {
            _searchMarkerBillboards.removeAll();
        }
        if (_searchMarkerLabels) {
            _searchMarkerLabels.removeAll();
        }
        if (_searchLeafletMarker) {
            _searchLeafletMarker.remove();
            _searchLeafletMarker = null;
        }
    }

    function addSearchMarker(lat, lon, name) {
        clearSearchMarker();

        if (currentMapMode === '2d' && leafletMap) {
            _searchLeafletMarker = L.marker([lat, lon], {
                icon: L.divIcon({
                    className: 'search-marker-icon',
                    html: '<div class="search-marker-dot"></div><div class="search-marker-label">' + name + '</div>',
                    iconSize: [0, 0],
                    iconAnchor: [0, 0]
                })
            }).addTo(leafletMap);
            return;
        }

        // Cesium 3D
        if (!_searchMarkerBillboards) {
            _searchMarkerBillboards = viewer.scene.primitives.add(new Cesium.BillboardCollection());
            _searchMarkerLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());
        }
        var pos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
        _searchMarkerBillboards.add({
            position: pos,
            image: (function() {
                var c = document.createElement('canvas');
                c.width = 32; c.height = 40;
                var ctx = c.getContext('2d');
                ctx.beginPath();
                ctx.arc(16, 14, 10, Math.PI, 0, false);
                ctx.quadraticCurveTo(26, 28, 16, 38);
                ctx.quadraticCurveTo(6, 28, 6, 14);
                ctx.fillStyle = '#406FD8';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(16, 14, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.fill();
                return c.toDataURL();
            })(),
            width: 28,
            height: 35,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
        _searchMarkerLabels.add({
            position: pos,
            text: name,
            font: '11px Pretendard Variable, Inter, sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#406FD8'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -42),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
    }

    // ── Place info modal ──
    var modal = document.getElementById('placeInfoModal');
    var closeBtn = document.getElementById('placeInfoClose');

    function openPlaceInfo(name, lat, lon, type, detail) {
        if (!modal) return;

        document.getElementById('placeInfoName').textContent = name;
        document.getElementById('placeInfoSub').textContent = (detail ? detail + ' · ' : '') + (type || '');
        document.getElementById('placeInfoCoords').textContent = Math.abs(lat).toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
        document.getElementById('placeInfoType').textContent = type || '-';

        var localMatch = LOCAL_PLACES.find(function(p) { return p.name === name; });
        document.getElementById('placeInfoRegion').textContent = localMatch ? localMatch.region : (detail || '-');

        var photoEl = document.getElementById('placeInfoPhoto');
        photoEl.innerHTML = '<i class="fa-solid fa-image place-info-photo-fallback"></i>';
        document.getElementById('placeInfoDesc').textContent = '';
        var wikiLink = document.getElementById('placeInfoWikiLink');
        wikiLink.classList.add('hidden');
        wikiLink.href = '#';

        modal.classList.remove('closing');
        modal.classList.add('open');
        void modal.offsetWidth;

        var wikiQuery = localMatch ? (localMatch.wiki || localMatch.nameEn || name) : name;
        fetchWikipedia(wikiQuery, name, photoEl, wikiLink);
    }

    function fetchWikiSummary(lang, title) {
        var url = 'https://' + lang + '.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title);
        return fetch(url).then(function(r) { return r.ok ? r.json() : Promise.reject('not-found'); });
    }

    function searchWikiTitle(lang, query) {
        var url = 'https://' + lang + '.wikipedia.org/w/api.php?action=query&list=search&srsearch='
            + encodeURIComponent(query) + '&srlimit=1&format=json&origin=*';
        return fetch(url).then(function(r) { return r.json(); }).then(function(data) {
            if (data.query && data.query.search && data.query.search.length > 0) {
                return data.query.search[0].title;
            }
            return Promise.reject('no-results');
        });
    }

    function fetchWikipedia(query, fallbackName, photoEl, wikiLink) {
        function applyData(data) {
            if (data.thumbnail && data.thumbnail.source) {
                photoEl.innerHTML = '<img src="' + data.thumbnail.source + '" alt="">'
                    + '<i class="fa-solid fa-image place-info-photo-fallback"></i>';
            }
            if (data.extract) {
                document.getElementById('placeInfoDesc').textContent = data.extract;
            }
            if (data.content_urls && data.content_urls.desktop) {
                wikiLink.href = data.content_urls.desktop.page;
                wikiLink.classList.remove('hidden');
            }
        }

        // Try direct title lookup (ko → en), then search API as fallback
        fetchWikiSummary('ko', query)
            .catch(function() { return fetchWikiSummary('en', query); })
            .then(applyData)
            .catch(function() {
                // Direct lookup failed — try Wikipedia search API
                var searchQuery = fallbackName || query;
                return searchWikiTitle('ko', searchQuery)
                    .then(function(title) { return fetchWikiSummary('ko', title); })
                    .catch(function() {
                        return searchWikiTitle('en', searchQuery)
                            .then(function(title) { return fetchWikiSummary('en', title); });
                    })
                    .then(applyData);
            })
            .catch(function() {
                document.getElementById('placeInfoDesc').textContent = '정보를 불러올 수 없습니다.';
            });
    }

    function closePlaceInfo() {
        if (!modal) return;
        modal.classList.add('closing');
        setTimeout(function() {
            modal.classList.remove('open', 'closing');
        }, 150);
        clearSearchMarker();
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closePlaceInfo);
    }

    // ── flyToPlace (updated with marker + modal) ──
    function flyToPlace(lat, lon, name, boundingbox, type, detail) {
        closeResults();
        input.value = name;

        addSearchMarker(lat, lon, name);
        openPlaceInfo(name, lat, lon, type, detail);

        if (currentMapMode === '2d' && leafletMap) {
            if (boundingbox) {
                leafletMap.flyToBounds([
                    [parseFloat(boundingbox[0]), parseFloat(boundingbox[2])],
                    [parseFloat(boundingbox[1]), parseFloat(boundingbox[3])]
                ], { duration: 0.8, maxZoom: 14 });
            } else {
                leafletMap.flyTo([lat, lon], 12, { duration: 0.8 });
            }
            return;
        }

        // 3D Cesium — 마커 위치가 화면 중앙에 오도록 카메라 배치
        var alt = 80000;
        if (boundingbox) {
            var dLat = Math.abs(parseFloat(boundingbox[1]) - parseFloat(boundingbox[0]));
            var dLon = Math.abs(parseFloat(boundingbox[3]) - parseFloat(boundingbox[2]));
            var span = Math.max(dLat, dLon);
            if (span < 0.05) alt = 8000;
            else if (span < 0.2) alt = 30000;
            else if (span < 1) alt = 80000;
            else if (span < 5) alt = 300000;
            else alt = 1000000;
        }
        // pitch -90 = 수직으로 내려다봄 → 마커가 정확히 화면 중앙
        smoothFlyTo({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            orientation: {
                heading: 0,
                pitch: Cesium.Math.toRadians(-90),
                roll: 0
            }
        });
    }

    // ── Event listeners ──
    input.addEventListener('input', function() {
        clearTimeout(debounceTimer);
        var q = input.value.trim();
        if (q.length < 2) { closeResults(); return; }
        debounceTimer = setTimeout(function() { doSearch(q); }, 200);
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { closeResults(); closePlaceInfo(); input.blur(); }
        if (e.key === 'Enter') {
            var first = results.querySelector('.search-result-item');
            if (first) first.click();
        }
    });

    results.addEventListener('click', function(e) {
        var item = e.target.closest('.search-result-item');
        if (!item) return;
        var lat = parseFloat(item.dataset.lat);
        var lon = parseFloat(item.dataset.lon);
        var bb = item.dataset.bb ? item.dataset.bb.split(',') : null;
        flyToPlace(lat, lon, item.dataset.name, bb, item.dataset.type, item.dataset.detail);
    });

    // 외부 클릭 시 결과 닫기
    document.addEventListener('click', function(e) {
        if (!e.target.closest('#mapSearchWrap') && !e.target.closest('.place-info-modal')) closeResults();
    });
})();
