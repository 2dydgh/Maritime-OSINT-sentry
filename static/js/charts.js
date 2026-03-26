// ── Maritime OSINT Sentry — ECharts Data Visualization ──

var gaugeChart = null;
var radarChart = null;
var shipTypeBarChart = null;

var CHART_THEME = {
    bg: 'transparent',
    text: '#94a3b8',
    textDim: '#64748b',
    axisLine: 'rgba(148,163,184,0.15)',
    danger: '#f43f5e',
    warning: '#f97316',
    caution: '#eab308',
    safe: '#10b981',
    accent: '#14b8a6'
};

function initCharts() {
    var gaugeEl = document.getElementById('riskGaugeChart');
    var radarEl = document.getElementById('riskRadarChart');
    var barEl = document.getElementById('shipTypeChart');

    if (gaugeEl) gaugeChart = echarts.init(gaugeEl, null, { renderer: 'canvas' });
    if (radarEl) radarChart = echarts.init(radarEl, null, { renderer: 'canvas' });
    if (barEl) shipTypeBarChart = echarts.init(barEl, null, { renderer: 'canvas' });

    // Set initial empty state
    if (gaugeChart) gaugeChart.setOption(buildGaugeOption(0));
    if (radarChart) radarChart.setOption(buildRadarOption({}));
    if (shipTypeBarChart) shipTypeBarChart.setOption(buildShipTypeOption({}));

    // Resize on window resize
    window.addEventListener('resize', function() {
        if (gaugeChart) gaugeChart.resize();
        if (radarChart) radarChart.resize();
        if (shipTypeBarChart) shipTypeBarChart.resize();
    });
}
window.initCharts = initCharts;

// ── Risk Gauge ──
function buildGaugeOption(riskScore) {
    var color;
    if (riskScore >= 75) color = CHART_THEME.danger;
    else if (riskScore >= 50) color = CHART_THEME.warning;
    else if (riskScore >= 25) color = CHART_THEME.caution;
    else color = CHART_THEME.safe;

    return {
        backgroundColor: CHART_THEME.bg,
        series: [{
            type: 'gauge',
            startAngle: 200,
            endAngle: -20,
            min: 0,
            max: 100,
            radius: '85%',
            center: ['50%', '60%'],
            pointer: { show: false },
            progress: {
                show: true,
                width: 8,
                roundCap: true,
                itemStyle: { color: color }
            },
            axisLine: {
                lineStyle: { width: 8, color: [[1, 'rgba(148,163,184,0.1)']] }
            },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            title: {
                show: true,
                offsetCenter: [0, '75%'],
                fontSize: 8,
                color: CHART_THEME.textDim,
                fontFamily: 'JetBrains Mono, monospace'
            },
            detail: {
                valueAnimation: true,
                offsetCenter: [0, '15%'],
                fontSize: 18,
                fontWeight: 700,
                fontFamily: 'JetBrains Mono, monospace',
                color: color,
                formatter: '{value}'
            },
            data: [{ value: riskScore, name: 'RISK INDEX' }]
        }]
    };
}

// ── Risk Factor Radar ──
function buildRadarOption(factors) {
    // factors: { tcpa, dcpa, speed_diff, course_cross, distance }
    var indicators = [
        { name: 'TCPA', max: 100 },
        { name: 'DCPA', max: 100 },
        { name: 'SPD\u0394', max: 100 },
        { name: 'CRS\u2220', max: 100 },
        { name: 'DIST', max: 100 }
    ];

    var values = [
        factors.tcpa || 0,
        factors.dcpa || 0,
        factors.speed_diff || 0,
        factors.course_cross || 0,
        factors.distance || 0
    ];

    return {
        backgroundColor: CHART_THEME.bg,
        radar: {
            indicator: indicators,
            shape: 'polygon',
            radius: '58%',
            center: ['50%', '55%'],
            axisName: {
                color: CHART_THEME.textDim,
                fontSize: 8,
                fontFamily: 'JetBrains Mono, monospace'
            },
            splitArea: { areaStyle: { color: 'transparent' } },
            splitLine: { lineStyle: { color: CHART_THEME.axisLine } },
            axisLine: { lineStyle: { color: CHART_THEME.axisLine } }
        },
        series: [{
            type: 'radar',
            symbol: 'circle',
            symbolSize: 4,
            lineStyle: { width: 1.5, color: CHART_THEME.accent },
            areaStyle: { color: 'rgba(20,184,166,0.15)' },
            itemStyle: { color: CHART_THEME.accent },
            data: [{ value: values }]
        }]
    };
}

// ── Ship Type Distribution Bar ──
function buildShipTypeOption(counts) {
    var types = ['Cargo', 'Tanker', 'Passenger', 'Fishing', 'Military', 'Tug', 'Other'];
    var keys = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];
    var colors = keys.map(function(k) { return SHIP_COLORS[k] || '#6b7280'; });
    var data = keys.map(function(k) { return counts[k] || 0; });

    return {
        backgroundColor: CHART_THEME.bg,
        grid: { left: 50, right: 12, top: 8, bottom: 16 },
        xAxis: {
            type: 'value',
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { show: false },
            splitLine: { lineStyle: { color: CHART_THEME.axisLine } }
        },
        yAxis: {
            type: 'category',
            data: types,
            inverse: true,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
                color: CHART_THEME.textDim,
                fontSize: 9,
                fontFamily: 'JetBrains Mono, monospace'
            }
        },
        series: [{
            type: 'bar',
            barWidth: 10,
            data: data.map(function(v, i) {
                return { value: v, itemStyle: { color: colors[i], borderRadius: [0, 3, 3, 0] } };
            }),
            label: {
                show: true,
                position: 'right',
                fontSize: 9,
                color: CHART_THEME.text,
                fontFamily: 'JetBrains Mono, monospace'
            },
            animationDuration: 600,
            animationEasing: 'cubicOut'
        }]
    };
}

