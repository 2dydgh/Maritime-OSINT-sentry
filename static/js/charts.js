// ── Maritime OSINT Sentry — ECharts Data Visualization ──

var shipTypeBarChart = null;

var CHART_THEME = {
    bg: 'transparent',
    text: '#cbd5e1',
    textDim: '#94a3b8',
    axisLine: 'rgba(148,163,184,0.18)',
    danger: '#f43f5e',
    warning: '#f97316',
    caution: '#eab308',
    safe: '#10b981',
    accent: '#406FD8'
};

function initCharts() {
    var barEl = document.getElementById('shipTypeChart');
    if (barEl) shipTypeBarChart = echarts.init(barEl, null, { renderer: 'canvas' });
    if (shipTypeBarChart) shipTypeBarChart.setOption(buildShipTypeOption({}));

    // Resize on window resize
    var _resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(function() {
            if (shipTypeBarChart) shipTypeBarChart.resize();

        }, 300);
    });
}
window.initCharts = initCharts;

// ── Ship Type Distribution Bar (vertical columns for bottom bar) ──
function buildShipTypeOption(counts) {
    var types = ['Cargo', 'Tanker', 'Passenger', 'Fishing', 'Military', 'Tug', 'Other'];
    var keys = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];
    var colors = keys.map(function(k) { return SHIP_COLORS[k] || '#6b7280'; });
    var data = keys.map(function(k) { return counts[k] || 0; });

    var koNames = { Cargo: '화물선', Tanker: '유조선', Passenger: '여객선', Fishing: '어선', Military: '군함', Tug: '예인선', Other: '기타' };
    var total = data.reduce(function(a, b) { return a + b; }, 0);

    return {
        backgroundColor: CHART_THEME.bg,
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            confine: true,
            appendTo: document.body,
            backgroundColor: 'rgba(15,15,20,0.92)',
            borderColor: 'rgba(64,111,216,0.3)',
            textStyle: { color: '#e2e8f0', fontSize: 11, fontFamily: "'Pretendard Variable', sans-serif" },
            formatter: function(params) {
                var p = params[0];
                var pct = total > 0 ? Math.round(p.value / total * 100) : 0;
                var ko = koNames[p.name] || p.name;
                return '<span style="color:' + colors[p.dataIndex] + '">\u25cf</span> <b>' + ko + '</b> (' + p.name + ')<br/>' +
                    p.value + '척 <span style="color:#94a3b8">(' + pct + '%)</span>';
            }
        },
        grid: { left: 4, right: 4, top: 2, bottom: 14 },
        yAxis: {
            type: 'value',
            show: false
        },
        xAxis: {
            type: 'category',
            data: types,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
                color: CHART_THEME.textDim,
                fontSize: 7,
                interval: 0,
                fontFamily: "'Pretendard Variable', 'Inter', sans-serif"
            }
        },
        series: [{
            type: 'bar',
            barWidth: '50%',
            data: data.map(function(v, i) {
                return { value: v, itemStyle: { color: colors[i], borderRadius: [3, 3, 0, 0] } };
            }),
            label: { show: false },
            animationDuration: 600,
            animationEasing: 'cubicOut'
        }]
    };
}

// updateCollisionCharts removed — charts moved out of collision drawer
function updateCollisionCharts() {}
window.updateCollisionCharts = updateCollisionCharts;


var _lastShipTypeChartUpdate = 0;
function updateShipTypeChart(ships) {
    var now = Date.now();
    if (now - _lastShipTypeChartUpdate < 5000) return;
    _lastShipTypeChartUpdate = now;
    var chartEl = document.getElementById('shipTypeChart');
    if (!chartEl || !shipTypeBarChart) return;

    var counts = {};
    var TYPE_MAP = { military_vessel: 'military', unknown: 'other', yacht: 'other' };

    if (ships && ships.length > 0) {
        ships.forEach(function(s) {
            var raw = s.type || 'other';
            var type = TYPE_MAP[raw] || raw;
            if (SHIP_TYPES.indexOf(type) === -1) type = 'other';
            counts[type] = (counts[type] || 0) + 1;
        });
        shipTypeBarChart.setOption(buildShipTypeOption(counts));
        setTimeout(function() { shipTypeBarChart.resize(); }, 100);
    }
}
window.updateShipTypeChart = updateShipTypeChart;
