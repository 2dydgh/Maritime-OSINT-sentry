// ── OVERWATCH 4D — Sparkline & Mini Bar Chart Renderer ──

var BottomBar = (function() {
    // Circular buffers for sparkline data
    var buffers = {
        satellites: { data: [], max: 60 },
        wind: { data: [], max: 60 },
        wave: { data: [], max: 60 }
    };

    // Vessel type counts for mini bar chart
    var vesselCounts = {};
    // Risk level counts for mini bar chart
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
        var container = document.getElementById('vesselTypeBars');
        if (!container) return;

        var types = ['cargo', 'tanker', 'other'];
        var labels = { cargo: 'Cargo', tanker: 'Tanker', other: 'Other' };
        var total = 0;
        types.forEach(function(t) { total += (counts[t] || 0); });
        // Include all non-cargo, non-tanker as 'other'
        var otherCount = (counts.passenger || 0) + (counts.fishing || 0) +
            (counts.military || 0) + (counts.tug || 0) + (counts.other || 0) + (counts.yacht || 0);
        var displayCounts = {
            cargo: counts.cargo || 0,
            tanker: counts.tanker || 0,
            other: otherCount
        };
        total = displayCounts.cargo + displayCounts.tanker + displayCounts.other;
        if (total === 0) return;

        var html = '';
        types.forEach(function(t) {
            var pct = Math.round((displayCounts[t] / total) * 100);
            html += '<div style="display:flex;align-items:center;gap:3px;">' +
                '<span style="font-size:0.45rem;color:var(--text-dim);width:28px;">' + labels[t] + '</span>' +
                '<div style="flex:1;height:4px;background:rgba(255,255,255,0.05);border-radius:2px;overflow:hidden;">' +
                '<div style="width:' + pct + '%;height:100%;background:var(--secondary);border-radius:2px;opacity:' + (t === 'cargo' ? '1' : t === 'tanker' ? '0.6' : '0.35') + ';"></div>' +
                '</div></div>';
        });
        container.innerHTML = html;
    }

    function updateRiskLevels(danger, warning, caution) {
        riskCounts = { danger: danger, warning: warning, caution: caution };
        var container = document.getElementById('riskLevelBars');
        if (!container) return;

        var max = Math.max(danger, warning, caution, 1);
        container.innerHTML =
            '<div class="mini-bar mini-bar-danger" style="height:' + Math.max((danger / max) * 100, 5) + '%;"></div>' +
            '<div class="mini-bar mini-bar-warning" style="height:' + Math.max((warning / max) * 100, 5) + '%;"></div>' +
            '<div class="mini-bar mini-bar-caution" style="height:' + Math.max((caution / max) * 100, 5) + '%;"></div>';
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
