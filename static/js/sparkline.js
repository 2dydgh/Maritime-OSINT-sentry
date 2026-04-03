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

    return {
        pushData: pushData,
        updateVesselTypes: updateVesselTypes,
        updateRiskLevels: updateRiskLevels,
        updateValue: updateValue
    };
})();

window.BottomBar = BottomBar;
