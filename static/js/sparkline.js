// ── OVERWATCH 4D — Sparkline & Mini Bar Chart Renderer ──

var BottomBar = (function() {
    // Circular buffers for sparkline data
    var buffers = {
        satellites: { data: [], max: 60 },
        wind: { data: [], max: 60 },
        wave: { data: [], max: 60 }
    };

    // Vessel type counts
    var vesselCounts = {};
    // Risk level counts
    var riskCounts = { danger: 0, warning: 0, caution: 0 };

    // Risk total history (circular buffer, 60 entries ≈ 10 min at 10s interval)
    var riskHistory = [];
    var RISK_HISTORY_MAX = 60;

    function pushData(key, value) {
        var buf = buffers[key];
        if (!buf) return;
        buf.data.push(value);
        if (buf.data.length > buf.max) buf.data.shift();
        renderSparkline(key);
    }

    function renderSparkline(key) {
        var svg = document.getElementById('spark' + key.charAt(0).toUpperCase() + key.slice(1));
        if (!svg) return;
        var data = buffers[key].data;
        if (data.length < 2) return;

        var w = 60, h = 24;
        var min = Math.min.apply(null, data);
        var max = Math.max.apply(null, data);
        var range = max - min || 1;

        var points = data.map(function(v, i) {
            var x = (i / (data.length - 1)) * w;
            var y = h - ((v - min) / range) * (h - 4) - 2;
            return x.toFixed(1) + ',' + y.toFixed(1);
        });

        var pathD = 'M' + points.join(' L');
        var fillD = pathD + ' L' + w + ',' + h + ' L0,' + h + 'Z';

        svg.innerHTML =
            '<defs><linearGradient id="sg-' + key + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="var(--secondary)" stop-opacity="0.3"/>' +
            '<stop offset="100%" stop-color="var(--secondary)" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            '<path d="' + fillD + '" fill="url(#sg-' + key + ')"/>' +
            '<path d="' + pathD + '" fill="none" stroke="var(--secondary)" stroke-width="1.2" opacity="0.6"/>';
    }

    function updateVesselTypes(counts) {
        vesselCounts = counts;
        var container = document.getElementById('vesselTreemap');
        if (!container) return;

        var defaultColors = {
            cargo: '#3b82f6', tanker: '#f97316', passenger: '#a855f7',
            fishing: '#10b981', military: '#ef4444', tug: '#06b6d4', other: '#6b7280'
        };
        var types = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];

        var items = [];
        var total = 0;
        types.forEach(function(t) {
            var v = counts[t] || 0;
            if (t === 'other') v += (counts.yacht || 0);
            total += v;
            if (v > 0) {
                var c = (typeof SHIP_COLORS !== 'undefined' && SHIP_COLORS[t]) || defaultColors[t];
                items.push({ type: t, count: v, color: c });
            }
        });
        if (total === 0) { container.innerHTML = ''; return; }

        // Sort descending by count for treemap layout
        items.sort(function(a, b) { return b.count - a.count; });

        var html = '';
        items.forEach(function(item) {
            var flex = (item.count / total * 10).toFixed(2);
            var label = item.count >= 5 ? item.count : '';
            html += '<div class="treemap-cell" style="flex:' + flex + ';background:' + item.color + ';">' + label + '</div>';
        });
        container.innerHTML = html;
    }

    function updateRiskLevels(danger, warning, caution) {
        riskCounts = { danger: danger, warning: warning, caution: caution };
        var total = danger + warning + caution;

        // Push to history buffer
        riskHistory.push(total);
        if (riskHistory.length > RISK_HISTORY_MAX) riskHistory.shift();

        // Update value display
        var valEl = document.getElementById('bottomRisk');
        if (valEl) {
            var unit = valEl.querySelector('.stat-card-unit');
            var unitText = unit ? unit.outerHTML : '';
            valEl.innerHTML = total + unitText;
        }

        // Render area sparkline
        var svg = document.getElementById('riskSparkline');
        if (!svg || riskHistory.length < 2) return;

        var data = riskHistory;
        var w = 80, h = 30;
        var max = Math.max.apply(null, data);
        if (max === 0) max = 1;

        var points = data.map(function(v, i) {
            var x = (i / (data.length - 1)) * w;
            var y = h - (v / max) * (h - 4) - 2;
            return x.toFixed(1) + ',' + y.toFixed(1);
        });

        var pathD = 'M' + points.join(' L');
        var fillD = pathD + ' L' + w + ',' + h + ' L0,' + h + 'Z';

        // Trend detection: compare last 10 vs previous 10
        var recent = data.slice(-10);
        var prior = data.slice(-20, -10);
        var recentAvg = recent.reduce(function(s, v) { return s + v; }, 0) / recent.length;
        var priorAvg = prior.length > 0 ? prior.reduce(function(s, v) { return s + v; }, 0) / prior.length : recentAvg;
        var increasing = recentAvg > priorAvg;
        var strokeColor = increasing ? '#f43f5e' : '#10b981';
        var fillColor = increasing ? '#f43f5e' : '#10b981';

        svg.innerHTML =
            '<defs><linearGradient id="rg-risk" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + fillColor + '" stop-opacity="0.3"/>' +
            '<stop offset="100%" stop-color="' + fillColor + '" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            '<path d="' + fillD + '" fill="url(#rg-risk)"/>' +
            '<path d="' + pathD + '" fill="none" stroke="' + strokeColor + '" stroke-width="1.5"/>';
    }

    function updateValue(id, value) {
        var el = document.getElementById(id);
        if (el) {
            var unit = el.querySelector('.stat-card-unit');
            var unitText = unit ? unit.outerHTML : '';
            el.innerHTML = value + unitText;
        }
    }

    // FLAG — country distribution Top 5
    var FLAG_BAR_COLORS = ['#406FD8', '#5b8ce8', '#7ba3ff', '#9bb8ff', '#b8cdff'];

    function updateFlagDistribution(vessels) {
        var container = document.getElementById('flagBars');
        var countEl = document.getElementById('bottomFlagCount');
        if (!container) return;

        var countryMap = {};
        var uniqueCountries = 0;
        vessels.forEach(function(v) {
            var c = v.country || v.flag || '';
            if (!c) return;
            if (!countryMap[c]) { countryMap[c] = 0; uniqueCountries++; }
            countryMap[c]++;
        });

        if (countEl) countEl.textContent = uniqueCountries;

        var sorted = Object.keys(countryMap).map(function(k) {
            return { code: k, count: countryMap[k] };
        }).sort(function(a, b) { return b.count - a.count; }).slice(0, 5);

        if (sorted.length === 0) { container.innerHTML = ''; return; }

        var maxCount = sorted[0].count;
        var html = '';
        sorted.forEach(function(item, i) {
            var pct = (item.count / maxCount * 100).toFixed(0);
            var color = FLAG_BAR_COLORS[i] || FLAG_BAR_COLORS[4];
            html += '<div class="flag-row">' +
                '<span class="flag-code">' + item.code + '</span>' +
                '<div class="flag-bar-bg"><div class="flag-bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
                '<span class="flag-count">' + item.count + '</span>' +
                '</div>';
        });
        container.innerHTML = html;
    }

    // DENSITY — 5x5 heatmap grid
    function updateDensityGrid(vessels, viewBounds) {
        var container = document.getElementById('densityGrid');
        if (!container) return;

        var ROWS = 5, COLS = 5;
        var grid = [];
        for (var i = 0; i < ROWS * COLS; i++) grid[i] = 0;

        if (!viewBounds || !viewBounds.west) {
            container.innerHTML = '';
            return;
        }

        var west = viewBounds.west, east = viewBounds.east;
        var south = viewBounds.south, north = viewBounds.north;
        var lonRange = east - west;
        var latRange = north - south;
        if (lonRange <= 0 || latRange <= 0) return;

        vessels.forEach(function(v) {
            if (v.lng < west || v.lng > east || v.lat < south || v.lat > north) return;
            var col = Math.min(Math.floor((v.lng - west) / lonRange * COLS), COLS - 1);
            var row = Math.min(Math.floor((north - v.lat) / latRange * ROWS), ROWS - 1);
            grid[row * COLS + col]++;
        });

        var maxDensity = Math.max.apply(null, grid);
        if (maxDensity === 0) maxDensity = 1;

        var html = '';
        for (var i = 0; i < ROWS * COLS; i++) {
            var ratio = grid[i] / maxDensity;
            var color, opacity;
            if (ratio > 0.7) {
                color = '244,63,94';
                opacity = 0.3 + ratio * 0.6;
            } else if (ratio > 0.4) {
                color = '249,115,22';
                opacity = 0.2 + ratio * 0.5;
            } else {
                color = '64,111,216';
                opacity = ratio * 0.5;
            }
            html += '<div class="density-cell" style="background:rgba(' + color + ',' + opacity.toFixed(2) + ');"></div>';
        }
        container.innerHTML = html;
    }

    return {
        pushData: pushData,
        updateVesselTypes: updateVesselTypes,
        updateRiskLevels: updateRiskLevels,
        updateValue: updateValue,
        updateFlagDistribution: updateFlagDistribution,
        updateDensityGrid: updateDensityGrid
    };
})();

window.BottomBar = BottomBar;