// ── Update functions called from other modules ──

function updateCollisionCharts() {
    var chartsRow = document.getElementById('chartsRow');
    if (!chartsRow) return;

    if (collisionActiveTab === 'distance') {
        _updateDistanceCharts(chartsRow);
    } else {
        _updateMlCharts(chartsRow);
    }

    setTimeout(function() {
        if (gaugeChart) gaugeChart.resize();
        if (radarChart) radarChart.resize();
    }, 100);
}

// ── 거리기반 탭: CPA 기반 위험도 ──
function _updateDistanceCharts(chartsRow) {
    var risks = (collisionData.distance && collisionData.distance.risks) || [];

    if (risks.length === 0) {
        chartsRow.style.display = 'none';
        return;
    }
    chartsRow.style.display = 'flex';

    // Gauge: severity 기반 점수 (danger=100, warning=60, 나머지=20)
    var dangerCount = 0, warnCount = 0;
    risks.forEach(function(r) {
        if (r.severity === 'danger' || r.severity === 'high') dangerCount++;
        else if (r.severity === 'warning' || r.severity === 'medium') warnCount++;
    });
    var riskScore = Math.min(100, Math.round(
        (dangerCount * 25 + warnCount * 10) / Math.max(risks.length, 1) * 10
    ));
    if (gaugeChart) gaugeChart.setOption(buildGaugeOption(riskScore));

    // Radar: 가장 위험한 쌍의 CPA 수치
    var worst = risks.reduce(function(a, b) {
        var aScore = (a.severity === 'danger' || a.severity === 'high') ? 2 : (a.severity === 'warning' || a.severity === 'medium') ? 1 : 0;
        var bScore = (b.severity === 'danger' || b.severity === 'high') ? 2 : (b.severity === 'warning' || b.severity === 'medium') ? 1 : 0;
        return bScore > aScore ? b : a;
    }, risks[0]);

    if (radarChart && worst) {
        var factors = {
            tcpa: worst.tcpa_min != null ? Math.max(0, 100 - worst.tcpa_min * 3) : 0,
            dcpa: worst.dcpa_nm != null ? Math.max(0, 100 - worst.dcpa_nm * 20) : 0,
            distance: worst.current_dist_nm != null ? Math.max(0, 100 - worst.current_dist_nm * 10) : 0,
            speed_diff: Math.min(100, Math.abs((worst.ship_a && worst.ship_a.sog || 0) - (worst.ship_b && worst.ship_b.sog || 0)) * 5),
            course_cross: Math.min(100, Math.abs((worst.ship_a && worst.ship_a.cog || 0) - (worst.ship_b && worst.ship_b.cog || 0)) / 1.8)
        };
        radarChart.setOption(buildRadarOption(factors));
    }
}

// ── AI분석 탭: XGBoost ML 위험도 ──
function _updateMlCharts(chartsRow) {
    var risks = (collisionData.ml && collisionData.ml.risks) || [];

    if (risks.length === 0) {
        chartsRow.style.display = 'none';
        return;
    }
    chartsRow.style.display = 'flex';

    // Gauge: risk_level 가중 점수
    var countByLevel = { 3: 0, 2: 0, 1: 0, 0: 0 };
    risks.forEach(function(r) {
        var lvl = r.risk_level;
        if (countByLevel[lvl] !== undefined) countByLevel[lvl]++;
    });
    var riskScore = Math.min(100, Math.round(
        (countByLevel[3] * 30 + countByLevel[2] * 15 + countByLevel[1] * 5) /
        Math.max(risks.length, 1) * 10
    ));
    if (gaugeChart) gaugeChart.setOption(buildGaugeOption(riskScore));

    // Radar: 최고 위험 쌍의 feature importance
    var worst = risks.reduce(function(a, b) {
        return (b.risk_level > a.risk_level || (b.risk_level === a.risk_level && (b.risk_score || 0) > (a.risk_score || 0))) ? b : a;
    }, risks[0]);

    if (radarChart && worst) {
        var factors = {};
        if (worst.feature_importance) {
            var fi = worst.feature_importance;
            factors.tcpa = Math.min(100, (fi.tcpa_minutes || 0) * 100);
            factors.dcpa = Math.min(100, (fi.dcpa_nm || 0) * 100);
            factors.speed_diff = Math.min(100, (fi.speed_diff || 0) * 100);
            factors.course_cross = Math.min(100, (fi.course_crossing_angle || 0) * 100);
            factors.distance = Math.min(100, (fi.current_dist_nm || 0) * 100);
        } else {
            factors.tcpa = worst.tcpa_min != null ? Math.max(0, 100 - worst.tcpa_min * 3) : 0;
            factors.dcpa = worst.dcpa_nm != null ? Math.max(0, 100 - worst.dcpa_nm * 30) : 0;
            factors.distance = worst.current_dist_nm != null ? Math.max(0, 100 - worst.current_dist_nm * 10) : 0;
            factors.speed_diff = 40 + worst.risk_level * 15;
            factors.course_cross = 30 + worst.risk_level * 20;
        }
        radarChart.setOption(buildRadarOption(factors));
    }
}
window.updateCollisionCharts = updateCollisionCharts;

function updateShipTypeChart(ships) {
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
        chartEl.style.display = 'block';
        shipTypeBarChart.setOption(buildShipTypeOption(counts));
        setTimeout(function() { shipTypeBarChart.resize(); }, 100);
    } else {
        chartEl.style.display = 'none';
    }
}
window.updateShipTypeChart = updateShipTypeChart;
