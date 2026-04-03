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
        var container = document.getElementById('riskLevelBars');
        if (!container) return;

        var max = Math.max(danger, warning, caution, 1);
        var dP = Math.max((danger / max) * 100, 5);
        var wP = Math.max((warning / max) * 100, 5);
        var cP = Math.max((caution / max) * 100, 5);
        var ovl = 'position:absolute;bottom:1px;left:0;right:0;text-align:center;font-family:"JetBrains Mono",monospace;font-size:0.38rem;line-height:1;text-shadow:0 0 3px rgba(0,0,0,0.8);';
        container.innerHTML =
            '<div class="risk-bar-wrap"><div class="mini-bar mini-bar-danger" style="height:' + dP + '%;"></div><span style="' + ovl + 'color:#fca5a5;">' + danger + '</span></div>' +
            '<div class="risk-bar-wrap"><div class="mini-bar mini-bar-warning" style="height:' + wP + '%;"></div><span style="' + ovl + 'color:#fca5a5;">' + warning + '</span></div>' +
            '<div class="risk-bar-wrap"><div class="mini-bar mini-bar-caution" style="height:' + cP + '%;"></div><span style="' + ovl + 'color:#fca5a5;">' + caution + '</span></div>';
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
